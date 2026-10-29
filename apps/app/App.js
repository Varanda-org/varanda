// The app shell: before anything else the Termos de Uso and Política de
// Privacidade gate (src/terms.js: per member, per version; nothing renders
// behind it and autosync, the outbox and a profile invite wait for it; a
// hosted linked member's acceptance is also sent to the account service),
// then the first connection, the onboarding (src/onboarding.js
// decides the step: on the web's browser node 'Entrar' with the passkey, the
// account link; natively identity and member certificate; then the own name)
// and then five tabs (A Rua, Espiadinha, Seguindo, Avisos, Diário) with the top bar (an info button
// that opens the screen's 'Como funciona' sheet), the
// 'Sem internet' note under it (only while offline), the 'Instalar o Varanda'
// note under it too (hosted web, phones and iPad; below 'Sem internet' when
// both show; its close is remembered for 30 days), the publish button and
// the sheets (Publicar, Ajustes). Sync is automatic and silent: this shell
// owns the intent (node.setAutoSync) and nothing else in the UI starts or
// stops a run; its details live in Ajustes → Sincronização. Above the tabs a
// small screen stack (src/nav.js) opens Conversa (a post and its replies),
// Curtidas (who liked or reposted a post) and Membro (a profile) as
// full-screen layers; the tabs stay mounted below.
// Back: the browser Back button (src/history.web.js; an in-app back calls
// history.back() so the history and the stack never drift), Escape on the
// web, the Android Back button (BackHandler); an open sheet closes first.
// A profile link (/@ana, /m/<key>; hosted web only, src/profileLink.js) is
// captured at load: Entrar shows the invite, a passkey ceremony from that card
// records consent, and once the tabs show the inviter is followed when that
// consent was given in this page load; after a reload (the Google return) the
// profile opens for one tap on Seguir, and a visitor already signed in only
// gets the profile opened.
// A notification click (hosted web, src/pushClient.web.js) arrives as
// /?aviso=... at load or as a worker message: held in memory only, it opens
// Avisos (a follow) or Conversa (a reply, like or repost) once the tabs show
// for the key it names; nothing is written, followed or retried.
// A splash shows while the app loads; the intro cards (src/intro.js) follow
// once per device, before the Termos.
// The age gate (hosted web only, src/age.js) holds every member, linked or
// not, at 'Confirme sua idade' until the account service answers
// 'verificado'; it fails closed while the policy or the result is unknown,
// and nothing about it is stored on the device.
// Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { BackHandler, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { NodeProvider, useNode } from './src/node'
import { hostedPage } from './src/configStore'
import { NamesProvider, useNames } from './src/names'
import { agePolicy as readAgePolicy, ageResult, ageSession, ageStart, lookupUsername, parseReturn, parseReturnInvite, parseReturnWaitlist, termsFinish, termsStart } from './src/account'
import { ageBlocking, ageGate, parseReturnAge } from './src/age'
import * as nav from './src/nav'
import { bindHistory } from './src/history'
import { STEP_TITLES, onboardingStep } from './src/onboarding'
import { captureInvite, dropInvite, loadInvite, saveInvite } from './src/profileLinkStore'
import { captureSignupInvite, loadSignupInvite } from './src/signupInviteStore'
import { INVITE_TTL_MS, NOT_FOUND_TEXT, OFFLINE_TEXT, acceptInvite, buildProfileUrl, confirmText, followedText, inviteAction, inviteCardText, resolveInvite } from './src/profileLink'
import { OutboxProvider, useOutbox, useOutboxDrain } from './src/outboxProvider'
import { LEGAL_VERSION } from './src/legal'
import { shouldSyncTerms, termsDecision, termsSyncAttempted, termsSyncStep } from './src/terms'
import { useTerms } from './src/useTerms'
import { INTRO_VERSION, introDecision } from './src/intro'
import { useIntro } from './src/useIntro'
import { Btn, ErrorText, Soft, Spinner, colors, errorText } from './src/ui'
import { Fab } from './src/ui/Fab'
import { Splash } from './src/ui/Splash'
import { OfflineNote } from './src/ui/OfflineNote'
import { InstallNote } from './src/ui/InstallNote'
import { UpdateNote } from './src/ui/UpdateNote'
import { useInstall } from './src/install'
import { watchRelease } from './src/pwa'
import { captureLaunch, listenLaunch } from './src/pushClient'
import { nextLaunch } from './src/push-state'
import { loadIcons } from './src/ui/Icon'
import { TabBar } from './src/ui/TabBar'
import { TopBar } from './src/ui/TopBar'
import { HelpButton, closeHelp, useHelpOpen } from './src/ui/Help'
import { HELP } from './src/help'
import { layout, type } from './src/ui/theme'
import Avisos from './src/screens/Avisos'
import Ajustes from './src/screens/Ajustes'
import ARua from './src/screens/ARua'
import Conexao from './src/screens/Conexao'
import Conversa from './src/screens/Conversa'
import Curtidas from './src/screens/Curtidas'
import Denunciar from './src/screens/Denunciar'
import Diario from './src/screens/Diario'
import Espiadinha from './src/screens/Espiadinha'
import Introducao from './src/screens/Introducao'
import Identidade from './src/screens/Identidade'
import Idade from './src/screens/Idade'
import Membro from './src/screens/Membro'
import Perfil from './src/screens/Perfil'
import Publicar from './src/screens/Publicar'
import Seguindo from './src/screens/Seguindo'
import Termos from './src/screens/Termos'

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
// A link confirmed in Ajustes re-arms the terms sync at most this many times
// per member in a page load (Ajustes re-reads the info often).
const TERMS_REARM_MAX = 5
// A failed age policy read is tried again after 5 s, 15 s, then every 60 s
// (and when the connection comes back); the member stays blocked meanwhile.
const agePolicyDelay = (n) => (n === 0 ? 5000 : n === 1 ? 15000 : 60000)
const AGE_REDIRECT_TEXT = 'Vamos abrir a verificação e, na volta, pedir sua passkey de novo.'

// The steps the setup branch (Identidade, Idade) renders; the others belong
// to the shell (spinner, Perfil, the tabs).
const SETUP_STEPS = new Set(['entrar', 'recuperando', 'idade', 'vinculo', 'identidade', 'certificado'])

// True when this page load is the return from the Google step of the account
// link (?conta=…). Read at import, before any screen renders; only read here:
// Identidade's LinkCard is the one that removes the query. Native has no
// location.
const LINK_RETURN = (() => {
  try {
    const search = globalThis.location?.search
    return parseReturn(search) !== null || parseReturnWaitlist(search) !== '' || parseReturnInvite(search) !== ''
  } catch { return false }
})()

// True when this page load is the return from the age verification
// (?idade=volta). Only skips the intro cards: the result is always asked of
// the account service after the unlock. The query it carries (idade and the
// provider's untrusted verificationSessionId and status) is removed here, once;
// the pathname (read by the captures below), other params and hash are kept.
const AGE_RETURN = (() => { try { return parseReturnAge(globalThis.location?.search) } catch { return false } })()
if (AGE_RETURN) {
  try {
    const loc = globalThis.location
    const hist = globalThis.history
    const params = new URLSearchParams(loc.search)
    for (const name of ['idade', 'verificationSessionId', 'status']) params.delete(name)
    const query = params.toString()
    hist.replaceState(hist.state, '', loc.pathname + (query ? '?' + query : '') + loc.hash)
  } catch {}
}

// A profile link (/@ana, /m/<key>) is read and cleaned to '/' here, once,
// before any render, takeReturnNotice or bindHistory, so neither the history
// stack nor the account flow ever sees that path; search and hash are kept
// (?conta= and #token= are read later). No pathname listener: only a page load
// carries a profile link. Null off the hosted web page.
// A signup invite (/convite/<code>) is cleaned to '/' first, keeping ?conta=
// and #token=. It is stored under its own key, so this capture and the profile
// one below never clear each other. Caddy already serves index.html for
// extensionless paths, so /convite/ needs no Caddyfile route.
captureSignupInvite()
const CAPTURED_INVITE = captureInvite()
// Tab storage refused the write (private mode, sandboxed frame): the invite
// then lives only in this page's memory, which still opens the profile now.
const INVITE_IN_MEMORY = CAPTURED_INVITE !== null && loadInvite() === null
// Lookup retries for a profile link while the account service does not
// answer (offline, 429, 5xx, timeout): 15 s, 30 s, then every 60 s, 10 times.
const INVITE_RETRIES = 10
const inviteRetryDelay = (n) => (n === 0 ? 15000 : n === 1 ? 30000 : 60000)
// Two invite records name the same profile (the @nome or the key).
const sameTarget = (a, b) => !!a && !!b && a.username === b.username && a.key === b.key
// A notification click's /?aviso=... query, read and stripped once at load
// after the profile link (search and hash otherwise kept). Null off the
// hosted web page.
const CAPTURED_LAUNCH = captureLaunch()

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
  const [updateReady, setUpdateReady] = useState(false)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  useEffect(() => {
    const stop = watchRelease((s) => setUpdateReady(s.update))
    return () => stop()
  }, [])
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
  // The Espiadinha reloads only on a publish (peekVersion); a follow change
  // (followsSignal) just drops the newly followed authors' rows, keeping its
  // pages and scroll. `version` still reloads A Rua, Diário and the info.
  const [peekVersion, setPeekVersion] = useState(0)
  const [followsSignal, setFollowsSignal] = useState(0)
  const followsChanged = useCallback(() => {
    setVersion((v) => v + 1)
    setFollowsSignal((v) => v + 1)
  }, [])
  const deletedPost = useCallback(() => {
    setVersion((v) => v + 1)
    setPeekVersion((v) => v + 1)
  }, [])
  // Avisos has something unseen: a plain dot on its tab, never a number.
  const [avisosNew, setAvisosNew] = useState(false)
  const [info, setInfo] = useState(null)
  const [infoError, setInfoError] = useState('')
  // Latched once node.info confirmed the identity and the certificate: a
  // later failed or slow read never hides the tabs again.
  const [setupDone, setSetupDone] = useState(false)
  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)
  // The pending profile invite (src/profileLink.js): the record in tab
  // storage, re-read before every step that acts on it.
  const [invite, setInvite] = useState(() => loadInvite() || (INVITE_IN_MEMORY ? CAPTURED_INVITE : null))
  const inviteRef = useRef(invite)
  inviteRef.current = invite
  // True once the invite card was on screen in this page load: only then can
  // a ceremony record consent.
  const [cardShown, setCardShown] = useState(false)
  // True once this page load recorded that consent (the 'accept' step): only
  // then is the follow automatic. An accepted record found after a reload
  // (the Google return) could have been planted in tab storage, so it opens
  // the profile for one tap on Seguir instead.
  const [acceptedHere, setAcceptedHere] = useState(false)
  const inviteBusy = useRef(false)
  const offlineShown = useRef(false)
  const [inviteTick, setInviteTick] = useState(0)
  const retryTimer = useRef(null)
  const retryCount = useRef(0)
  const wakePending = useRef(false)
  // The latest decision, so an attempt that awaited a lookup can tell whether
  // its gate is still open (a once sync, a sheet or another identity since).
  const actionRef = useRef('none')
  // Memory instead of tab storage: storage refused the capture, or later the
  // accepted record. The consent then lives only in this page: a returning
  // member who reaches the tabs without the Google reload is still followed;
  // after a reload it is gone.
  const inviteMemoryOnly = useRef(INVITE_IN_MEMORY)

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
  // A lock ends this account's session in the tab: nothing it opened or
  // quoted (the composer's reply or quote, an open Ajustes screen) reaches the
  // next account.
  useEffect(() => {
    if (!locked) return
    setSetupDone(false)
    setReachedTabs(false)
    setInfo(null)
    setComposer({ open: false, reply: null, quote: null })
    setAjustes(null)
  }, [locked])
  const mode = passkey !== null && node.hosted ? 'hosted' : (node.canConfigure ? 'native' : 'serve')
  // The age gate follows the origin, not the config source: a configuration
  // typed by hand on the hosted page (Conectar, "usar outra configuração")
  // turns node.hosted off but keeps the same passkey and account here.
  const ageHosted = passkey !== null && (node.hosted || hostedPage)

  // --- the Termos de Uso and the Política de Privacidade (src/terms.js) ---
  // The device's record says which member accepted which version; the gate
  // asks when the device has no record of the current version (before
  // Conexao and Entrar) and, once a member is known, when the record does not
  // list that member. The member is the unlocked passkey's key (browser node)
  // or node.info's identity.
  const terms = useTerms(LEGAL_VERSION)
  const intro = useIntro()
  const introState = introDecision({ status: intro.status, record: intro.record, version: INTRO_VERSION })
  const member = passkey !== null
    ? ((!locked && pkStatus && pkStatus.publicKey) || null)
    : ((info && info.publicKey) || null)
  const decision = terms.status === 'loading'
    ? 'loading'
    : termsDecision({
      record: terms.record,
      version: LEGAL_VERSION,
      member,
      claim: terms.claim,
      hosted: mode === 'hosted',
      // A failed first status read is known too: nobody (member null), so
      // the gate shows and then Identidade's error and its retry.
      identityKnown: passkey === null || pkStatus !== null || !!passkey.error,
      locked
    })
  // Past the setup a hosted member is never null (unlocked means a known
  // key). On native or varanda-serve a node reached later without an identity
  // gives null too: termsDecision lets it through (nothing flows without an
  // identity) and asks as soon as one appears that is not in the record.
  const termsOk = decision === 'accepted' || decision === 'bind'
  // The acceptance made before anyone signed in (the claim) is spent on the
  // first member known in this page load: recorded for that member, or just
  // dropped when that member had accepted already. It never reaches the next
  // identity.
  const { bind: bindTerms, markSynced: markTermsSynced, dropMember: dropTermsMember } = terms
  useEffect(() => {
    if (member !== null && terms.claim !== null && (decision === 'bind' || decision === 'accepted')) bindTerms(member)
  }, [decision, member, terms.claim, bindTerms])
  const memberRef = useRef(member)
  memberRef.current = member
  const recovering = passkey !== null && passkey.recovering === true
  const onceSync = !!(node.sync.active && node.sync.active.once) || node.sync.starting === true

  // --- the age gate (src/age.js; hosted web only) ---
  // The policy is read once the node is ready; a failed read (null) keeps
  // everyone blocked and is tried again with a backoff and when the
  // connection comes back.
  const [agePolicy, setAgePolicy] = useState(undefined)
  const [agePolicyTick, setAgePolicyTick] = useState(0)
  const agePolicyTries = useRef(0)
  const agePolicyKnown = agePolicy !== undefined && agePolicy !== null
  useEffect(() => {
    if (!ageHosted || !ready || agePolicyKnown) return
    let cancelled = false
    let timer = null
    readAgePolicy().then((p) => {
      if (cancelled) return
      setAgePolicy(p)
      if (p !== null) return
      timer = setTimeout(() => setAgePolicyTick((n) => n + 1), agePolicyDelay(agePolicyTries.current))
      agePolicyTries.current += 1
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ageHosted, ready, agePolicyKnown, agePolicyTick])
  const agePolicyOnlineRef = useRef(node.online)
  useEffect(() => {
    const was = agePolicyOnlineRef.current
    agePolicyOnlineRef.current = node.online
    if (was !== false || node.online !== true || agePolicyKnown) return
    setAgePolicyTick((n) => n + 1)
  }, [node.online, agePolicyKnown])

  // The member's result, asked of the account service (never taken from the
  // URL or from storage): once per generation and member, and again on
  // 'Conferir de novo'. Not while the recovery after an unlock or a once sync
  // runs: age.sign is a member request and would preempt that run.
  const [ageState, setAgeState] = useState(undefined)
  const [ageBusy, setAgeBusy] = useState(false)
  const [ageError, setAgeError] = useState('')
  const [ageNote, setAgeNote] = useState('')
  const [ageCheckTick, setAgeCheckTick] = useState(0)
  // Bumped by every age request and by a lock or generation change: an
  // answer that arrives under another number is dropped.
  const ageSeq = useRef(0)
  const ageRan = useRef(null)
  useEffect(() => {
    ageSeq.current += 1
    ageRan.current = null
    setAgeState(undefined)
    setAgeBusy(false)
    setAgeError('')
    setAgeNote('')
  }, [generation, locked])
  // termsOk: reading the result records the band and closes the partner's
  // session, which must not happen before the current terms are accepted.
  // Only once the service said the check is required: an unknown policy keeps
  // the member blocked (ageGate) and is retried, without calling the age routes.
  const ageReadNow = ageHosted && ready && termsOk && !locked && member !== null && !recovering && !onceSync &&
    agePolicyKnown && agePolicy.required === true
  const ageRequest = (work) => {
    const seq = ++ageSeq.current
    const gen = generationRef.current
    const who = memberRef.current
    const stale = () => seq !== ageSeq.current || gen !== generationRef.current || who !== memberRef.current
    setAgeBusy(true)
    setAgeError('')
    setAgeNote('')
    work(stale).catch((err) => {
      if (!stale()) setAgeError(errorText(err))
    }).finally(() => {
      if (!stale()) setAgeBusy(false)
    })
  }
  useEffect(() => {
    if (!ageReadNow) return
    const key = generation + '#' + member + '#' + ageCheckTick
    if (ageRan.current === key) return
    ageRan.current = key
    ageRequest(async (stale) => {
      const { nonce } = await ageStart({ member })
      if (stale()) return
      const { signature } = await node.request('age.sign', { action: 'result', nonce })
      if (stale()) return
      const { state } = await ageResult({ member, nonce, signature })
      if (!stale()) setAgeState(state)
    })
  }, [ageReadNow, generation, member, ageCheckTick])
  const checkAge = () => setAgeCheckTick((n) => n + 1)
  // A new verification session: the service answers 'verificado' when the
  // band is already recorded, otherwise the provider's page, opened as a full
  // page navigation (it comes back with ?idade=volta).
  const startAge = () => {
    if (member === null || ageBusy) return
    ageRequest(async (stale) => {
      const { nonce } = await ageStart({ member })
      if (stale()) return
      const { signature } = await node.request('age.sign', { action: 'session', nonce })
      if (stale()) return
      const r = await ageSession({ member, nonce, signature, invite: loadSignupInvite()?.code })
      if (stale()) return
      if (r.state === 'verificado') return setAgeState('verificado')
      if (typeof r.url !== 'string' || !r.url.startsWith('https://')) throw new Error('serviço indisponível')
      setAgeNote(AGE_REDIRECT_TEXT)
      globalThis.location.assign(r.url)
    })
  }
  const ageNeeded = ageGate({ hosted: ageHosted, policy: agePolicy, state: ageState })
  const ageClear = !ageBlocking(ageNeeded)

  // The gates: `confirmed` can latch setupDone for a member already linked,
  // so setupDone alone never opens the tabs, autosync, the outbox, the terms
  // sync or the profile invite; ageClear is required everywhere too. Not
  // gated by age (documented, as for the terms): the post-unlock recovery of
  // the member's own diary, which runs before the age check.
  const setupStep = locked || (!setupDone && !confirmed) || !ageClear

  // The acceptance sent to the account service (hosted, linked members): one
  // start, one signature by the node, one finish, per member and version and
  // page load. Keyed member#version: { count, state }, moved only by
  // termsSyncStep (src/terms.js says what each state and event means). A
  // fresh acceptance after a 'done' (Recomeçar, then accept again) runs
  // again; a run dropped by a lock, unlock or reset is armed again. Failures
  // are never toasts; Ajustes → privacidade tells.
  const termsSync = useRef(new Map())
  const [, setTermsTick] = useState(0)
  const stepTermsSync = (key, event) => {
    const next = termsSyncStep(termsSync.current.get(key), event)
    if (next === undefined) termsSync.current.delete(key)
    else termsSync.current.set(key, next)
  }
  const termsEntry = member !== null ? termsSync.current.get(member + '#' + LEGAL_VERSION) : undefined
  // This member's entry in the device record ({acceptedAt, synced} or null).
  const termsEntryNow = member !== null && terms.record && terms.record.version === LEGAL_VERSION &&
    Object.hasOwn(terms.record.members, member)
    ? terms.record.members[member]
    : null
  const syncTermsNow = ageClear && shouldSyncTerms({
    hosted: mode === 'hosted',
    termsOk,
    ready,
    online: node.online,
    locked,
    setupDone,
    recovering,
    onceSync,
    member,
    record: terms.record,
    version: LEGAL_VERSION,
    attempted: termsSyncAttempted(termsEntry, termsEntryNow)
  })
  useEffect(() => {
    if (!syncTermsNow || member === null) return
    const key = member + '#' + LEGAL_VERSION
    stepTermsSync(key, 'start')
    const gen = generationRef.current
    const settle = (event) => {
      stepTermsSync(key, event)
      setTermsTick((n) => n + 1)
    }
    // A lock, unlock or reset meanwhile: the run is dropped and armed again
    // (the effect re-runs on the new generation). Once the finish answered,
    // the server has the acceptance whatever the generation: it is marked
    // synced for that member all the same.
    const run = async () => {
      const { nonce } = await termsStart({ member, version: LEGAL_VERSION })
      if (gen !== generationRef.current) return settle('generation')
      const { signature } = await node.request('terms.sign', { nonce, version: LEGAL_VERSION })
      if (gen !== generationRef.current) return settle('generation')
      await termsFinish({ member, nonce, signature })
      markTermsSynced(member)
      settle('ok')
    }
    run().catch((err) => {
      if (gen !== generationRef.current) return settle('generation')
      settle(err && err.code === 'nao-vinculado' ? 'nao-vinculado' : 'fail')
    })
  }, [syncTermsNow, member, generation, node.request, markTermsSynced])
  // Back online, or a new passkey generation (an unlock after Sair or a
  // lock): a transient failure is tried again, up to 3 attempts per member
  // and version in this page load. The generation counts because a lock,
  // Sair or Recomeçar clears the key before the generation moves, so a
  // terms.sign it broke settles as a plain failure.
  const rearmTermsTransients = useCallback(() => {
    let changed = false
    for (const [key, e] of termsSync.current) {
      const next = termsSyncStep(e, 'online')
      if (next !== e) {
        termsSync.current.set(key, next)
        changed = true
      }
    }
    if (changed) setTermsTick((n) => n + 1)
  }, [])
  const termsOnlineRef = useRef(node.online)
  useEffect(() => {
    const was = termsOnlineRef.current
    termsOnlineRef.current = node.online
    if (was !== false || node.online === false) return
    rearmTermsTransients()
  }, [node.online, rearmTermsTransients])
  const termsGenRef = useRef(generation)
  useEffect(() => {
    if (termsGenRef.current === generation) return
    termsGenRef.current = generation
    rearmTermsTransients()
  }, [generation, rearmTermsTransients])
  // The link confirmed in Ajustes → Conta (Identidade's LinkCard refreshes
  // the info): a member remembered as 'so-aparelho' may be linked now, so the
  // sync is armed again; a run in flight is marked to run again if it fails.
  // No time window (the confirm's refresh may come seconds after the one that
  // opened Conta), but at most TERMS_REARM_MAX re-arms per member and page load.
  const termsRearms = useRef(new Map())
  const rearmTermsSync = useCallback((m) => {
    if (typeof m !== 'string') return
    const key = m + '#' + LEGAL_VERSION
    const e = termsSync.current.get(key)
    const next = termsSyncStep(e, 'rearm')
    if (next === e) return
    const n = termsRearms.current.get(m) || 0
    if (n >= TERMS_REARM_MAX) return
    termsRearms.current.set(m, n + 1)
    if (next === undefined) termsSync.current.delete(key)
    else termsSync.current.set(key, next)
    setTermsTick((n) => n + 1)
  }, [])
  // Stable, like takeInfo (Identidade re-reads node.info when it changes).
  const ajustesInfo = useCallback((i) => {
    takeInfo(i)
    rearmTermsSync(memberRef.current)
  }, [takeInfo, rearmTermsSync])
  // Recomeçar in Ajustes drops the member's acceptance: every sync memory of
  // that member goes too, so a new acceptance by the same key is sent.
  const dropTermsAndSync = useCallback((m) => {
    dropTermsMember(m)
    if (typeof m !== 'string') return
    for (const key of [...termsSync.current.keys()]) {
      if (key.startsWith(m + '#')) termsSync.current.delete(key)
    }
    termsRearms.current.delete(m)
    setTermsTick((n) => n + 1)
  }, [dropTermsMember])
  // What Ajustes → privacidade shows about this member's acceptance.
  let termsSyncState = null
  if (termsEntryNow !== null && mode === 'hosted') {
    if (termsEntryNow.synced) termsSyncState = 'registrado'
    else if (termsEntry && termsEntry.state === 'so-aparelho') termsSyncState = 'so-aparelho'
    else termsSyncState = 'pendente'
  }
  const termsInfo = termsEntryNow === null
    ? null
    : { version: LEGAL_VERSION, acceptedAt: termsEntryNow.acceptedAt, saved: !terms.saveFailed, syncState: termsSyncState }

  // The sync intent: continuous sync is wanted as soon as the certificate is
  // confirmed (the profile step does not gate it), never while locked or
  // while the recovery run after an unlock is on, never before the age check
  // clears. The provider does the rest.
  const { setAutoSync } = node
  useEffect(() => {
    setAutoSync(ready && !locked && setupDone && !recovering && termsOk && ageClear)
  }, [ready, locked, setupDone, recovering, termsOk, ageClear, setAutoSync])

  // Back from the Google step with a certificate already held: the tabs show
  // after the unlock, so open Ajustes → Conta once, where the account card offers
  // 'confirmar vínculo'. While the setup step shows, its embedded Identidade
  // handles the return.
  const linkReturnRef = useRef(LINK_RETURN)
  useEffect(() => {
    if (!termsOk || setupStep || !linkReturnRef.current) return
    linkReturnRef.current = false
    setAjustes('conta')
  }, [setupStep, termsOk])

  // The own profile (one profile.read through the profiles cache): the
  // onboarding's name step, the Publicar avatar and the own rows.
  const ownKey = info ? info.publicKey : null
  const { resolve } = names
  useEffect(() => { if (setupDone && ownKey) resolve(ownKey) }, [setupDone, ownKey, resolve])

  // The onboarding step (src/onboarding.js). A failed lookup is not evidence
  // that the profile is absent: profileKnown is true only once the cache
  // answered (or the node has no profile.read).
  const ownProfile = ownKey ? names.profileOf(ownKey) : undefined
  const onboarding = onboardingStep({
    mode,
    locked,
    recovering,
    hasIdentity: info !== null && info.publicKey !== null,
    memberCert: info !== null && info.memberCert === true,
    profileKnown: ownProfile !== undefined || names.unsupported === true,
    hasName: !!(ownProfile && ownProfile.name),
    skippedName,
    // No own key yet (the diary creation after the passkey failed): Identidade
    // keeps the screen, with its error and retry, since the age check needs the
    // key. Nothing is released: setupStep still holds while the age gate does,
    // and the service refuses the link without the check.
    ageVerified: ageClear || member === null
  })
  // The latched setupDone rule above decides between the setup branch and the
  // shell's steps; the step machine only names the step within each.
  let { step, index, total } = onboarding
  if (setupStep && mode !== 'hosted' && !ageClear && member !== null && !locked && !recovering) {
    // A hand-typed configuration on the hosted page: the native steps do not
    // know the age check, so it takes the screen here.
    step = 'idade'
    index = 1
  } else if (setupStep && !SETUP_STEPS.has(step)) {
    step = mode === 'hosted' ? (ageClear || member === null ? 'vinculo' : 'idade') : 'certificado'
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
    enabled: ready && !locked && setupDone && termsOk && ageClear && !(passkey && passkey.recovering) &&
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
    setPeekVersion((v) => v + 1)
    showToast(lastSent.kind === 'reply' ? 'resposta publicada' : 'publicado')
  }, [lastSent])

  // The follows changed (here or on another device, node.followsVersion): A
  // Rua and the follow count reload.
  const followsVersion = node.followsVersion
  const followsVersionRef = useRef(followsVersion)
  useEffect(() => {
    if (followsVersion === followsVersionRef.current) return
    followsVersionRef.current = followsVersion
    followsChanged()
  }, [followsVersion, followsChanged])
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
        if (closeHelp()) {
          // Help closes first and the screen (and any report draft) stays; the
          // popstate already stepped the history back, so push the entries again.
          const h = globalThis.history
          const d = nav.depth(stackRef.current)
          if (h && typeof h.pushState === 'function') {
            for (let k = d - n + 1; k <= d; k++) {
              try { h.pushState({ varanda: k }, '') } catch {}
            }
          }
          return
        }
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
  const openEngagers = useCallback(({ ref, kind } = {}) => {
    pushScreen({ screen: 'curtidas', key: ref, params: { kind: kind === 'reposts' ? 'reposts' : 'likes' } })
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
  // A tap on @nome in a post. The row author's own verified name opens with
  // no request; any other name goes through the account lookup (current
  // holder only). No seed: Membro re-verifies and a seed would flash.
  const mentionSeq = useRef(0)
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  const openMention = useCallback(async (username, ctx) => {
    const tap = ++mentionSeq.current
    if (ctx && ctx.username === username) {
      openMember(ctx.author)
      return
    }
    if (node.online === false) {
      showToast('Sem conexão para abrir o @nome.')
      return
    }
    const gen = generationRef.current
    const r = await resolveInvite({ username }, lookupUsername)
    // A newer tap, a lock or an identity change meanwhile drops this answer.
    if (tap !== mentionSeq.current || gen !== generationRef.current || lockedRef.current) return
    if (r.status === 'ready') openMember(r.key)
    else showToast(r.status === 'not-found' ? NOT_FOUND_TEXT : 'Não foi possível abrir o @nome agora.')
  }, [openMember, node.online])
  const mentionHandler = node.hosted === true ? openMention : undefined

  // A sheet open over the screens closes first (its Modal handles Back and
  // Escape itself).
  const sheetOpen = composer.open || report !== null || ajustes !== null
  const sheetOpenRef = useRef(sheetOpen)
  sheetOpenRef.current = sheetOpen
  const helpOpen = useHelpOpen()
  const helpOpenRef = useRef(helpOpen)
  helpOpenRef.current = helpOpen
  // Help opened inside Ajustes or Denunciar keeps sheetOpen true, so it stays.
  const stackDepth = nav.depth(stack)
  useEffect(() => { closeHelp() }, [stackDepth, sheetOpen])

  // --- the profile invite (src/profileLink.js) ---
  // The tabs are on screen and nothing hides them, so the follow toast (it
  // renders only in the tabs branch) and Membro are seen. !sheetOpen: on a
  // ?conta= load the shell opens Ajustes → Conta once setupStep turns false
  // (for a newcomer, right after the account link), and that sheet would
  // cover both. The once-sync clauses mirror the outbox gate above: a member
  // request now would preempt the recovery run.
  const atTabs = ready && setupDone && !setupStep && step === 'pronto' && !recovering && !sheetOpen && !helpOpen &&
    nav.isAuthorKey(ownKey) && !(node.sync.active && node.sync.active.once) && node.sync.starting !== true
  const action = inviteAction({
    invite,
    hosted: mode === 'hosted',
    // The passkey status was read at least once (or there is no passkey).
    // Nothing about the invite moves while the terms gate shows. The age gate
    // is not needed here: the card shows on Entrar and the consent is only a
    // tab-storage record, while the follow waits for atTabs, which needs the
    // age check passed (setupStep includes it).
    statusKnown: ready && termsOk && (passkey === null || pkStatus !== null),
    locked,
    resumed: !!(pkStatus && pkStatus.resumed === true),
    cardShown,
    unlockedKey: !locked && pkStatus ? pkStatus.publicKey : null,
    ownKey,
    atTabs,
    acceptedHere
  })
  actionRef.current = action

  // --- a notification click (src/pushClient.web.js) ---
  // The newest intent (at load or from a click while the passkey screen is
  // up) waits for the unlock; a later lock and any other key drop it.
  const launchRef = useRef(CAPTURED_LAUNCH)
  const [launchSeq, setLaunchSeq] = useState(0)
  // The screen a click opens reloads even when it is already showing:
  // Avisos through its refresh prop, the top Conversa by a remount.
  const [avisosReload, setAvisosReload] = useState(0)
  const [threadReload, setThreadReload] = useState({ ref: null, n: 0 })
  useEffect(() => listenLaunch((intent) => {
    launchRef.current = nextLaunch({ held: launchRef.current, intent })
    setLaunchSeq((n) => n + 1)
  }), [])
  const wasUnlocked = useRef(false)
  useEffect(() => {
    if (locked && wasUnlocked.current) launchRef.current = null
    wasUnlocked.current = !locked
  }, [locked])
  const launchKey = !locked && pkStatus ? pkStatus.publicKey : null
  useEffect(() => {
    const intent = launchRef.current
    if (intent === null || !atTabs || typeof launchKey !== 'string') return
    launchRef.current = null
    if (intent.recipient !== launchKey.toLowerCase()) return
    if (intent.kind === 'follow') {
      clearStack()
      setTab('avisos')
      setAvisosReload((n) => n + 1)
    } else {
      const shownNow = nav.top(stackRef.current)
      if (shownNow && shownNow.screen === 'conversa' && shownNow.key === intent.ref) {
        setThreadReload((r) => ({ ref: intent.ref, n: r.n + 1 }))
      } else {
        openThread({ ref: intent.ref })
      }
    }
  }, [launchSeq, atTabs, launchKey, clearStack, openThread])
  // The record is untrusted and may have changed in another render: every
  // step re-reads it (from tab storage, or memory when storage refused it).
  // The memory copy keeps the stored record's 1 h limit (readInvite applies
  // it to storage).
  const memoryInvite = () => {
    const rec = inviteRef.current
    return rec && Date.now() - rec.at <= INVITE_TTL_MS ? rec : null
  }
  const currentInvite = () => (inviteMemoryOnly.current ? memoryInvite() : loadInvite())
  const forgetInvite = () => {
    dropInvite()
    inviteRef.current = null
    setInvite(null)
  }
  useEffect(() => () => clearTimeout(retryTimer.current), [])
  useEffect(() => {
    if (action === 'card') {
      setCardShown(true)
      return
    }
    if (action === 'drop') {
      forgetInvite()
      return
    }
    if (action === 'accept') {
      // Only a passkey ceremony unlocks with resumed false and the shell
      // re-reads the status after it, so this is consent from the card the
      // visitor saw, bound to the key that just unlocked.
      // Consent is for the target the card showed (this render's state): a
      // record whose target changed in tab storage since then (devtools, an
      // extension) was never agreed to, so it is dropped, not accepted.
      const rec = currentInvite()
      const next = sameTarget(rec, inviteRef.current) ? acceptInvite(rec, pkStatus.publicKey, Date.now()) : null
      if (next === null) dropInvite()
      else if (!saveInvite(next)) inviteMemoryOnly.current = true
      inviteRef.current = next
      setInvite(next)
      if (next !== null) setAcceptedHere(true)
      return
    }
    if (action !== 'follow' && action !== 'confirm' && action !== 'open') return
    // One attempt at a time; a wake (online, retry timer) that arrives
    // meanwhile runs again once this attempt ends.
    if (inviteBusy.current) {
      wakePending.current = true
      return
    }
    inviteBusy.current = true
    const gen = generationRef.current
    const attempt = async () => {
      const rec = currentInvite()
      if (rec === null) {
        inviteRef.current = null
        setInvite(null)
        return
      }
      // The stored record must still name the target this page holds (the one
      // the card showed and consent was bound to, or the one loaded at start):
      // a target swapped in tab storage meanwhile is dropped, never followed.
      if (!sameTarget(rec, inviteRef.current)) {
        forgetInvite()
        return
      }
      const r = await resolveInvite(rec, lookupUsername)
      // A lock, unlock or reset meanwhile, or the gate closed during the
      // lookup (a follow.add now would abort a starting once sync): the record
      // stays, and the effect runs again when the action comes back.
      if (gen !== generationRef.current || actionRef.current !== action) return
      if (r.status === 'unavailable') {
        // Kept and retried: on node.online changes and on a backoff timer
        // (the account service can fail while the browser stays online).
        if (!offlineShown.current) {
          offlineShown.current = true
          showToast(OFFLINE_TEXT)
        }
        clearTimeout(retryTimer.current)
        retryTimer.current = null
        if (retryCount.current < INVITE_RETRIES) {
          retryTimer.current = setTimeout(() => setInviteTick((n) => n + 1), inviteRetryDelay(retryCount.current))
          retryCount.current += 1
        }
        return
      }
      clearTimeout(retryTimer.current)
      retryTimer.current = null
      retryCount.current = 0
      // Claimed before acting: at most one attempt, nothing replayed after a
      // reload or a failure.
      forgetInvite()
      if (r.status !== 'ready') {
        showToast(NOT_FOUND_TEXT)
        return
      }
      const key = r.key
      // The own link: openMember switches to Diário; never a self-follow.
      if (key === ownKey) {
        openMember(key)
        return
      }
      // The only follow.add of an invite: consent recorded in this page load
      // for exactly this key. 'open' (a visitor already signed in) and
      // 'confirm' (an accepted record found after a reload) never follow.
      if (action === 'follow' && acceptedHere && rec.state === 'accepted' && rec.recipient === ownKey) {
        try {
          const res = await node.request('follow.add', { key })
          followsChanged()
          showToast(followedText({ username: rec.username, changed: res.changed === true }))
        } catch (err) {
          // Uncertain, 'autor bloqueado' and the follow limit are shown once
          // and never retried (the record is already gone).
          showToast(errorText(err))
        }
        // The follow stands; only the profile is not opened for another
        // identity. Not the action: forgetInvite() above already turned it to
        // 'none', so comparing it here would never open the profile.
        if (gen !== generationRef.current) return
      }
      openMember(key)
      // The newcomer back from Google: the profile is open, Seguir is one tap.
      if (action === 'confirm') showToast(confirmText({ username: rec.username }))
    }
    attempt().catch(() => {}).finally(() => {
      inviteBusy.current = false
      if (wakePending.current) {
        wakePending.current = false
        setInviteTick((n) => n + 1)
      }
    })
  }, [action, node.online, inviteTick])
  useEffect(() => {
    if (Platform.OS === 'android') {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (helpOpenRef.current || sheetOpenRef.current || nav.depth(stackRef.current) === 0) return false
        commitStack(nav.pop(stackRef.current))
        return true
      })
      return () => sub.remove()
    }
    if (Platform.OS !== 'web' || typeof globalThis.addEventListener !== 'function') return
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || helpOpenRef.current || sheetOpenRef.current || nav.depth(stackRef.current) === 0) return
      goBack()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [commitStack, goBack])
  const openComposer = () => setComposer((c) => ({ ...c, open: true }))
  const reselectTab = (id) => setScrollSignal((s) => ({ ...s, [id]: (s[id] || 0) + 1 }))
  // Side insets (landscape notch/cutout): the larger one on both sides, so
  // centred content stays centred when only one side has a cutout.
  const sidePad = Math.max(insets.left, insets.right)
  const sideEdges = { top: 'additive', bottom: 'additive', left: 'off', right: 'off' }

  const splash = <Splash sidePad={sidePad} edges={sideEdges} />
  // The intro cards come first, once per device (src/intro.js): presentation
  // only, so autosync, the outbox and the invite keep waiting for termsOk. A
  // Google return skips them for that page load without marking them seen.
  // The terms gate, before everything else: Conexao, Entrar (so before
  // Google) while this device has no record of the current version, and the
  // tabs. Once it has one, an account that unlocks without its own entry
  // meets the gate right after the passkey. Nothing renders behind it, and
  // autosync, the outbox and the invite wait for termsOk. Not gated
  // (documented): the provider's boot, the session resume and the one
  // recovery sync of a diary without its certificate (src/node.js).
  if (decision === 'loading' || introState === 'loading') return splash
  if (introState === 'show' && !LINK_RETURN && !AGE_RETURN) return <Introducao onDone={() => intro.markSeen()} sidePad={sidePad} edges={sideEdges} />
  if (decision === 'needed' || decision === 'updated' || decision === 'account') {
    return (
      <SafeAreaView style={[styles.flex, { paddingHorizontal: sidePad }]} edges={sideEdges}>
        <Termos gate reason={decision} version={LEGAL_VERSION} onAccept={() => terms.accept(member)} />
        <StatusBar style='dark' />
      </SafeAreaView>
    )
  }

  if (!ready && !seen) {
    // loading, connecting, the native Conectar form, or a web error.
    if (node.phase === 'loading' || (node.phase === 'connecting' && !node.canConfigure)) return splash
    return (
      <SafeAreaView style={[styles.flex, { paddingHorizontal: sidePad }]} edges={sideEdges}>
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
    if (step === 'idade') {
      // Unknown and not failed yet counts as busy: an already verified member
      // sees the spinner, not the start button, while the result is read.
      body = (
        <Idade
          state={ageState}
          busy={ageBusy || (ageState === undefined && !ageError)}
          error={ageError}
          note={ageNote}
          offline={node.online === false}
          onStart={startAge}
          onCheck={checkAge}
          index={index}
          total={total}
        />
      )
    } else if (passkey !== null || info !== null) {
      // embedded: the top bar above already carries the step's title
      // The invite card shows on Entrar only (never in the Ajustes Identidade).
      const inviteProp = action === 'card'
        ? {
            text: inviteCardText(invite),
            link: buildProfileUrl({ origin: globalThis.location ? globalThis.location.origin : null, username: invite.username, publicKey: invite.key }),
            onDismiss: forgetInvite
          }
        : null
      body = <Identidade active={ready} embedded setup step={step} index={index} total={total} onInfo={takeInfo} invite={inviteProp} />
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
        <TopBar title={STEP_TITLES[step]} right={HELP[step] ? <HelpButton key={step} doc={HELP[step]} /> : null} />
        <OfflineNote />
        {/* Without the Conexão link (hosted page) the body clears the home indicator itself. */}
        <View style={[styles.flex, connectionLink === null && { paddingBottom: insets.bottom }]}>{body}</View>
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
        <TopBar title={STEP_TITLES[step]} right={<HelpButton doc={HELP.perfil} />} />
        <OfflineNote />
        <View style={[styles.flex, Platform.OS === 'web' && { paddingBottom: insets.bottom }]}>
          <Perfil
            page
            ownKey={ownKey}
            onSaved={(v) => {
              names.learn(ownKey, v)
              names.invalidate([ownKey])
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
      onOpenEngagers: openEngagers,
      onOpenMember: openMember,
      onOpenMention: mentionHandler,
      onToast: showToast,
      onFollowsChanged: followsChanged,
      onDeletedPost: deletedPost
    }
    content = (
      <View style={[styles.shell, wide && styles.shellWide]}>
        {tab !== 'diario'
          ? <TopBar title={TAB_TITLES[tab]} right={stacked ? null : <HelpButton key={tab} doc={HELP[tab]} />} />
          : null}
        <OfflineNote inset={tab === 'diario'} />
        {updateReady && !updateDismissed
          ? <UpdateNote onUpdate={() => { try { if (Platform.OS === 'web') window.location.reload() } catch {} }} onClose={() => setUpdateDismissed(true)} inset={tab === 'diario' && node.online !== false} />
          : install.note !== 'none' ? <InstallNote kind={install.note} onInstall={() => { install.promptInstall() }} onClose={() => { install.dismissInstall() }} inset={tab === 'diario' && node.online !== false} /> : null}
        <View style={styles.flex}>
          <View style={shown('rua')}>
            <ARua
              onDeletedPost={deletedPost}
              active={on('rua')}
              refresh={version}
              onReply={startReply}
              onReport={setReport}
              onToast={showToast}
              onOpenThread={openThread}
              onOpenEngagers={openEngagers}
              onOpenMember={openMember}
              onOpenMention={mentionHandler}
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
              refresh={peekVersion}
              followsSignal={followsSignal}
              onPublish={openComposer}
              onReply={startReply}
              onReport={setReport}
              onOpenThread={openThread}
              onOpenEngagers={openEngagers}
              onOpenMember={openMember}
              onOpenMention={mentionHandler}
              onQuote={startQuote}
              ownKey={ownKey}
              scrollToTop={scrollSignal.espiadinha}
              onFollowsChanged={followsChanged}
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
              onFollowsChanged={followsChanged}
              ownKey={ownKey}
              followsTick={version}
            />
          </View>
          <View style={shown('avisos')}>
            <Avisos
              active={on('avisos')}
              refresh={version + avisosReload}
              ownKey={ownKey}
              onOpenThread={openThread}
              scrollToTop={scrollSignal.avisos}
              onFollowsChanged={followsChanged}
              onToast={showToast}
              onBadge={setAvisosNew}
            />
          </View>
          <View style={shown('diario')}>
            <Diario
              onDeletedPost={deletedPost}
              active={on('diario')}
              refresh={version}
              onSettings={setAjustes}
              onToast={showToast}
              onReply={startReply}
              onPublish={openComposer}
              onOpenThread={openThread}
              onOpenEngagers={openEngagers}
              onOpenMember={openMember}
              onOpenMention={mentionHandler}
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
                const Screen = entry.screen === 'conversa' ? Conversa : entry.screen === 'curtidas' ? Curtidas : Membro
                return (
                  <View key={i + ':' + entry.screen + ':' + entry.key + (entry.screen === 'conversa' && entry.key === threadReload.ref ? ':' + threadReload.n : '')} style={i === stack.length - 1 ? styles.flex : styles.hidden}>
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
    username: ownProfile ? (ownProfile.username || null) : null,
    avatar: ownProfile ? ownProfile.avatar : undefined
  }
  // Light over the Diário band (dark over the offline note above it). The
  // sheets leave the status bar over the (dimmed) screen behind, so they keep
  // it light there too.
  const light = tab === 'diario' && step === 'pronto' && node.online !== false && nav.depth(stack) === 0

  // Side insets are applied once here (sidePad); top and bottom by each bar;
  // Modal content (sheets, photo viewer) pads itself.
  return (
    <View style={[styles.root, { paddingHorizontal: sidePad }]}>
      {content}
      {/* The terms gate used to unmount these sheets on a hosted lock as a
          side effect, and a current terms record no longer brings it up. So
          Publicar is not mounted while locked (its draft and photo go) and
          Ajustes remounts on every lock and unlock (its cached key goes) but
          stays reachable at Entrar for the 'Conexão' footer. With the lock
          effect clearing the composer context, nothing reaches the next
          account in this tab. */}
      {!locked && (
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
            setPeekVersion((v) => v + 1)
            showToast(kind === 'reply' ? 'resposta publicada' : 'publicado')
          }}
        />
      )}
      <Denunciar
        open={report !== null}
        target={report}
        onClose={() => setReport(null)}
        onSent={(text) => {
          setReport(null)
          showToast(text)
        }}
      />
      <Ajustes key={locked ? 'locked' : 'open'} screen={ajustes} onNavigate={setAjustes} onClose={() => setAjustes(null)} onInfo={ajustesInfo} termsInfo={termsInfo} onTermsReset={dropTermsAndSync} />
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
