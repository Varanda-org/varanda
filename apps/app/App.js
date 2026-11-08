/* global document */
// The app shell: before anything else the Termos de Uso and Política de
// Privacidade gate (src/terms.js: per member, per version; nothing renders
// behind it and autosync, the outbox and a profile invite wait for it; a
// hosted linked member's acceptance is also sent to the account service),
// then the first connection, the onboarding (src/onboarding.js
// decides the step: on the web's browser node 'Entrar' with the passkey, the
// account link; natively identity and member certificate; then the own name)
// and then the tabs (src/tabs.js) with the top bar (an info button
// that opens the screen's 'Como funciona' sheet and, on a hosted node, the
// bell that opens Avisos, a screen kept outside the tab bar), the
// 'Sem internet' note under it (only while offline), the 'Instalar o Varanda'
// note under it too (hosted web, phones and iPad; below 'Sem internet' when
// both show; its close is remembered for 30 days), then the 'Receber avisos
// neste aparelho' note in the same slot (hosted web, every browser where Web
// Push works, desktop included, src/usePush; one tap goes straight to the
// browser's permission prompt; its close is remembered for 30 days; at most
// one of the release note, the install card or note and the push note shows,
// in that order, so the push note waits while an earlier one shows), the publish
// button and the sheets (Publicar, Ajustes). Sync is automatic and silent: this shell
// owns the intent (node.setAutoSync) and nothing else in the UI starts or
// stops a run; its details live in Ajustes → Sincronização. Above the tabs a
// small screen stack (src/nav.js) opens Conversa (a post and its replies),
// Curtidas (who liked or reposted a post) and Membro (a profile) as
// full-screen layers; the tabs stay mounted below.
// Back: the browser Back button (src/history.web.js; an in-app back calls
// history.back() so the history and the stack never drift), Escape on the
// web, the Android Back button (BackHandler); an open sheet closes first.
// A profile link (/@ana, /m/<key>; a hosted node, src/profileLink.js) is
// captured at load on the site and through Linking in the app: Entrar shows
// the invite, a passkey ceremony from that card records consent, and once the
// tabs show the inviter is followed when that consent was given in this page
// load; after a reload (the Google return) the
// profile opens for one tap on Seguir, and a visitor already signed in only
// gets the profile opened.
// A notification click (hosted web, src/pushClient.web.js) arrives as
// /?aviso=... at load or as a worker message: held in memory only, it opens
// Avisos (a follow) or Conversa (a reply, like or repost) for the key it
// names, or Convidar pessoas (a convite, which names nobody) once the tabs
// show; nothing is written, followed or retried.
// A group or community link (/g/<key>, /c/<key>) is announced on Entrar and
// opens the screen once the tabs show; it is never consent to join.
// A splash holds a short minimum while the app loads and, on the web, covers
// the node's connection; the intro cards (src/intro.js) follow once per device,
// before the Termos.
// The age gate (a hosted node, on the site or in the app on an installation;
// src/age.js) holds every member, linked or
// not, at 'Confirme sua idade' until the account service answers
// 'verificado'; it fails closed while the policy or the result is unknown.
// A pass is proved by what the node reports from two issuer-signed
// attestations it checks on every read (the member's age-verified
// attestation, or the member certificate dated on or after the signed
// since); the device keeps only refusals (src/ageMemory.js, never the band).
// The service is still asked in the background and its answer wins.
// Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { AppState, BackHandler, Linking, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { NodeProvider, perfMarks, useNode } from './src/node'
import { hostedPage } from './src/configStore'
import { pagesOn, setCoreReach } from './src/pageGate'
import { CROSS_ORIGIN_PAGES } from './src/pageReach'
import { installationOrigin } from './src/installation'
import { makeIntent, validIntent } from './src/privateReply'
import { NamesProvider, useNames } from './src/names'
import { BlocksProvider, useBlocks } from './src/blocksProvider'
import { BlockSheet } from './src/ui/BlockSheet'
import { accountStatus, agePolicy as readAgePolicy, ageResult, ageSince as readAgeSince, ageSession, ageStart, invitePolicy as readInvitePolicy, lookupUsername, parseReturn, parseReturnInvite, parseReturnWaitlist, passkeyAdd, passkeyStart, seenFinish, seenStart, termsFinish, termsStart } from './src/account'
import { NOTICES_POLL_MS } from './src/notices'
import { ackCaughtUp, cleanAvisos, createSeenScheduler, dropSent, rememberSent, reportAvisosSeen, runSeenPass, snapshotBefore } from './src/seenSync'
import { deletedOf, newReceipt, scheduledOf } from './src/accountDeletion'
import { enrolWith } from './src/passkeyEnrol'
import { loadDeletionReceipt, saveDeletionReceipt } from './src/deletionReceiptStore'
import { ageBlocking, ageErrorText, ageGate, ageReadAllowed, parseReturnAge } from './src/age'
import { ageAnswerOutcome, ageStateShown, nodeVouches } from './src/ageMemory.js'
import * as nav from './src/nav'
import { bindHistory } from './src/history'
import { STEP_TITLES, onboardingStep } from './src/onboarding'
import { captureInvite, dropInvite, loadInvite, saveInvite } from './src/profileLinkStore'
import { captureEntryLink, dropEntryLink } from './src/groupLinkStore'
import { ENTRY_LINK_LABELS, ENTRY_OPEN_TEXT, entryCardText, entryPath } from './src/groupLink'
import { showPostButton, tabsFor } from './src/tabs'
import { captureSignupInvite, dropSignupInvite, dropSignupInviteCard, loadSignupInvite, loadSignupInviteCard } from './src/signupInviteStore'
import { CARD_RECORD_TTL_MS, canAttribute, cardRecordId, resolveInviteCard } from './src/inviteCardFlow'
import { OPEN_WAIT_MS, arrivalGate, expiryLine, openingGate } from './src/inviteCardCopy'
import { INVITE_TTL_MS, NOT_FOUND_TEXT, OFFLINE_TEXT, acceptInvite, buildProfileUrl, confirmText, followedText, inviteAction, inviteCardText, resolveInvite } from './src/profileLink'
import { OutboxProvider, useOutbox, useOutboxDrain } from './src/outboxProvider'
import { LEGAL_VERSION } from './src/legal'
import { shouldSyncTerms, termsDecision, termsSyncAttempted, termsSyncStep } from './src/terms'
import { useTerms } from './src/useTerms'
import { useAgeMemory } from './src/useAgeMemory'
import { INTRO_VERSION, introDecision } from './src/intro'
import { useIntro } from './src/useIntro'
import { CONNECT_PATIENCE_MS, SPLASH_MIN_MS, bootPatienceMs, bootProgress, coverBoot, coverConnecting, holdBootCover, holdSplash } from './src/splashGate'
import { Btn, ErrorText, Soft, Spinner, errorText } from './src/ui'
import { ThemeProvider, useStyles, useTheme } from './src/ui/ThemeProvider'
import { Fab } from './src/ui/Fab'
import { Splash } from './src/ui/Splash'
import { OfflineNote } from './src/ui/OfflineNote'
import { InstallNote } from './src/ui/InstallNote'
import { InstallCard } from './src/ui/InstallCard'
import { PushNote } from './src/ui/PushNote'
import { DeletionNote } from './src/ui/DeletionNote'
import { InviteDropNote } from './src/ui/InviteDropNote'
import { InviteArrival } from './src/ui/InviteArrival'
import { InviteCardOpen } from './src/ui/InviteCardOpen'
import { useInviteDrop } from './src/useInviteDrop'
import { UpdateNote } from './src/ui/UpdateNote'
import { useInstall } from './src/install'
import { readPush, usePush } from './src/usePush'
import { watchRelease } from './src/pwa'
import { captureLaunch, listenLaunch } from './src/pushClient'
import { nextLaunch } from './src/push-state'
import { loadIcons } from './src/ui/Icon'
import { TabBar } from './src/ui/TabBar'
import { TopBar } from './src/ui/TopBar'
import { TopActions } from './src/ui/TopActions'
import { StackLayer, stackBusy, useStackMotion } from './src/ui/StackLayer'
import { stackEntries } from './src/stackEntries'
import { HelpButton, closeHelp, useHelpOpen } from './src/ui/Help'
import { HELP } from './src/help'
import { layout, type } from './src/ui/theme'
import { paletteFor, statusBarStyle } from './src/appearance.js'
import { applyBandMeta } from './src/appearanceStore'
import Avisos from './src/screens/Avisos'
import BuscaGlobal from './src/screens/BuscaGlobal'
import { Grupo } from './src/screens/Grupo'
import { Conversas } from './src/screens/Conversas'
import { Mensagens } from './src/screens/Mensagens'
import { Comunidades } from './src/screens/Comunidades'
import { Mensagem } from './src/screens/Mensagem'
import { onDmOpen, onDmWake, requestDmOpen } from './src/dm-open'
import { Comunidade } from './src/screens/Comunidade'
import { ComunidadeInfo } from './src/screens/ComunidadeInfo'
import Ajustes from './src/screens/Ajustes'
import ARua from './src/screens/ARua'
import Conexao from './src/screens/Conexao'
import Conversa, { useActing } from './src/screens/Conversa'
import Curtidas from './src/screens/Curtidas'
import Denunciar from './src/screens/Denunciar'
import Diario from './src/screens/Diario'
import Espiadinha from './src/screens/Espiadinha'
import Introducao from './src/screens/Introducao'
import Identidade from './src/screens/Identidade'
import Idade, { AGE_APP_NOTE } from './src/screens/Idade'
import { createLinkToken, dropsHeldInvite, invitePasteShown, isInviteRefusal, linkReturnTaker, parseAppLink, parseAppReturn, waitsForInstallation } from './src/linkReturn'
import Membro from './src/screens/Membro'
import Depoimentos from './src/screens/Depoimentos'
import Momentos from './src/screens/Momentos'
import Feira from './src/screens/Feira'
import Anuncio from './src/screens/Anuncio'
import Anunciar from './src/screens/Anunciar'
import AnuncioEditar from './src/screens/AnuncioEditar'
import Avaliar from './src/screens/Avaliar'
import { alertsStore } from './src/feiraAlertsStore'
import { alertsBadge } from './src/feiraScreen'
import { createFeiraEntry, decideEntry, heldIsFeira } from './src/feiraEntry'
import { useFeiraEntryStart } from './src/useFeiraEntryStart'
import { captureListing, dropListing, entryStorage, holdFeiraCode } from './src/feiraEntryStore'
import { feiraLocation } from './src/feiraPlaceStore'
import Perfil from './src/screens/Perfil'
import Pessoas from './src/screens/Pessoas'
import Paginas from './src/screens/Paginas'
import NovaPagina from './src/screens/NovaPagina'
import PaginaAjustes from './src/screens/PaginaAjustes'
import * as actingAs from './src/actingAs'
import Publicar from './src/screens/Publicar'
import Seguindo from './src/screens/Seguindo'
import Termos from './src/screens/Termos'
import { ContaExcluida, ExclusaoRecibo } from './src/screens/ExcluirConta'
import { clearChatMedia, onAppStateChange, stopPlayback } from './src/media/chatMedia'
import { sweepVoiceCache } from './src/media/audio'

// Inlined by Expo at build time; set only for the iOS worklet gate
// (docs/ios-gate.md).
const GATE_URL = process.env.EXPO_PUBLIC_VARANDA_GATE_URL

const TOAST_MS = 2500
const TOAST_ACTION_MS = 4000
// The native splash stays cream in both schemes (Splash.js), and so does what
// wraps it: the side insets around it would otherwise show the dark bg.
const SPLASH_WRAP = Platform.OS === 'web' ? null : { backgroundColor: paletteFor('light').bg }
const TAB_TITLES = { rua: 'A Rua', espiadinha: 'Espiadinha', comunidades: 'Conversas', feira: 'Feira', busca: 'Busca', avisos: 'Avisos' }
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
// The node.info read for the certificate proof on the age step, same idea.
const ageInfoDelay = (n) => (n === 0 ? 2000 : n === 1 ? 5000 : n === 2 ? 15000 : 30000)
const AGE_REDIRECT_TEXT = 'Vamos abrir a verificação e, na volta, pedir sua passkey de novo.'

// The steps the setup branch (Identidade, Idade) renders; the others belong
// to the shell (spinner, Perfil, the tabs).
const SETUP_STEPS = new Set(['entrar', 'recuperando', 'idade', 'vinculo', 'identidade', 'certificado'])

// True when this page load is the return from the Google step of the account
// link (?conta=…). Read at import, before any screen renders; only read here:
// Identidade's LinkCard is the one that removes the query. Native has no
// location: its Google step returns through the auth session (Identidade).
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
// A group or community link (/g/<hex>, /c/<hex>) is read and cleaned the
// same way, once, before any render. On the hosted page it is kept in tab
// storage for 1 h so it survives the Google step's reload, and it is dropped
// once opened. The native app has no page load: its links come through Linking.
const CAPTURED_ENTRY = captureEntryLink()
// A Feira listing link (/f/<hex>/<seq>, /anuncio/<hex>/<seq>) is read and
// cleaned the same way, once, after the group link. Its signup entry
// (src/feiraEntry.js) is kept with the installation it was captured for: ''
// on the hosted web page (relative requests), so it survives the Google step,
// the Terms and the setup, and the listing opens once the tabs are up.
const FEIRA_ENTRY = createFeiraEntry({ getStorage: entryStorage })
const CAPTURED_LISTING = captureListing()
if (CAPTURED_LISTING !== null) FEIRA_ENTRY.capture({ author: CAPTURED_LISTING.author, seq: CAPTURED_LISTING.seq, origin: '' })
// The native app reads Linking's initial URL once per process: it stays the
// same for the whole run, and Member may mount again.
let initialUrlTaken = false
const NATIVE_APP = Platform.OS !== 'web'
setCoreReach(CROSS_ORIGIN_PAGES)
const NO_VERSIONS = Object.freeze({})
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
// resolveInviteCard counts a card expired once the whole second after its
// signed expires (seconds) has passed.
function cardExpiredAt (expires) {
  return (expires + 1) * 1000
}

function cardPastExpires (card, now) {
  return !!card && typeof card.expires === 'number' && now >= cardExpiredAt(card.expires)
}

function setupComplete (info) {
  return info !== null && info.publicKey !== null && info.memberCert === true
}

function Member () {
  const styles = useStyles(makeStyles)
  const { scheme, colors } = useTheme()
  const node = useNode()
  const names = useNames()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const install = useInstall()
  const push = usePush()
  const bootAt = useRef(Date.now()).current
  const connectingAt = useRef(null)
  const released = useRef(false)
  // Latched once the first real screen (A Rua, Entrar, Idade with its answer,
  // Vinculo, Perfil) has shown in this page load, or once the patience ran
  // out, like released and reachedTabs: a later lock, unlock, generation
  // change or cleared cache never brings the splash back. released stays
  // apart: it only ends the connect cover, and a slow native connection
  // (Conexão after 10 s) still needs the cover over the age read afterwards.
  const bootCoverAt = useRef(null)
  const bootStepRef = useRef(null)
  const bootSettled = useRef(false)
  // A Rua's first page and the names and counts of its first rows: the
  // splash covers 'pronto' until both are in (at most CONTENT_PATIENCE_MS).
  const [feedBoot, setFeedBoot] = useState({ page: false, details: false })
  const onFeedBoot = useCallback((stage) => setFeedBoot((b) => (b[stage] ? b : { ...b, [stage]: true })), [])
  const barRef = useRef(0)
  const [, bumpSplash] = useState(0)
  // A timer can fire a few ms before Date.now() reaches the threshold; the
  // slack makes the re-render see it passed, since nothing re-arms the timer.
  useEffect(() => {
    const t = setTimeout(() => bumpSplash((n) => n + 1), SPLASH_MIN_MS + 50)
    return () => clearTimeout(t)
  }, [])
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
  const tabRef = useRef(tab)
  tabRef.current = tab
  // Avisos is reached from the bell, not the tab bar: its back returns here.
  const [returnTab, setReturnTab] = useState('rua')
  const returnTabRef = useRef(returnTab)
  returnTabRef.current = returnTab
  // Per tab, bumped when its tab is selected again: the screen scrolls to top.
  const [scrollSignal, setScrollSignal] = useState({})
  // Bumped to make Busca show its Contas pane.
  const [buscaPane, setBuscaPane] = useState(0)
  // reply and quote are mutually exclusive.
  const [composer, setComposer] = useState({ open: false, reply: null, quote: null })
  // The screens pushed above the tabs (src/nav.js), oldest first.
  const [stack, setStack] = useState(nav.EMPTY)
  const stackRef = useRef(stack)
  const [ajustes, setAjustes] = useState(null)
  // The report sheet's target: null | { author, name, username, seq, text }.
  const [report, setReport] = useState(null)
  // Bumped by a saved edit so the Anúncio under the editor reads it again.
  const [listingRefresh, setListingRefresh] = useState(0)
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
  // A block or an unblock changes what A Rua and the Espiadinha may read.
  const { changed: blocksChanged, refresh: refreshBlocks } = useBlocks()
  useEffect(() => {
    if (blocksChanged === 0) return
    setVersion((v) => v + 1)
    setPeekVersion((v) => v + 1)
  }, [blocksChanged])
  // Avisos has something unseen: a plain dot on the bell, never a number.
  const [avisosNew, setAvisosNew] = useState(false)
  const [info, setInfo] = useState(null)
  const [infoError, setInfoError] = useState('')
  // Latched once node.info confirmed the identity and the certificate: a
  // later failed or slow read never hides the tabs again.
  const [setupDone, setSetupDone] = useState(false)
  const [toast, setToast] = useState(null)
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
  // One token per profile link captured in this run (native: links arrive
  // while the app runs, not only at load).
  const inviteLinksRef = useRef(null)
  if (inviteLinksRef.current === null) inviteLinksRef.current = createLinkToken()
  const inviteLinks = inviteLinksRef.current

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
  // Sair, Recomeçar and a lock move one of these: every chat photo URL and
  // node plaintext file of the old session is released, a playing voice note
  // stops (the chat screen may stay mounted) and a leftover recording file
  // is swept.
  useEffect(() => {
    stopPlayback()
    clearChatMedia()
    sweepVoiceCache()
  }, [generation, locked])
  const canClearReads = node != null && node.media != null && typeof node.media.clearReadFiles === 'function'
  useEffect(() => {
    if (!canClearReads) return
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') stopPlayback()
      onAppStateChange(state, { canClear: true })
    })
    return () => sub.remove()
  }, [canClearReads])
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
  // The signup invite card (src/inviteCardFlow.js) kept beside the code by
  // the captures (the web load above, appUrlRef, the paste fields). Read
  // again on every capture, drop, focus and expiry: the store re-checks its
  // 24 h on each read and clears an expired record, and the rendered card
  // follows. tick also re-runs the resolve for the same record (a retry).
  const [cardState, setCardState] = useState(() => ({ record: loadSignupInviteCard(), tick: 0 }))
  const reloadCard = useCallback(() => setCardState((c) => ({ record: loadSignupInviteCard(), tick: c.tick + 1 })), [])
  const cardKey = cardRecordId(cardState.record)
  const member = passkey !== null
    ? ((!locked && pkStatus && pkStatus.publicKey) || null)
    : ((info && info.publicKey) || null)
  // Excluir conta: an unlocked key the account service deleted (another
  // device asked, or this one could not wipe) is held on a notice, before
  // the terms gate, until it is erased here. Read once per unlocked member.
  // The same read gives the date of a deletion waiting for it (asked without
  // a passkey the service could verify), shown on every signed-in device
  // (DeletionNote), and, for a linked member, sends the passkey enrolment
  // left by a creation on this device (src/passkeyEnrol.js), at most one
  // attempt in flight. refreshAccount() reads again after a schedule or a
  // cancel.
  const [deletedState, setDeletedState] = useState(null)
  const [scheduledDeletion, setScheduledDeletion] = useState(null)
  const [accountTick, setAccountTick] = useState(0)
  const refreshAccount = useCallback(() => setAccountTick((n) => n + 1), [])
  const enrolling = useRef(false)
  useEffect(() => {
    setDeletedState(null)
    setScheduledDeletion(null)
    if (node.hosted !== true || member === null) return
    let alive = true
    accountStatus(member).then((st) => {
      if (!alive) return
      setDeletedState(deletedOf(st))
      setScheduledDeletion(scheduledOf(st))
      if (st && st.linked === true && typeof st.username === 'string' && passkey !== null && !enrolling.current) {
        enrolling.current = true
        enrolWith({ passkey, request: node.request, member, username: st.username, start: passkeyStart, add: passkeyAdd })
          .catch(() => {})
          .finally(() => { enrolling.current = false })
      }
    }, () => {})
    return () => { alive = false }
  }, [node.hosted, member, accountTick])
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

  // --- the age gate (src/age.js; a hosted node) ---
  // The policy is read once the node is ready; a failed read (null) keeps
  // everyone blocked and is tried again with a backoff and when the
  // connection comes back.
  // The setup footer can switch installation, and each installation has its
  // own policy: one read on another installation counts as not read here
  // (undefined), so the gate stays closed until this installation answers.
  // On the hosted website installationOrigin() is null and the page is the
  // installation.
  const ageOrigin = installationOrigin() || globalThis.location?.origin || ''
  const [agePolicyEntry, setAgePolicyEntry] = useState(null)
  const agePolicy = agePolicyEntry !== null && agePolicyEntry.origin === ageOrigin ? agePolicyEntry.policy : undefined
  const [agePolicyTick, setAgePolicyTick] = useState(0)
  const agePolicyTries = useRef(0)
  const agePolicyTriesOrigin = useRef(ageOrigin)
  const agePolicyKnown = agePolicy !== undefined && agePolicy !== null
  useEffect(() => {
    // A new installation starts its own backoff.
    if (agePolicyTriesOrigin.current !== ageOrigin) {
      agePolicyTriesOrigin.current = ageOrigin
      agePolicyTries.current = 0
    }
    if (!ageHosted || !ready || agePolicyKnown) return
    // The answer is labelled with the installation it was asked of. Should the
    // installation have changed since this render, the next render runs this
    // again with the new origin, so nothing is asked under a stale label.
    const origin = ageOrigin
    if (origin !== (installationOrigin() || globalThis.location?.origin || '')) return
    let cancelled = false
    let timer = null
    readAgePolicy().then((p) => {
      if (cancelled) return
      setAgePolicyEntry({ origin, policy: p })
      if (p !== null) return
      timer = setTimeout(() => setAgePolicyTick((n) => n + 1), agePolicyDelay(agePolicyTries.current))
      agePolicyTries.current += 1
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ageHosted, ready, agePolicyKnown, agePolicyTick, ageOrigin])
  const agePolicyOnlineRef = useRef(node.online)
  useEffect(() => {
    const was = agePolicyOnlineRef.current
    agePolicyOnlineRef.current = node.online
    if (was !== false || node.online !== true || agePolicyKnown) return
    setAgePolicyTick((n) => n + 1)
  }, [node.online, agePolicyKnown])

  // Owner decision 2026-11-04: the check is remembered per account,
  // independent of the device, so a member who passed it opens A Rua after
  // the splash instead of waiting on the service. Two proofs, never the band,
  // both signed by the account service's issuer and checked by the node on
  // every read: the member's age-verified attestation (node.info
  // ageVerifiedDate), and the member certificate dated on or after the
  // installation's signed since and no later than its signing date
  // (ageSince <= memberCertDate <= ageSinceUntil; the service issues no
  // certificate to a key without a recorded band). Nothing the
  // device stores can open the gate: it keeps only refusals. The service is
  // still asked in the background, and its answer wins.
  const ageMemory = useAgeMemory()
  // node.info as read for this member only: it is cleared on every lock,
  // unlock and reset, and a read from an older generation is dropped.
  const ageInfo = info !== null && member !== null && info.publicKey === member ? info : null
  // Only once the refusals are loaded (a denial on record must not flash the
  // gate open), and a refusal on record or in this run wins over both proofs,
  // offline too (openNow).
  const ageRemembered = member !== null && ageMemory.loaded &&
    ageMemory.open(member, ageOrigin, nodeVouches({ ageVerifiedDate: ageInfo?.ageVerifiedDate, memberCertDate: ageInfo?.memberCertDate, ageSince: ageInfo?.ageSince, ageSinceUntil: ageInfo?.ageSinceUntil }))
  // node.info after the node stored a proof. Not while a recovery or once
  // sync runs (node.info may open the store and preempt it): held, and read
  // when that run is over.
  const ageInfoFreeRef = useRef(false)
  ageInfoFreeRef.current = !recovering && !onceSync
  const ageInfoHeld = useRef(false)
  const ageInfoAfterProof = () => {
    if (ageInfoFreeRef.current) return readInfo()
    ageInfoHeld.current = true
  }
  useEffect(() => {
    if (recovering || onceSync || !ageInfoHeld.current) return
    ageInfoHeld.current = false
    readInfo()
  }, [recovering, onceSync, readInfo])

  // The member's result, asked of the account service (never taken from the
  // URL or from storage): once per generation, member and installation, and
  // again on 'Conferir de novo'. It runs even when the gate is already open
  // from memory, so a later refusal closes it again.
  const [ageState, setAgeState] = useState(undefined)
  const [ageBusy, setAgeBusy] = useState(false)
  const [ageError, setAgeError] = useState('')
  const [ageNote, setAgeNote] = useState('')
  const [ageCheckTick, setAgeCheckTick] = useState(0)
  // Bumped by every age request and by a lock or generation change: an
  // answer that arrives under another number is dropped.
  const ageSeq = useRef(0)
  // The age-step Feira hook's limit(err) (set below, where it is called).
  const ageFeiraLimitRef = useRef(() => false)
  const ageRan = useRef(null)
  // The key of the last background read that finished (see ageReadPending).
  const [ageReadDone, setAgeReadDone] = useState(null)
  // The key the screen is waiting on now, set on every render.
  const ageReadKeyRef = useRef(null)
  const ageOriginRef = useRef(ageOrigin)
  ageOriginRef.current = ageOrigin
  useEffect(() => {
    ageSeq.current += 1
    ageRan.current = null
    setAgeState(undefined)
    setAgeBusy(false)
    setAgeError('')
    setAgeNote('')
  }, [generation, locked, ageOrigin])
  // termsOk: reading the result records the band and closes the partner's
  // session, which must not happen before the current terms are accepted.
  // Only once the service said the check is required: an unknown policy keeps
  // the member blocked (ageGate) and is retried, without calling the age routes.
  // Not held back by the recovery after an unlock or a once sync: once the own
  // key is known age.sign signs in memory and never opens the store
  // (packages/web-member/lib/session.js), and the rest is HTTP, so a new
  // device without a certificate can have its answer ready when 'recuperando'
  // ends.
  const ageReadNow = ageReadAllowed({
    hosted: ageHosted,
    ready,
    termsOk,
    locked,
    member,
    policyKnown: agePolicyKnown,
    policyRequired: agePolicyKnown ? agePolicy.required : undefined
  })
  // The only writer of the refusals and the only sender of an age-verified
  // attestation: an answer of the service, for the member and installation
  // the request started with. The URL return, app links and peers never
  // reach it. A failed store changes nothing: the live answer already opened
  // this run, and the node verifies whatever it is handed.
  const answerAge = (state, who, origin, proof) => {
    setAgeState(state)
    const outcome = ageAnswerOutcome(state)
    if (outcome === 'deny') ageMemory.deny(who, origin)
    else if (outcome === 'clear') {
      ageMemory.clearDenial(who, origin)
      if (proof !== null && typeof proof === 'object') {
        node.request('age.proof', { verified: proof }).then(ageInfoAfterProof).catch(() => {})
      }
    }
  }
  const ageRequest = (work) => {
    const seq = ++ageSeq.current
    const gen = generationRef.current
    const who = memberRef.current
    const origin = ageOriginRef.current
    // An answer that started under another installation is dropped too.
    const stale = () => seq !== ageSeq.current || gen !== generationRef.current || who !== memberRef.current ||
      origin !== ageOriginRef.current
    setAgeBusy(true)
    setAgeError('')
    setAgeNote('')
    work(stale, who, origin).catch((err) => {
      if (stale()) return
      // The held Feira code refused: the seller's week ran out. The hook drops
      // the code and shows LIMIT_TEXT in place of "Pedir entrada".
      if (ageFeiraLimitRef.current(err)) {
        if (NATIVE_APP) setAgeInviteRefused(true)
        return
      }
      // The app drops a refused code so the paste field shows again; the web
      // keeps its stored code as it always did.
      if (dropsHeldInvite(err, NATIVE_APP)) {
        dropSignupInvite()
        dropSignupInviteCard()
        reloadCard()
      }
      if (NATIVE_APP && isInviteRefusal(err)) setAgeInviteRefused(true)
      setAgeError(ageErrorText(err) || errorText(err))
    }).finally(() => {
      if (!stale()) setAgeBusy(false)
    })
  }

  // The app's invite field on the age step: the age session needs an invite
  // when the network is by invite, and the app has no App Links, so a code
  // can only come in pasted (src/linkReturn.js invitePasteShown). The policy
  // is read once; a failed read leaves the field to a refusal from the service.
  // The web reads it too for a visitor from a Feira listing link, whose
  // "Pedir entrada" shows on this step when the network is by invite.
  const [ageInviteRequired, setAgeInviteRequired] = useState(undefined)
  const [ageInviteRefused, setAgeInviteRefused] = useState(false)
  const [, setAgeInviteTick] = useState(0)
  const ageFeiraHere = FEIRA_ENTRY.load(hostedPage === true ? '' : ageOrigin) !== null
  useEffect(() => {
    if ((!NATIVE_APP && !ageFeiraHere) || !ageHosted || !ready || ageInviteRequired !== undefined) return
    let cancelled = false
    readInvitePolicy().then(
      (p) => { if (!cancelled) setAgeInviteRequired(!!p && p.required === true) },
      () => { if (!cancelled) setAgeInviteRequired(false) }
    )
    return () => { cancelled = true }
  }, [ageHosted, ready, ageInviteRequired, ageFeiraHere])
  const ageInvitePaste = invitePasteShown({
    native: NATIVE_APP,
    required: ageInviteRequired,
    held: loadSignupInvite() !== null,
    refused: ageInviteRefused
  })
  const ageInvitePasted = () => {
    setAgeInviteRefused(false)
    setAgeError('')
    setAgeInviteTick((n) => n + 1)
    reloadCard()
  }
  useEffect(() => {
    if (!ageReadNow) return
    const key = generation + '#' + member + '#' + ageOrigin + '#' + ageCheckTick
    if (ageRan.current === key) return
    ageRan.current = key
    ageRequest(async (stale, who, origin) => {
      try {
        const { nonce } = await ageStart({ member })
        if (stale()) return
        const { signature } = await node.request('age.sign', { action: 'result', nonce })
        if (stale()) return
        const { state, proof } = await ageResult({ member, nonce, signature })
        if (!stale()) answerAge(state, who, origin, proof)
      } finally {
        // Only the current key: an older read that ends after a newer one
        // must not overwrite its mark and leave "Conferindo" with nothing in
        // flight. Not held back by stale(), which a later start would make
        // true for good.
        if (key === ageReadKeyRef.current) setAgeReadDone(key)
      }
    })
  }, [ageReadNow, generation, member, ageOrigin, ageCheckTick])
  // True only while the background read for the current key has not finished:
  // with the error cleared and no verdict (an invite pasted, the browser left
  // without a return) the screen must not stay on "Conferindo" with nothing
  // in flight. An unknown policy counts as pending: its read is retried with a
  // backoff, and the age routes cannot be used before it answers.
  const ageReadKey = generation + '#' + member + '#' + ageOrigin + '#' + ageCheckTick
  ageReadKeyRef.current = ageReadKey
  const ageReadPending = (ageReadNow && ageReadDone !== ageReadKey) || (ageHosted && !agePolicyKnown)
  const checkAge = () => setAgeCheckTick((n) => n + 1)
  // A new verification session: the service answers 'verificado' when the
  // band is already recorded, otherwise the provider's page, opened as a full
  // page navigation (it comes back with ?idade=volta).
  const startAge = () => {
    if (member === null || ageBusy) return
    ageRequest(async (stale, who, origin) => {
      const { nonce } = await ageStart({ member })
      if (stale()) return
      const { signature } = await node.request('age.sign', { action: 'session', nonce })
      if (stale()) return
      // The Feira code's paid session has its own route (src/account.js).
      const held = loadSignupInvite()
      const feira = heldIsFeira(FEIRA_ENTRY.load(feiraOrigin), held)
      const r = await ageSession({ member, nonce, signature, invite: held?.code }, { feira })
      if (stale()) return
      if (r.state === 'verificado') return answerAge('verificado', who, origin, r.proof)
      if (typeof r.url !== 'string' || !r.url.startsWith('https://')) throw new Error('serviço indisponível')
      // The app opens the provider in the system browser, which comes back
      // through varanda://idade?volta=1 (the Linking effect below).
      if (Platform.OS !== 'web') {
        setAgeNote(AGE_APP_NOTE)
        await Linking.openURL(r.url)
        return
      }
      setAgeNote(AGE_REDIRECT_TEXT)
      globalThis.location.assign(r.url)
    })
  }
  const ageShown = ageStateShown({ answered: ageState, remembered: ageRemembered })
  const ageNeeded = ageGate({ hosted: ageHosted, policy: agePolicy, state: ageShown })
  const ageClear = !ageBlocking(ageNeeded)
  // On the hosted setup only Identidade reads node.info, and the age step
  // replaces it: node.info is read here so the node's proofs can open the
  // gate. Held back like Identidade while a recovery or once sync runs
  // (node.info may open the store and preempt it).
  const ageInfoNow = ageHosted && ready && !locked && member !== null && !recovering && !onceSync &&
    !ageClear && info === null
  // A failed read is tried again after 2 s, 5 s, 15 s, then every 30 s while
  // the step still needs it (a read, so the retry is allowed), and at once
  // when the connection comes back.
  const [ageInfoTick, setAgeInfoTick] = useState(0)
  const ageInfoTries = useRef(0)
  useEffect(() => { ageInfoTries.current = 0 }, [generation])
  useEffect(() => {
    if (!ageInfoNow) return
    let cancelled = false
    let timer = null
    readInfo().then(() => {
      if (cancelled) return
      timer = setTimeout(() => setAgeInfoTick((n) => n + 1), ageInfoDelay(ageInfoTries.current))
      ageInfoTries.current += 1
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ageInfoNow, generation, readInfo, ageInfoTick])
  const ageInfoOnlineRef = useRef(node.online)
  useEffect(() => {
    const was = ageInfoOnlineRef.current
    ageInfoOnlineRef.current = node.online
    if (was !== false || node.online !== true || !ageInfoNow) return
    setAgeInfoTick((n) => n + 1)
  }, [node.online, ageInfoNow])
  // A sync run that ended may have brought the member certificate (a new
  // device): while the step still has neither proof from the node, read
  // node.info again (as Identidade does for the setup). A run that ended
  // during a recovery or once sync is read when that ends: the recovery may be
  // what brought the certificate, and nothing else would re-run this. The
  // deps re-run it mid-recovery too: return then, so node.info never preempts
  // the store (ageInfoHeld stays for when the run ends).
  const ageNoProofRef = useRef(false)
  ageNoProofRef.current = ageHosted && !ageClear && !locked && !recovering && !onceSync && ageInfo !== null &&
    ageInfo.memberCertDate == null && ageInfo.ageVerifiedDate == null
  const ageStopped = node.sync.stopped
  useEffect(() => {
    if (ageStopped === null || ageStopped === undefined) return
    if (recovering || onceSync) return
    if (!ageNoProofRef.current && !ageInfoHeld.current) return
    ageInfoHeld.current = false
    readInfo()
  }, [ageStopped, readInfo, recovering, onceSync])

  // The installation's signed since, handed to the node, which verifies it
  // and keeps it (age.proof): the app never compares against a since of its
  // own. Asked once per installation and generation (a reset clears the
  // node's copy); a failed read (undefined) or store is tried again after
  // 5 s, 15 s, then every 60 s, and at once when the connection comes back.
  // Only the latest request is applied. A live null clears a stale stored
  // since. Not held back by a recovery or once sync: age.proof is a kv write;
  // only while neither the own key nor the diary info is known yet does it
  // resolve the key as age.sign does, which may read the store once.
  const ageSinceNow = ageHosted && ready && !locked && member !== null && ageOrigin !== ''
  const ageSinceSeq = useRef(0)
  const ageSinceDone = useRef(null)
  const ageSinceTries = useRef(0)
  const [ageSinceTick, setAgeSinceTick] = useState(0)
  useEffect(() => {
    if (!ageSinceNow) return
    const origin = ageOrigin
    if (origin !== (installationOrigin() || globalThis.location?.origin || '')) return
    const key = generation + '#' + origin
    if (ageSinceDone.current === key) return
    const seq = ++ageSinceSeq.current
    const latest = () => seq === ageSinceSeq.current && generation === generationRef.current &&
      origin === ageOriginRef.current
    let cancelled = false
    let timer = null
    const retry = () => {
      if (cancelled || !latest()) return
      timer = setTimeout(() => setAgeSinceTick((n) => n + 1), agePolicyDelay(ageSinceTries.current))
      ageSinceTries.current += 1
    }
    readAgeSince().then((since) => {
      if (cancelled || !latest()) return
      if (since === undefined) return retry()
      return node.request('age.proof', { since }).then(() => {
        if (!latest()) return
        ageSinceDone.current = key
        ageSinceTries.current = 0
        return ageInfoAfterProof()
      }, retry)
    }).catch(() => {})
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ageSinceNow, generation, ageOrigin, ageSinceTick, node.request])
  const ageSinceOnlineRef = useRef(node.online)
  useEffect(() => {
    const was = ageSinceOnlineRef.current
    ageSinceOnlineRef.current = node.online
    if (was !== false || node.online !== true || !ageSinceNow) return
    if (ageSinceDone.current === generation + '#' + ageOrigin) return
    setAgeSinceTick((n) => n + 1)
  }, [node.online, ageSinceNow, generation, ageOrigin])

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

  // Back from the Google step, the return is decided by linkReturnTaker next to
  // the signup signal below (it needs step and certMissing, computed there).
  // The setup's LinkCard also drops it when it lands the certificate (onLinked),
  // since during the recovery the shell may not have seen info without one.
  const linkReturnRef = useRef(LINK_RETURN)
  const dropLinkReturn = useCallback(() => { linkReturnRef.current = false }, [])
  // Native has no ?conta= load: an auth session's result lands in the
  // Identidade card that opened it, which is still mounted (the native
  // install card is always 'none', so the signup offer needs no signal).
  const linkReturned = LINK_RETURN

  // Native: the URLs the app is opened with (Linking's initial URL and its
  // 'url' events), all untrusted. varanda://idade feeds the same path as the
  // web's ?idade= load, and the outcome is always asked of the service again;
  // invite and profile links go to their stores. varanda://conta is not a
  // return (the Google step comes back only through the auth session). A
  // link is never consent to follow or to join.
  // A state, not a ref: a group or community link that arrives while the tabs
  // already show must run the effect that opens it. It carries the
  // installation it arrived on: a key never opens on another installation.
  const [pendingLink, setPendingLink] = useState(() => CAPTURED_ENTRY !== null
    ? { kind: CAPTURED_ENTRY.kind, key: CAPTURED_ENTRY.key, origin: ageOrigin }
    : null)
  const heldUrlRef = useRef(null)
  const appUrlRef = useRef(null)
  // The installation a Feira listing entry belongs to: '' on the hosted web
  // page, as captured at load; the installation's origin in the app.
  const feiraOrigin = hostedPage === true ? '' : ageOrigin
  // "Pedir entrada" on the age step (src/useFeiraEntryStart.js): with invites
  // and the age check on, the age session refuses a visitor with no code, so
  // the Feira code is asked for here first, by a press only. Once held, the
  // ordinary age start sends it.
  const [ageFeiraNote, setAgeFeiraNote] = useState('')
  const ageFeira = useFeiraEntryStart({
    feira: { holder: FEIRA_ENTRY, origin: feiraOrigin, hold: holdFeiraCode },
    active: ageHosted && ready && !ageClear && ageFeiraHere,
    required: ageInviteRequired,
    onNote: setAgeFeiraNote
  })
  ageFeiraLimitRef.current = ageFeira.limit
  const [feiraTick, setFeiraTick] = useState(0)
  appUrlRef.current = (url) => {
    if (typeof url !== 'string') return
    const ret = parseAppReturn(url)
    if (ret !== null) {
      setAgeNote('')
      checkAge()
      return
    }
    const signup = captureSignupInvite(url)
    if (signup !== null) {
      setAgeInviteRefused(false)
      setAgeInviteTick((n) => n + 1)
      reloadCard()
    }
    const rec = captureInvite(url)
    if (rec !== null) {
      // A lookup still running for an older link is now stale: it must
      // neither forget this newer invite nor open the older profile. The
      // tick runs the attempt again for this link once that one ends.
      inviteLinks.next()
      inviteRef.current = rec
      setInvite(rec)
      setCardShown(false)
      setAcceptedHere(false)
      setInviteTick((n) => n + 1)
    }
    const link = parseAppLink(url)
    if (link !== null && (link.kind === 'grupo' || link.kind === 'comunidade')) {
      setPendingLink({ kind: link.kind, key: link.key, origin: ageOrigin })
      return
    }
    if (link !== null && link.kind === 'anuncio') {
      // The entry belongs to an installation: with none known yet, the URL
      // waits for the first one, like an App Link on a cold start.
      if (feiraOrigin === '') {
        heldUrlRef.current = url
        return
      }
      FEIRA_ENTRY.capture({ author: link.author, seq: link.seq, origin: feiraOrigin })
      setFeiraTick((n) => n + 1)
      return
    }
    if (signup === null && rec === null && link === null && waitsForInstallation(url)) {
      heldUrlRef.current = url
    }
  }
  // A cold start from an App Link can arrive before the installation loads,
  // when no https link can be told apart from another host's. Once one is
  // known the held URL is parsed again: the replay also reaches the profile
  // and convite captures, and a URL of another host is dropped (parseAppLink
  // returns null then). It cannot be held twice: waitsForInstallation is
  // false once an installation is known.
  useEffect(() => {
    if (ageOrigin === '' || heldUrlRef.current === null) return
    const url = heldUrlRef.current
    heldUrlRef.current = null
    try { appUrlRef.current(url) } catch {}
  }, [ageOrigin])
  useEffect(() => {
    if (Platform.OS === 'web') return
    const take = (url) => { try { appUrlRef.current(url) } catch {} }
    if (!initialUrlTaken) {
      initialUrlTaken = true
      Linking.getInitialURL().then(take, () => {})
    }
    const sub = Linking.addEventListener('url', (e) => take(e && e.url))
    return () => sub.remove()
  }, [])

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

  // The invite card is resolved from scratch for the screen that may show
  // it: the opening card (before the intro cards, bound to the held code)
  // or the arrival card (at 'pronto', once the code was used, bound to the
  // record's own code). Nothing is resolved for the steps in between.
  const cardStage = !setupStep && step === 'pronto' ? 'arrival' : 'open'
  // The arrival card is for someone joining with this card: it needs the
  // node to have said, on this page load and while this very card was held,
  // that the identity is not a member yet (info loaded, no member
  // certificate). A setup step alone is not that signal: it also holds while
  // info is still loading for a member. A member who was already signed in
  // when opening a card link never sees it, a replaced card starts
  // ineligible, and a load that never saw the signal fails closed: no card.
  // The signal is bound to the identity that gave it: signing into another
  // account in the same tab never inherits a newcomer's arrival card.
  const eligibleCardRef = useRef(null)
  const ownPublicKey = info !== null && typeof info.publicKey === 'string' ? info.publicKey : null
  if (cardKey !== null && ownPublicKey !== null && info.memberCert !== true) eligibleCardRef.current = { card: cardKey, key: ownPublicKey }
  const arrivalEligible = cardKey !== null && eligibleCardRef.current !== null &&
    eligibleCardRef.current.card === cardKey && eligibleCardRef.current.key === ownPublicKey
  const cardWanted = cardKey !== null && ((cardStage === 'arrival' && arrivalEligible) || (introState === 'show' && !LINK_RETURN && !AGE_RETURN))
  const [cardView, setCardView] = useState(null)
  const cardSeq = useRef(0)
  const resolveCard = useCallback((stage) => {
    const record = loadSignupInviteCard()
    return resolveInviteCard({
      record,
      heldCode: stage === 'arrival' ? (record !== null ? record.code : undefined) : loadSignupInvite()?.code,
      request: node.request,
      accountStatus: (who) => accountStatus(who, { origin: ageOrigin }),
      nodeReady: node.phase === 'ready',
      now: Date.now()
    })
  }, [node.request, node.phase, ageOrigin])
  useEffect(() => {
    const seq = ++cardSeq.current
    if (!cardWanted) {
      setCardView(null)
      return
    }
    resolveCard(cardStage).then((result) => {
      if (seq !== cardSeq.current) return
      // The store moved since the last read (a drop elsewhere, the 24 h):
      // read it again; the next resolve is for that record.
      if (result.recordId !== cardKey) return reloadCard()
      // A node that went back to connecting keeps the card already verified.
      // A card past its signed expires is not kept: the expired answer, or
      // none, takes its place.
      setCardView((v) => result.signature === 'wait' && v !== null && v.id === result.recordId && v.stage === cardStage && v.result.signature === 'ok' &&
        !cardPastExpires(v.result.card, Date.now())
        ? v
        : { id: result.recordId, stage: cardStage, result })
    }, () => {})
  }, [cardWanted, cardKey, cardStage, cardState.tick, resolveCard, generation, node.online])
  const cardRetry = cardView !== null && (cardView.result.signature === 'wait' || cardView.result.membership === 'unknown')
  const cardRetryRef = useRef(cardRetry)
  cardRetryRef.current = cardRetry
  const cardKeyRef = useRef(cardKey)
  cardKeyRef.current = cardKey
  const shownCard = cardView !== null && cardView.id === cardKey && cardView.result.card ? cardView.result.card : null
  const cardCardRef = useRef(shownCard)
  cardCardRef.current = shownCard
  // Back in the foreground: resolve again when the last answer has to be
  // retried, and read the store again when the record moved (expired,
  // replaced) so the rendered card follows it.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return
      if (cardRetryRef.current || cardRecordId(loadSignupInviteCard()) !== cardKeyRef.current ||
        (cardCardRef.current !== null && cardPastExpires(cardCardRef.current, Date.now()))) reloadCard()
    })
    return () => sub.remove()
  }, [reloadCard])
  // The record's 24 h or the card's signed expires, whichever comes first,
  // ends while the app stays open: resolve again so the card is marked
  // expired and canAttribute hides it.
  const shownExpires = shownCard !== null ? shownCard.expires : null
  useEffect(() => {
    const record = cardState.record
    if (record === null) return
    let end = record.at + CARD_RECORD_TTL_MS
    if (typeof shownExpires === 'number') end = Math.min(end, cardExpiredAt(shownExpires))
    const fire = () => {
      // A card past its signed expires is spent: drop it, or the store read
      // would hand back the same record and this timer would fire again.
      if (typeof shownExpires === 'number' && Date.now() >= cardExpiredAt(shownExpires)) dropSignupInviteCard()
      reloadCard()
    }
    const t = setTimeout(fire, Math.max(0, end - Date.now()) + 50)
    return () => clearTimeout(t)
  }, [cardState.record, shownExpires, reloadCard])
  const cardViewFor = (stage) => cardView !== null && cardView.id === cardKey && cardView.stage === stage ? cardView.result : null
  // Agora não on the opening card: hidden for this load, code and card kept.
  const [openLater, setOpenLater] = useState(false)
  const [openHow, setOpenHow] = useState(false)
  const openResult = cardViewFor('open')
  // An offline membership ('unknown') or a node not ready yet is still
  // pending; an unlinked key, a bad signature or an expired card is not a card.
  const openVerified = cardKey === null
    ? false
    : openResult === null || openResult.signature === 'wait' || (openResult.signature === 'ok' && openResult.membership === 'unknown')
      ? null
      : canAttribute(openResult)
  // The record the arrival card closed (Agora não, or both taps done):
  // dismissed even when the store refused the drop.
  const [arrivalClosed, setArrivalClosed] = useState(null)
  const arrivalResult = cardViewFor('arrival')
  const showArrival = arrivalEligible && arrivalResult !== null && typeof arrivalResult.username === 'string' && arrivalGate({
    step,
    verified: canAttribute(arrivalResult),
    linked: arrivalResult.membership === 'linked',
    dismissed: arrivalClosed === arrivalResult.recordId,
    ownKey,
    member: arrivalResult.member
  })
  const closeArrival = useCallback(() => {
    setArrivalClosed(cardKeyRef.current)
    dropSignupInviteCard()
    reloadCard()
  }, [reloadCard])
  const resolveArrival = useCallback(() => resolveCard('arrival'), [resolveCard])
  // Bound when the arrival card renders: true only while this identity and
  // this record are current, asked before each write.
  const arrivalGen = generation
  const arrivalId = arrivalResult !== null ? arrivalResult.recordId : null
  const arrivalGuard = useCallback(() => arrivalGen === generationRef.current && arrivalId !== null &&
    cardRecordId(loadSignupInviteCard()) === arrivalId, [arrivalGen, arrivalId])

  // Only the unlocked passkey key, behind the terms, age and setup gates: the
  // browser registration is read here so the note's first tap already holds
  // it, and read again when the connection returns (a read made offline has no
  // key). A lock drops the view even when Ajustes filled it before the tabs.
  const pushMember = node.hosted === true && termsOk && !setupStep && step === 'pronto' && pkStatus !== null && typeof pkStatus.publicKey === 'string' ? pkStatus.publicKey : null
  useEffect(() => { if (pushMember !== null && node.online !== false) readPush(pushMember) }, [pushMember, node.online])
  useEffect(() => { if (locked) readPush(null) }, [locked])

  // Offered once, right after a signup on this page load. LINK_RETURN alone
  // also covers an existing member linking Google from Ajustes > Conta, so the
  // signup signal is 'vinculo' with a node.info that has been read and holds no
  // certificate: while info is still null the step machine shows 'vinculo' for
  // that member too. Dismissing also quiets the top-bar note for 30 days.
  const signupRef = useRef(false)
  const certMissing = info !== null && info.memberCert !== true
  // A newcomer's return is finished by the setup's LinkCard, so it is dropped
  // on the commit the signup signal fires, before setupStep turns false, and
  // the tabs come up on A Rua with no sheet. Only a member who already held a
  // certificate (linking from Ajustes > Conta) gets that sheet, once, after
  // the unlock.
  useEffect(() => {
    const taker = linkReturnTaker({ held: linkReturnRef.current, termsOk, setupStep, step, certMissing })
    if (taker === 'none' || taker === 'wait') return
    linkReturnRef.current = false
    if (taker === 'conta') setAjustes('conta')
  }, [termsOk, setupStep, step, certMissing])
  useEffect(() => { if (linkReturned && step === 'vinculo' && certMissing) signupRef.current = true }, [linkReturned, step, certMissing])
  const [installCardOpen, setInstallCardOpen] = useState(false)
  useEffect(() => {
    if (signupRef.current && !setupStep && step === 'pronto' && install.card !== 'none') {
      signupRef.current = false
      setInstallCardOpen(true)
    }
  }, [setupStep, step, install.card])

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

  // A string, or { text, actionLabel, onAction }. A new toast replaces the
  // previous one together with its action.
  const showToast = (input) => {
    clearTimeout(toastTimer.current)
    const t = typeof input === 'string' ? { text: input } : input
    if (!t || !t.text) return setToast(null)
    const withAction = typeof t.onAction === 'function' && t.actionLabel
    setToast(withAction ? t : { text: t.text })
    toastTimer.current = setTimeout(() => setToast(null), withAction ? TOAST_ACTION_MS : TOAST_MS)
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
  const stackMotion = useStackMotion(stack)
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
    if (stackBusy()) return
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
  const openGroup = useCallback((group) => {
    pushScreen({ screen: 'grupo', key: typeof group === 'string' ? group.toLowerCase() : group, params: {} })
  }, [pushScreen])
  const openCommunity = useCallback((community, opts) => {
    pushScreen({ screen: 'comunidade', key: typeof community === 'string' ? community.toLowerCase() : community, params: opts && typeof opts.group === 'string' ? { group: opts.group.toLowerCase() } : {} })
  }, [pushScreen])
  const openCommunityInfo = useCallback((community) => {
    pushScreen({ screen: 'comunidade-info', key: typeof community === 'string' ? community.toLowerCase() : community, params: {} })
  }, [pushScreen])
  // group.seen emits no event: Grupo reports the mark so the community list
  // under it re-reads its unread counts.
  const [seenTick, setSeenTick] = useState(0)
  const bumpSeen = useCallback(() => setSeenTick((n) => n + 1), [])
  const openMember = useCallback((author, seed) => {
    const key = typeof author === 'string' ? author.toLowerCase() : author
    if (typeof ownKey === 'string' && key === ownKey.toLowerCase()) {
      clearStack()
      setTab('diario')
      return
    }
    pushScreen({ screen: 'membro', key, params: { seed: seed || null } })
  }, [pushScreen, clearStack, ownKey])
  const openPeople = useCallback((key, kind) => {
    if ((kind !== 'seguindo' && kind !== 'seguidores') || typeof key !== 'string') return
    pushScreen({ screen: kind, key: key.toLowerCase(), params: {} })
  }, [pushScreen])
  // The Momentos viewer, starting at one author's ring (hosted only: the
  // strip and the Diário rows that call it render only there).
  const openMomentos = useCallback((key) => {
    if (typeof key !== 'string') return
    pushScreen({ screen: 'momentos', key: key.toLowerCase(), params: {} })
  }, [pushScreen])
  const openTestimonials = useCallback((key) => {
    if (typeof key !== 'string') return
    pushScreen({ screen: 'depoimentos', key: key.toLowerCase(), params: {} })
  }, [pushScreen])
  const enterAvisos = useCallback(() => {
    if (tabRef.current !== 'avisos') setReturnTab(tabRef.current)
    setTab('avisos')
  }, [])
  // Back from Avisos lands on the tab it was opened from, or A Rua when that
  // tab is not in this mode's bar.
  const closeAvisos = useCallback(() => {
    const back = returnTabRef.current
    setTab(tabsFor(mode).some((t) => t.id === back) ? back : 'rua')
  }, [mode])
  // A lock, unlock or reset closes the pushed screens too.
  useEffect(() => clearStack(), [generation, locked, clearStack])
  // The seed of a page answer: Membro tells a page from a person with it.
  const pageSeed = (found) => {
    const seed = { page: true }
    if (found.closed === true) seed.closed = true
    if (typeof found.movedTo === 'string') seed.movedTo = found.movedTo
    return seed
  }
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
    let found = null
    const r = await resolveInvite({ username }, async (name) => { found = await lookupUsername(name); return found })
    // A newer tap, a lock or an identity change meanwhile drops this answer.
    if (tap !== mentionSeq.current || gen !== generationRef.current || lockedRef.current) return
    if (r.status === 'ready') openMember(r.key, found && found.kind === 'page' ? pageSeed(found) : undefined)
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

  // --- Comunidades (a hosted node: the site or the app on an installation) ---
  // Versions restart at 0 with every epoch, so what was seen is kept with its
  // epoch and compared with !==. The dot shows when a group the node follows
  // moved since the Comunidades tab (or that group) was last on screen.
  const nodeEpoch = node.epoch
  // A lock, a sign-out or another identity ends Publicar como. A socket
  // reconnect also bumps the epoch, but the same unlocked identity keeps
  // acting as its page (and the page screens keep their drafts).
  const actingIdentity = locked ? 'locked' : (typeof ownKey === 'string' ? ownKey : 'none')
  const acting = useActing()
  useEffect(() => { actingAs.reset() }, [actingIdentity])
  const [groupSeen, setGroupSeen] = useState({ epoch: nodeEpoch, map: {} })
  const seenMap = groupSeen.epoch === nodeEpoch ? groupSeen.map : {}
  const topEntry = nav.top(stack)
  // The Conversas tab lists the groups beside the private conversations.
  const groupsTab = tab === 'comunidades'
  const groupsOnScreen = mode === 'hosted' && ready && (groupsTab || (topEntry !== null && topEntry.screen === 'grupo'))
  const groupVersions = node.groupVersions || NO_VERSIONS
  useEffect(() => {
    const open = topEntry !== null && topEntry.screen === 'grupo' ? topEntry.key : null
    setGroupSeen((cur) => {
      const base = cur.epoch === nodeEpoch ? cur.map : {}
      let map = base
      if (groupsOnScreen) {
        const all = groupsTab && topEntry === null
        for (const g of Object.keys(groupVersions)) {
          if ((all || g === open) && base[g] !== groupVersions[g]) {
            if (map === base) map = { ...base }
            map[g] = groupVersions[g]
          }
        }
      }
      return map === base && cur.epoch === nodeEpoch ? cur : { epoch: nodeEpoch, map }
    })
  }, [nodeEpoch, groupsOnScreen, groupsTab, topEntry, groupVersions])
  const groupsBadge = mode === 'hosted' && !groupsOnScreen &&
    Object.keys(groupVersions).some((g) => groupVersions[g] !== (seenMap[g] || 0))

  // --- Conversas: the tab dot, the foreground pull and the push opener ---
  // dm.changed is only a hint: the dot is re-read from dm.list after every
  // dm.pull attempt (node.bumpDm), on dm.changed and when a pushed screen
  // closes. inboxUnread and requests cover every page (docs/rpc.md 5.77).
  const [dmOpenCount, setDmOpenCount] = useState(0)
  const [dmDot, setDmDot] = useState(false)
  const dmReady = mode === 'hosted' && ready && !locked
  const dmRequest = node.request
  const bumpDm = node.bumpDm
  const dmDotGen = useRef(0)
  const readDmDot = useCallback(async () => {
    const gen = ++dmDotGen.current
    try {
      const r = await dmRequest('dm.list', { folder: 'inbox', limit: 1 })
      if (gen !== dmDotGen.current) return
      setDmDot(r.inboxUnread === true || r.requests === true)
    } catch {}
  }, [dmRequest])
  // The first read waits for A Rua's first rows (or a quiet node, for a start
  // elsewhere): the dot is not worth a place in the boot chain.
  const [dmDotGate, setDmDotGate] = useState(false)
  const nodeWhenIdle = node.whenIdle
  useEffect(() => {
    if (!dmReady) {
      setDmDotGate(false)
      return
    }
    if (feedBoot.details) {
      setDmDotGate(true)
      return
    }
    if (typeof nodeWhenIdle !== 'function') return
    let alive = true
    // whenIdle answers { promise, cancel } (src/idle.js), not a promise.
    const wait = nodeWhenIdle(4000)
    wait.promise.then(() => { if (alive) setDmDotGate(true) }, () => {})
    return () => {
      alive = false
      wait.cancel()
    }
  }, [dmReady, feedBoot.details, nodeWhenIdle])
  useEffect(() => {
    if (dmReady && dmDotGate) readDmDot()
    else {
      dmDotGen.current++
      setDmDot(false)
    }
  }, [dmReady, dmDotGate, readDmDot, node.dmVersion, stackDepth])
  // --- Feira: the tab dot from saved searches (src/feiraAlerts.js) ---
  // Only the Feira screen runs the searches, when it is opened; this reads
  // the counts that run left on the device, so nothing polls here. Counts
  // are recorded only while the Feira answered as on, so a stored count
  // stands for "on" at the last opening. Same origin rule as Feira.js.
  const feiraAlertsOrigin = installationOrigin() || globalThis.location?.origin || node.accountOrigin
  const feiraOnScreen = tab === 'feira' && stackDepth === 0
  const [feiraAlerts, setFeiraAlerts] = useState(null)
  useEffect(() => {
    if (mode !== 'hosted' || !ready || locked || feiraOnScreen) return
    let live = true
    alertsStore.load(feiraAlertsOrigin).then((value) => {
      if (live) setFeiraAlerts({ epoch: nodeEpoch, origin: feiraAlertsOrigin, value })
    }, () => {})
    return () => { live = false }
  }, [mode, ready, locked, feiraOnScreen, feiraAlertsOrigin, nodeEpoch])
  const feiraBadge = mode === 'hosted' && !locked && !feiraOnScreen && feiraAlerts !== null &&
    feiraAlerts.epoch === nodeEpoch && feiraAlerts.origin === feiraAlertsOrigin &&
    alertsBadge({ node, enabled: true, searches: feiraAlerts.value.searches, counts: feiraAlerts.value.counts })
  // --- Visto em todos os aparelhos (src/seenSync.js) ---
  // The same passkey on another device marked notices, conversations or
  // groups as seen: a pass reads the encrypted seen document from the account
  // service, merges it in the browser node and writes back newer local marks.
  // Local dots paint first; a pass only clears them afterwards. Hosted only
  // and behind the same terms gate as the push opt-in: nothing runs on a
  // manual configuration, varanda-serve or the core node.
  const seenMember = mode === 'hosted' && ready && !locked && termsOk && pkStatus !== null && typeof pkStatus.publicKey === 'string'
    ? pkStatus.publicKey.toLowerCase()
    : null
  const seenMemberRef = useRef(seenMember)
  seenMemberRef.current = seenMember
  const seenOnlineRef = useRef(node.online)
  seenOnlineRef.current = node.online
  const seenRequestRef = useRef(node.request)
  seenRequestRef.current = node.request
  const groupVersionsRef = useRef(groupVersions)
  groupVersionsRef.current = groupVersions
  const nodeEpochRef = useRef(nodeEpoch)
  nodeEpochRef.current = nodeEpoch
  // Filled by Avisos: the seen tokens of rows it has loaded, per namespace.
  const avisosSeenRef = useRef({ own: [], pages: {} })
  const [remoteSeen, setRemoteSeen] = useState(null)
  const seenSchedulerRef = useRef(null)
  // The node's avisos from the last merge answer: rows it already holds are
  // not sent again and wake nothing.
  const avisosMergedRef = useRef(null)
  // Tokens a merge already received this session: never offered again.
  const avisosDeliveredRef = useRef(new Set())
  const onAvisosSeen = useCallback((namespace, tokens) => {
    if (typeof namespace !== 'string' || !Array.isArray(tokens)) return
    const { pending, fresh } = reportAvisosSeen(avisosSeenRef.current, avisosMergedRef.current, namespace, tokens, ownKey, avisosDeliveredRef.current)
    avisosSeenRef.current = pending
    // A row seen here for the first time is a local mark: the pass runs
    // within the debounce, not only at the next poll.
    if (fresh && seenSchedulerRef.current) seenSchedulerRef.current.wake('changed')
  }, [ownKey])
  useEffect(() => {
    avisosSeenRef.current = { own: [], pages: {} }
    avisosMergedRef.current = null
    avisosDeliveredRef.current = new Set()
    setRemoteSeen(null)
  }, [seenMember])
  useEffect(() => {
    if (seenMember === null) return
    const member = seenMember
    const run = async () => {
      // caughtUp describes the groups as the merge saw them: only the
      // versions known when the first merge went out are acknowledged, so a
      // post that arrives after it keeps its dot. Versions restart per node
      // epoch, so the epoch is taken with them.
      const { request, snap } = snapshotBefore(seenRequestRef.current, 'seen.merge', () => ({
        versions: groupVersionsRef.current,
        epoch: nodeEpochRef.current
      }))
      const sent = cleanAvisos(avisosSeenRef.current)
      const result = await runSeenPass({
        member,
        request,
        http: { seenStart, seenFinish },
        avisos: sent
      })
      if (seenMemberRef.current !== member) return
      if (result.avisos) {
        // The first merge stored what was sent in the node's document.
        avisosSeenRef.current = dropSent(avisosSeenRef.current, sent)
        rememberSent(avisosDeliveredRef.current, sent)
        avisosMergedRef.current = result.avisos
        setRemoteSeen(result.avisos)
      }
      if (result.dmChanged) bumpDm()
      // Another device of the passkey blocked or unblocked someone.
      if (result.blocksChanged) refreshBlocks().catch(() => {})
      if (result.groupChanged) {
        bumpSeen()
        const taken = snap.value
        setGroupSeen((cur) => ackCaughtUp(cur, result.caughtUp, taken))
      }
    }
    const scheduler = createSeenScheduler({
      run,
      canRun: () => seenMemberRef.current === member && seenOnlineRef.current !== false,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t)
    })
    seenSchedulerRef.current = scheduler
    return () => {
      scheduler.stop()
      if (seenSchedulerRef.current === scheduler) seenSchedulerRef.current = null
    }
  }, [seenMember, bumpDm, bumpSeen])
  const seenGeneration = passkey !== null ? passkey.generation : 0
  useEffect(() => {
    if (seenMember !== null && seenSchedulerRef.current) seenSchedulerRef.current.wake('unlock')
  }, [seenMember, seenGeneration])
  // The connection came back: marks made offline go out once the minimum
  // interval allows.
  const seenWasOnlineRef = useRef(node.online)
  useEffect(() => {
    const was = seenWasOnlineRef.current
    seenWasOnlineRef.current = node.online
    if (was === false && node.online !== false && seenSchedulerRef.current) seenSchedulerRef.current.wake('online')
  }, [node.online])
  const seenVisibleRef = useRef(node.visible)
  useEffect(() => {
    const was = seenVisibleRef.current
    seenVisibleRef.current = node.visible
    if (!was && node.visible && seenSchedulerRef.current) seenSchedulerRef.current.wake('visible')
  }, [node.visible])
  useEffect(() => {
    if (seenMember === null || !node.visible) return
    const t = setInterval(() => {
      if (seenSchedulerRef.current) seenSchedulerRef.current.wake('poll')
    }, NOTICES_POLL_MS)
    return () => clearInterval(t)
  }, [seenMember, node.visible])
  const seenVersionRef = useRef(node.seenVersion)
  useEffect(() => {
    if (seenVersionRef.current === node.seenVersion) return
    seenVersionRef.current = node.seenVersion
    if (seenSchedulerRef.current) seenSchedulerRef.current.wake('changed')
  }, [node.seenVersion])

  // Anyone may write to anyone (owner decision 2026-11-03), so every hosted
  // member publishes its message key once per unlocked session, without first
  // opening Conversas; dm.enable appends nothing when the key is already
  // there. One call, never repeated on failure: the next session tries again.
  const dmEnabled = useRef(false)
  useEffect(() => {
    if (!dmReady) {
      dmEnabled.current = false
      return
    }
    if (dmEnabled.current) return
    dmEnabled.current = true
    dmRequest('dm.enable', {}).catch(() => {})
  }, [dmReady, dmRequest])
  const dmWasVisible = useRef(true)
  useEffect(() => {
    const visibleNow = node.visible !== false
    if (dmReady && visibleNow && !dmWasVisible.current) {
      dmRequest('dm.pull', {}).catch(() => {}).then(() => bumpDm())
    }
    dmWasVisible.current = visibleNow
  }, [dmReady, node.visible, dmRequest, bumpDm])
  // A window that was already visible gets no visibility change, so the
  // pull the wake is for runs here too.
  useEffect(() => onDmOpen(() => {
    clearStack()
    setConvCompose(false)
    setTab('comunidades')
    setDmOpenCount((n) => n + 1)
    if (dmReady) dmRequest('dm.pull', {}).catch(() => {}).then(() => bumpDm())
  }), [clearStack, dmReady, dmRequest, bumpDm])
  // The worker shows no notice while this window is focused, so a wake that
  // arrives while locked is kept and pulled once the identity unlocks.
  const dmWakePending = useRef(false)
  useEffect(() => onDmWake(() => {
    if (!dmReady) {
      dmWakePending.current = true
      return
    }
    dmRequest('dm.pull', {}).catch(() => {}).then(() => bumpDm())
  }), [dmReady, dmRequest, bumpDm])
  useEffect(() => {
    if (!dmReady || !dmWakePending.current) return
    dmWakePending.current = false
    dmRequest('dm.pull', {}).catch(() => {}).then(() => bumpDm())
  }, [dmReady, dmRequest, bumpDm])
  // A post the person came from rides beside the stack, keyed by peer: nav.push
  // drops a push equal to the top, so the tick re-renders a DM already shown
  // and Mensagem reads the new intent as a prop. Mensagem uses one only once,
  // and only the conversation on top of the stack is handed it.
  const intentsRef = useRef(new Map())
  // A lock, an unlock or another identity drops every pending context.
  useEffect(() => { intentsRef.current.clear() }, [ownKey, nodeEpoch])
  const intentCount = useRef(0)
  const [, setIntentTick] = useState(0)
  const openMessage = useCallback((peer, options) => {
    const key = typeof peer === 'string' ? peer.toLowerCase() : peer
    if (options && options.context && typeof key === 'string') {
      intentCount.current += 1
      const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
      const intent = makeIntent({ id: intentCount.current + ':' + Date.now(), peer: key, from: own, context: options.context })
      if (validIntent(intent, own)) {
        intentsRef.current.set(key, intent)
        setIntentTick((n) => n + 1)
      }
    }
    // { draft, card } from a listing's Conversar, shown in the composer only;
    // nothing is sent until the member presses send.
    const initial = options && (typeof options.draft === 'string' || options.card) ? { draft: options.draft, card: options.card || null } : null
    pushScreen({ screen: 'mensagem', key, params: initial ? { initial } : {} })
  }, [pushScreen, ownKey])
  const intentUsed = useCallback((id) => {
    for (const [key, intent] of intentsRef.current) {
      if (intent.id === id) intentsRef.current.delete(key)
    }
  }, [])
  const openListing = useCallback((author, seq) => {
    if (typeof author !== 'string' || !Number.isSafeInteger(seq)) return
    pushScreen({ screen: 'anuncio', key: author.toLowerCase() + ':' + seq, params: {} })
  }, [pushScreen])
  // Anuncio shows Editar only to its owner (or the Página acting as it).
  const openEditListing = useCallback((listing) => {
    if (typeof listing?.author !== 'string' || !Number.isSafeInteger(listing.seq)) return
    pushScreen({ screen: 'editar-anuncio', key: listing.author.toLowerCase() + ':' + listing.seq, params: {} })
  }, [pushScreen])
  // Only the thread knows the accepted offer a rating needs (nav.js checks it).
  const openAvaliar = useCallback(({ author, seq, offer } = {}) => {
    if (typeof author !== 'string' || !Number.isSafeInteger(seq) || typeof offer !== 'string') return
    pushScreen({ screen: 'avaliar', key: author.toLowerCase() + ':' + seq, params: { offer } })
  }, [pushScreen])
  // Anunciar starts from the city the Feira remembers.
  const feiraPlaceRef = useRef(null)
  const openAnnounce = useCallback(() => {
    feiraLocation.load().then((place) => {
      feiraPlaceRef.current = place
      pushScreen({ screen: 'anunciar' })
    })
  }, [pushScreen])
  // A published listing replaces the form on the stack (same depth, so the
  // web history entries stay in step): Back never returns to a sent form.
  const showPublished = useCallback(({ answer, dest } = {}) => {
    const author = dest && dest.kind === 'page' ? dest.page : ownKey
    const seq = answer && answer.seq
    if (typeof author !== 'string' || !Number.isSafeInteger(seq)) {
      goBack()
      return
    }
    const top = nav.top(stackRef.current)
    if (!top || top.screen !== 'anunciar') return
    commitStack(nav.push(nav.pop(stackRef.current), { screen: 'anuncio', key: author.toLowerCase() + ':' + seq, params: {} }))
  }, [commitStack, goBack, ownKey])
  const openCommunities = useCallback(() => {
    pushScreen({ screen: 'comunidades' })
  }, [pushScreen])
  const openRequests = useCallback(() => {
    pushScreen({ screen: 'pedidos' })
  }, [pushScreen])
  // The Conversas top bar: the "+" opens the NovaConversa sheet (the search
  // field lives in the list). A lock, unlock or reset closes it.
  const [convCompose, setConvCompose] = useState(false)
  useEffect(() => {
    setConvCompose(false)
  }, [generation, locked])

  // --- the profile invite (src/profileLink.js) ---
  // The tabs are on screen and nothing hides them, so the follow toast (it
  // renders only in the tabs branch) and Membro are seen. !sheetOpen: on a
  // ?conta= load the shell opens Ajustes → Conta only for a member who already
  // held a certificate (never for a newcomer: the setup takes that return),
  // and that sheet would cover both. The once-sync clauses mirror the outbox
  // gate above: a member request now would preempt the recovery run.
  const atTabs = ready && setupDone && !setupStep && step === 'pronto' && !recovering && !sheetOpen && !helpOpen &&
    nav.isAuthorKey(ownKey) && !(node.sync.active && node.sync.active.once) && node.sync.starting !== true
  // A group or community link opens once the tabs are on screen and the node
  // is hosted (only a hosted node has Comunidades). It waits through a
  // reconnect, when the native node is briefly not hosted (on the hosted web
  // it is also in tab storage, src/groupLinkStore). A switch
  // to another installation drops it. On a cold start the link can arrive
  // before the saved installation loads: it then belongs to the first one
  // that does, and while no installation is known it waits.
  useEffect(() => {
    if (pendingLink === null || ageOrigin === '') return
    if (pendingLink.origin === '') {
      setPendingLink({ ...pendingLink, origin: ageOrigin })
      return
    }
    if (pendingLink.origin !== ageOrigin) {
      dropEntryLink()
      setPendingLink(null)
      return
    }
    if (!atTabs || mode !== 'hosted') return
    dropEntryLink()
    pushScreen({ screen: pendingLink.kind === 'grupo' ? 'grupo' : 'comunidade', key: pendingLink.key, params: {} })
    setPendingLink(null)
  }, [pendingLink, mode, atTabs, pushScreen, ageOrigin])
  // A Feira listing link opens once the tabs are on screen on a hosted node,
  // exactly once (consume), and only ever shows the listing. An entry of
  // another installation is dropped by load().
  useEffect(() => {
    if (hostedPage !== true && ageOrigin === '') return
    const entry = FEIRA_ENTRY.load(feiraOrigin)
    const decision = decideEntry({ entry, signedIn: atTabs, ready: mode === 'hosted' })
    if (decision.action !== 'open') return
    FEIRA_ENTRY.consume(feiraOrigin)
    dropListing()
    openListing(decision.author, decision.seq)
  }, [feiraTick, atTabs, mode, feiraOrigin, ageOrigin, openListing])
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
  // Avisos through its refresh prop, the top Conversa by a remount, and
  // Convidar pessoas through inviteNudge.
  const [avisosReload, setAvisosReload] = useState(0)
  const [threadReload, setThreadReload] = useState({ ref: null, n: 0 })
  const [inviteNudge, setInviteNudge] = useState(0)
  const inviteDrop = useInviteDrop({
    enabled: node.hosted === true && node.visible !== false && ready && !locked && pkStatus?.unlocked === true,
    member,
    request: node.request
  })
  const handleInviteShown = inviteDrop.markSeen
  const openInvites = useCallback(() => {
    setAjustes('convites')
    setInviteNudge((n) => n + 1)
  }, [])
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
    if (intent === null || typeof launchKey !== 'string') return
    // Ajustes is a sheet, so atTabs is false while it is open: a convite must
    // still refresh an open Convites now, or a lock before closing drops it.
    if (!atTabs && !(intent.kind === 'convite' && ajustes !== null)) return
    launchRef.current = null
    // A DM wake names nobody: Conversas opens for whoever is unlocked.
    if (intent.kind === 'dm') {
      requestDmOpen()
      return
    }
    // A convite names nobody: Convidar pessoas opens for whoever is unlocked.
    if (intent.kind === 'convite') {
      openInvites()
      return
    }
    if (intent.recipient !== launchKey.toLowerCase()) return
    if (intent.kind === 'follow') {
      clearStack()
      enterAvisos()
      setAvisosReload((n) => n + 1)
    } else {
      const shownNow = nav.top(stackRef.current)
      if (shownNow && shownNow.screen === 'conversa' && shownNow.key === intent.ref) {
        setThreadReload((r) => ({ ref: intent.ref, n: r.n + 1 }))
      } else {
        openThread({ ref: intent.ref })
      }
    }
  }, [launchSeq, atTabs, ajustes, launchKey, clearStack, openThread, enterAvisos, openInvites])
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
    const link = inviteLinks.current()
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
      // A newer link arrived during the lookup (native): this answer is for
      // the older one and touches nothing.
      if (!inviteLinks.isCurrent(link)) return
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
      if (!inviteLinks.isCurrent(link)) return
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
        if (helpOpenRef.current || sheetOpenRef.current) return false
        if (nav.depth(stackRef.current) === 0) {
          if (tabRef.current !== 'avisos') return false
          closeAvisos()
          return true
        }
        if (stackBusy()) return true
        commitStack(nav.pop(stackRef.current))
        return true
      })
      return () => sub.remove()
    }
    if (Platform.OS !== 'web' || typeof globalThis.addEventListener !== 'function') return
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || helpOpenRef.current || sheetOpenRef.current) return
      if (nav.depth(stackRef.current) > 0) goBack()
      else if (tabRef.current === 'avisos') closeAvisos()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [commitStack, goBack, closeAvisos])
  const openComposer = () => setComposer((c) => ({ ...c, open: true }))
  // The composer in Momento mode (the strip's own ring, 'Novo momento' in the
  // own viewer): `moment` is a counter, so every request switches it again.
  // A momento is the person's own: a page chosen in Publicar como is set
  // back to the person for this open, or Publicar would not offer Momento.
  const openMomentComposer = () => {
    clearStack()
    actingAs.me()
    setComposer((c) => ({ ...c, open: true, reply: null, quote: null, moment: (c.moment || 0) + 1 }))
  }
  const reselectTab = (id) => setScrollSignal((s) => ({ ...s, [id]: (s[id] || 0) + 1 }))
  const openAvisos = () => {
    if (tab === 'avisos') reselectTab('avisos')
    else enterAvisos()
  }
  // Side insets (landscape notch/cutout): the larger one on both sides, so
  // centred content stays centred when only one side has a cutout.
  const sidePad = Math.max(insets.left, insets.right)
  const sideEdges = { top: 'additive', bottom: 'additive', left: 'off', right: 'off' }

  // Only grows: a later step or reconnect never moves the bar back.
  const bootBar = Math.max(barRef.current, bootProgress({ phase: node.phase, step, page: feedBoot.page, details: feedBoot.details }))
  barRef.current = bootBar
  const splash = <Splash edges={sideEdges} progress={bootBar} />
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
  const gateNext = (introState === 'show' && !LINK_RETURN && !AGE_RETURN) || decision === 'needed' || decision === 'updated' || decision === 'account'
  // The 10 s patience counts only while the splash is what covers the
  // connect, never while the intro cards or the terms are on screen.
  const coveringConnect = !ready && !seen && node.phase === 'connecting' && decision !== 'loading' && introState !== 'loading' && !gateNext
  useEffect(() => {
    if (!coveringConnect) return
    if (connectingAt.current === null) connectingAt.current = Date.now()
    if (!node.canConfigure || released.current) return
    const remaining = Math.max(0, CONNECT_PATIENCE_MS - (Date.now() - connectingAt.current))
    const t = setTimeout(() => bumpSplash((n) => n + 1), remaining + 50)
    return () => clearTimeout(t)
  }, [coveringConnect, node.canConfigure])
  const loadingGate = decision === 'loading' || introState === 'loading'
  const holding = holdSplash({ phase: node.phase, elapsedMs: Date.now() - bootAt, released: released.current, gateNext })
  const showIntro = introState === 'show' && !LINK_RETURN && !AGE_RETURN
  const showTerms = decision === 'needed' || decision === 'updated' || decision === 'account'
  const connectingSplash = !ready && !seen && coverConnecting({ phase: node.phase, canConfigure: node.canConfigure, elapsedMs: connectingAt.current === null ? 0 : Date.now() - connectingAt.current, released: released.current })
  const showConexao = !ready && !seen && !connectingSplash
  const atShell = !loadingGate && !holding && !showIntro && !showTerms && !connectingSplash && !showConexao
  // The boot patience is per step and counts only while the shell is what is
  // on screen, like the connect patience: time on the intro, the terms or
  // Conexão must not spend it. SLOW_LOOKUP_MS equals the patience, so
  // 'carregando' needs this clock of its own to reach "Continuar mesmo assim".
  // Render-time ref writes, as with released.current = true.
  // Only A Rua as the first screen waits for its rows; a stacked screen (a
  // link opened at boot) or another tab shows at once.
  const feedReady = feedBoot.details || tab !== 'rua' || topEntry !== null
  const cover = coverBoot({ step, passkeyKnown: passkey === null || pkStatus !== null || !!passkey.error, age: ageNeeded, ageError, infoKnown: info !== null || infoError !== '', profileSlow: slow, feedReady })
  if (atShell && cover && !bootSettled.current && bootStepRef.current !== step) {
    bootStepRef.current = step
    bootCoverAt.current = Date.now()
  }
  const bootElapsed = atShell && bootCoverAt.current !== null ? Date.now() - bootCoverAt.current : 0
  const coveringBoot = atShell && holdBootCover({ cover, elapsedMs: bootElapsed, settled: bootSettled.current, step })
  useEffect(() => {
    if (!coveringBoot) return
    const remaining = Math.max(0, bootPatienceMs(step) - (Date.now() - bootCoverAt.current))
    const t = setTimeout(() => bumpSplash((n) => n + 1), remaining + 50)
    return () => clearTimeout(t)
  }, [coveringBoot, step])
  // Dev-only timing (src/perfMarks.js): no-ops unless the env opt-in is set.
  const splashEndMarked = useRef(false)
  useEffect(() => {
    if (!atShell || coveringBoot || splashEndMarked.current) return
    splashEndMarked.current = true
    perfMarks().mark('splash-end', feedReady ? 'feedReady' : 'patience')
  }, [atShell, coveringBoot, feedReady])
  const markedTab = useRef(tab)
  useEffect(() => {
    if (markedTab.current === tab) return
    markedTab.current = tab
    const marks = perfMarks()
    marks.mark('tab:' + tab)
    for (const line of marks.report()) console.log(line)
  }, [tab])
  useEffect(() => {
    if (!feedBoot.details) return
    for (const line of perfMarks().report()) console.log(line)
  }, [feedBoot.details])
  // Light over the Diário band (dark over the offline note above it) and over
  // Membro's band, which stays on top while offline (its note sits below the
  // band and the stack layer covers the shell's). The sheets leave the status
  // bar over the (dimmed) screen behind, so they keep it light there too.
  const light = step === 'pronto' && (
    (topEntry !== null && topEntry.screen === 'membro') ||
    (topEntry === null && tab === 'diario' && node.online !== false)
  )
  // The Momentos viewer is black in both themes: light icons while it is on
  // top, the scheme's again once it closes. Status bar only, no band colour.
  const viewerOnTop = step === 'pronto' && topEntry !== null && topEntry.screen === 'momentos'
  // Only the final return shows the band; the gates below never do.
  const bandShown = light && !loadingGate && !holding && !showIntro && !showTerms && (ready || seen)
  // Runs after ThemeProvider's layout effect, so the band colour wins and a
  // band that goes away gives back the current scheme's bg.
  useEffect(() => { applyBandMeta(bandShown, colors.bg) }, [bandShown, colors.bg])
  // The opening invite card (inviteCardCopy.js openingGate) waits under the
  // splash for at most OPEN_WAIT_MS, counted from when the intro cards would
  // show. Once the intro cards have shown the splash never comes back for
  // it, and a card verified later takes their place.
  const openWaitAt = useRef(null)
  const introRendered = useRef(false)
  const introDue = showIntro && !loadingGate && !holding
  if (introDue && openWaitAt.current === null) openWaitAt.current = Date.now()
  let opening = openingGate({
    introShow: introDue,
    linkReturn: LINK_RETURN,
    ageReturn: AGE_RETURN,
    card: cardKey !== null,
    verified: openVerified,
    waitedMs: openWaitAt.current === null ? 0 : Date.now() - openWaitAt.current,
    dismissed: openLater
  })
  if (opening === 'wait' && introRendered.current) opening = 'none'
  useEffect(() => {
    if (opening !== 'wait') return
    const t = setTimeout(() => bumpSplash((n) => n + 1), Math.max(0, OPEN_WAIT_MS - (Date.now() - openWaitAt.current)) + 50)
    return () => clearTimeout(t)
  }, [opening])
  // The same root View with the Splash at child 0 is what React preserves
  // across these returns and the final one, so the chair animation does not
  // replay and, on the web, the Splash unmount that removes
  // #varanda-pre-splash happens only when the real screen is ready.
  if (loadingGate || holding || opening === 'wait') return <View style={[styles.root, SPLASH_WRAP, { paddingHorizontal: sidePad }]}>{splash}</View>
  if (opening === 'card' && openResult !== null) {
    // Como funciona: the intro cards, then back to the card; only Entrar
    // marks them seen.
    if (openHow) return <Introducao key='how' onDone={() => setOpenHow(false)} sidePad={sidePad} edges={sideEdges} />
    return (
      <InviteCardOpen
        card={openResult.card}
        username={openResult.username}
        expiryText={expiryLine(openResult.card.expires, Date.now())}
        onEnter={() => intro.markSeen()}
        onHow={() => setOpenHow(true)}
        onLater={() => setOpenLater(true)}
        sidePad={sidePad}
        edges={sideEdges}
      />
    )
  }
  if (showIntro) {
    introRendered.current = true
    return <Introducao key='intro' onDone={() => intro.markSeen()} sidePad={sidePad} edges={sideEdges} />
  }
  if (deletedState !== null && member !== null && passkey !== null) {
    const erase = async () => {
      const key = member
      if (!outbox.forgetAuthor(key)) throw new Error('não foi possível apagar as publicações que aguardam envio neste aparelho')
      if ((await loadDeletionReceipt()) === null) await saveDeletionReceipt(newReceipt(key, Date.now()))
      await passkey.reset()
      dropTermsAndSync(key)
    }
    return (
      <SafeAreaView style={[styles.flex, { paddingHorizontal: sidePad }]} edges={sideEdges}>
        <ContaExcluida state={deletedState} onErase={erase} />
        <StatusBar style={statusBarStyle(scheme)} />
      </SafeAreaView>
    )
  }
  if (showTerms) {
    return (
      <SafeAreaView style={[styles.flex, { paddingHorizontal: sidePad }]} edges={sideEdges}>
        <Termos gate reason={decision} version={LEGAL_VERSION} onAccept={() => terms.accept(member)} />
        <StatusBar style={statusBarStyle(scheme)} />
      </SafeAreaView>
    )
  }

  if (!ready && !seen) {
    // The splash covers loading and connecting, also on the hosted page.
    // A failure or 10 s connecting on a configurable node reveals Conectar;
    // later retries stay there so its local state survives.
    if (connectingSplash) return <View style={[styles.root, SPLASH_WRAP, { paddingHorizontal: sidePad }]}>{splash}</View>
    released.current = true
    return (
      <SafeAreaView style={[styles.flex, { paddingHorizontal: sidePad }]} edges={sideEdges}>
        <Conexao />
        <StatusBar style={statusBarStyle(scheme)} />
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
      // The first wait for the result stays under the splash (coverBoot); the
      // busy spinner remains for a recheck, or for a patience reveal, on an
      // Idade already on screen.
      body = (
        <Idade
          state={ageShown}
          busy={ageBusy || (ageShown === undefined && !ageError && ageReadPending)}
          error={ageError}
          note={ageNote}
          offline={node.online === false}
          onStart={startAge}
          onCheck={checkAge}
          invitePaste={ageInvitePaste}
          onInvitePasted={ageInvitePasted}
          feiraEntry={ageFeiraHere ? { offer: ageFeira.offer, busy: ageFeira.busy, tried: ageFeira.tried, onPress: ageFeira.press, note: ageFeiraNote } : null}
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
            link: buildProfileUrl({ origin: installationOrigin() || globalThis.location?.origin || null, username: invite.username, publicKey: invite.key }),
            onDismiss: forgetInvite
          }
        : null
      // A group or community link waiting for the sign-in: announced only,
      // never joined. A pending profile invite wins even while its card waits
      // (passkey status unknown, ceremony running), so the two never flash.
      const entryProp = invite === null && pendingLink !== null && (pendingLink.origin === '' || pendingLink.origin === ageOrigin)
        ? {
            text: entryCardText(pendingLink.kind),
            openText: ENTRY_OPEN_TEXT,
            labels: ENTRY_LINK_LABELS,
            link: ageOrigin !== '' && entryPath(pendingLink) !== null ? ageOrigin + entryPath(pendingLink) : null,
            onDismiss: () => { dropEntryLink(); setPendingLink(null) }
          }
        : null
      body = <Identidade active={ready} embedded setup step={step} index={index} total={total} onInfo={takeInfo} onLinked={dropLinkReturn} onInviteChanged={reloadCard} invite={inviteProp || entryProp} feira={{ holder: FEIRA_ENTRY, origin: feiraOrigin, hold: holdFeiraCode }} />
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
        <ExclusaoRecibo />
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
    // The tabs stay mounted (drafts and scroll survive a tab change);
    // `active` makes a screen reload its data when it is shown, and again
    // when the connection comes back.
    const on = (id) => tab === id && ready
    const shown = (id) => (tab === id ? styles.flex : styles.hidden)
    const stacked = nav.depth(stack) > 0
    // The black Momentos viewer slides out over the tabs on close: the tab bar
    // and the publish button wait for the end of its pop, or they show over
    // the black for the whole slide.
    const leavingEntry = stackMotion.leaving && stackMotion.leaving.entry && stackMotion.leaving.index >= nav.depth(stack) ? stackMotion.leaving.entry : null
    const viewerLeaving = leavingEntry !== null && leavingEntry.screen === 'momentos'
    const barsHidden = stacked || viewerLeaving
    const fabShown = !viewerLeaving && showPostButton({ tab, screen: stacked ? nav.top(stack).screen : null })
    const tabActions = <TopActions key={tab} help={HELP[tab === 'comunidades' ? 'conversas' : tab]} onAvisos={mode === 'hosted' ? openAvisos : undefined} avisosNew={avisosNew} avisosActive={tab === 'avisos'} />
    // Conversas puts its "+" before help and the bell (the WhatsApp header);
    // its search is a field above the chips, not a header action.
    const topRight = stacked
      ? null
      : tab === 'comunidades'
        ? [
            { icon: 'plus', label: 'nova conversa', onPress: () => setConvCompose(true) },
            tabActions
          ]
        : tabActions
    // The invite note sits above the other notes, so it takes the top inset on
    // Diário and the note under it does not.
    const inviteNoteShown = !!(inviteDrop.note && atTabs && ajustes !== 'convites' && !stacked)
    // The Diário tab's avatar: from the profiles cache, like the composer's.
    const tabMe = typeof ownKey === 'string'
      ? { name: ownProfile ? (ownProfile.name || ownProfile.username || null) : null, publicKey: ownKey, picture: ownProfile ? ownProfile.avatar : undefined }
      : null
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
      onMessage: openMessage,
      onOpenCommunity: openCommunity,
      onDeletedPost: deletedPost,
      onOpenPageSettings: pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) ? (key) => pushScreen({ screen: 'paginaajustes', key }) : undefined,
      onOpenPeople: openPeople,
      onOpenTestimonials: openTestimonials,
      onOpenListings: node.hosted === true ? (author) => pushScreen({ screen: 'anuncios', key: author }) : undefined
    }
    // Pushed screens, plus the one sliding out after a pop under its old index
    // (and key), so it stays mounted until StackLayer says it has left. Both
    // go through one stackEntries list: a separate sibling would remount it.
    const renderStackEntry = (entry, i) => {
      if (entry.screen === 'grupo' || entry.screen === 'comunidade' || entry.screen === 'comunidade-info') {
        // Keyed by the node epoch: a lock, unlock or identity change
        // remounts the screen, so late answers from before are dropped.
        return (
          <StackLayer key={i + ':' + entry.screen + ':' + entry.key + ':' + nodeEpoch} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            {entry.screen === 'grupo'
              ? <Grupo group={entry.key} isTop={i === stack.length - 1} onBack={goBack} onOpenCommunity={openCommunity} onOpenMember={openMember} onOpenMention={mentionHandler} onReport={setReport} onSeen={bumpSeen} onMessage={openMessage} />
              : entry.screen === 'comunidade-info'
                ? <ComunidadeInfo community={entry.key} onBack={goBack} onOpenMember={openMember} onMessage={openMessage} />
                : <Comunidade community={entry.key} afterGroup={entry.params.group || null} isTop={i === stack.length - 1} seenTick={seenTick} onBack={goBack} onOpenGroup={openGroup} onOpenInfo={openCommunityInfo} />}
          </StackLayer>
        )
      }
      if (entry.screen === 'comunidades') {
        return (
          <StackLayer key={i + ':comunidades:' + nodeEpoch} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            <Comunidades onBack={goBack} onOpenGroup={openGroup} onOpenCommunity={openCommunity} />
          </StackLayer>
        )
      }
      if (entry.screen === 'depoimentos') {
        return (
          <StackLayer key={i + ':depoimentos:' + entry.key + ':' + nodeEpoch} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            <Depoimentos entry={entry} ownKey={ownKey} onBack={goBack} onOpenMember={openMember} onReport={setReport} />
          </StackLayer>
        )
      }
      if (entry.screen === 'momentos') {
        return (
          <StackLayer key={i + ':momentos:' + entry.key + ':' + nodeEpoch} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            <Momentos entry={entry} ownKey={ownKey} isTop={i === stack.length - 1} onBack={goBack} onOpenMember={openMember} onMessage={openMessage} onCreate={openMomentComposer} />
          </StackLayer>
        )
      }
      if (entry.screen === 'pedidos') {
        return (
          <StackLayer key={i + ':pedidos:' + nodeEpoch} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            <Mensagens onBack={goBack} onOpenThread={openMessage} />
          </StackLayer>
        )
      }
      if (entry.screen === 'mensagem') {
        return (
          <StackLayer key={i + ':mensagem:' + entry.key + ':' + nodeEpoch} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            <Mensagem peer={entry.key} intent={i === stack.length - 1 ? intentsRef.current.get(entry.key) : undefined} onIntentUsed={intentUsed} initial={entry.params.initial || undefined} isTop={i === stack.length - 1} onBack={goBack} onOpenMember={openMember} onOpenMention={mentionHandler} onReport={setReport} onOpenInvite={(link) => link.kind === 'grupo' ? openGroup(link.key) : openCommunity(link.key)} onOpenListing={openListing} onAvaliar={openAvaliar} />
          </StackLayer>
        )
      }
      // Feira screens, keyed by who acts: a lock, unlock or a switch to a
      // Página remounts them, so a late answer never lands on the other one.
      if (entry.screen === 'anuncio') {
        const at = entry.key.lastIndexOf(':')
        const actingPage = pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) && acting.kind === 'page' ? acting.key : null
        return (
          <StackLayer key={i + ':anuncio:' + entry.key + ':' + actingIdentity + ':' + (actingPage || '') + ':' + nodeEpoch} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            <Anuncio
              author={entry.key.slice(0, at)}
              seq={Number(entry.key.slice(at + 1))}
              me={ownKey}
              actingPage={actingPage}
              onBack={goBack}
              onConversar={({ peer, draft, card }) => openMessage(peer, { draft, card })}
              onDenunciar={setReport}
              onOpenAuthor={openMember}
              onDeleted={goBack}
              onEditar={openEditListing}
              refresh={listingRefresh}
            />
          </StackLayer>
        )
      }
      // Both go back on success: the listing (or the thread) below re-reads.
      if (entry.screen === 'editar-anuncio' || entry.screen === 'avaliar') {
        const at = entry.key.lastIndexOf(':')
        const author = entry.key.slice(0, at)
        const seq = Number(entry.key.slice(at + 1))
        const actingPage = pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) && acting.kind === 'page' ? acting.key : null
        return (
          <StackLayer key={i + ':' + entry.screen + ':' + entry.key + ':' + actingIdentity + ':' + (actingPage || '') + ':' + nodeEpoch} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            {entry.screen === 'editar-anuncio'
              ? <AnuncioEditar author={author} seq={seq} me={ownKey} actingPage={actingPage} onBack={goBack} onSaved={() => { setListingRefresh((n) => n + 1); goBack() }} />
              : <Avaliar author={author} seq={seq} offer={entry.params.offer} me={ownKey} actingPage={actingPage} onBack={goBack} onRated={goBack} />}
          </StackLayer>
        )
      }
      if (entry.screen === 'anuncios') {
        return (
          <StackLayer key={i + ':anuncios:' + entry.key + ':' + nodeEpoch} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            <View style={[styles.shell, wide && styles.shellWide]}>
              <TopBar title='Anúncios' onBack={goBack} />
              <Feira
                author={entry.key}
                active={i === stack.length - 1}
                ownKey={ownKey}
                origin={installationOrigin()}
                locationStore={feiraLocation}
                onOpenListing={({ author, seq } = {}) => openListing(author, seq)}
              />
            </View>
          </StackLayer>
        )
      }
      if (entry.screen === 'anunciar') {
        return (
          <StackLayer key={i + ':anunciar:' + actingIdentity} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            <Anunciar initialPlace={feiraPlaceRef.current} onBack={goBack} onPublished={showPublished} />
          </StackLayer>
        )
      }
      // The own following list keeps unfollow and the legacy local
      // follows card; every other list is the public read-only one.
      if (entry.screen === 'seguindo' && entry.key === ownKey) {
        return (
          <StackLayer key={i + ':seguindo:' + entry.key + ':' + nodeEpoch} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            <Seguindo
              active={ready}
              entry={entry}
              ownKey={ownKey}
              onBack={goBack}
              onReport={setReport}
              onFollowsChanged={followsChanged}
              onOpenMember={openMember}
              onToast={showToast}
              followsTick={version}
              isTop={i === stack.length - 1}
            />
          </StackLayer>
        )
      }
      // No pagesOn guard: a reconnect clears accountOrigin until
      // node.info answers, and a page screen must never fall through
      // to Membro. Each renders its own 'Disponível em breve.'.
      if (entry.screen === 'paginas' || entry.screen === 'novapagina' || entry.screen === 'paginaajustes') {
        const top = i === stack.length - 1
        return (
          <StackLayer key={i + ':' + entry.screen + ':' + (entry.key || '') + ':' + actingIdentity} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            {entry.screen === 'paginas'
              ? <Paginas active={top} onBack={goBack} onNewPage={() => pushScreen({ screen: 'novapagina' })} onOpenPage={(key, row) => openMember(key, { page: true, closed: !!(row && row.closed), movedTo: row && typeof row.movedTo === 'string' ? row.movedTo : null })} onChanged={followsChanged} />
              : entry.screen === 'novapagina'
                ? <NovaPagina onBack={goBack} onCreated={(pageKey) => openMember(pageKey, { page: true })} />
                : <PaginaAjustes entry={entry} onBack={goBack} onChanged={followsChanged} onOpenMember={openMember} />}
          </StackLayer>
        )
      }
      if (entry.screen === 'seguindo' || entry.screen === 'seguidores') {
        return (
          <StackLayer key={i + ':' + entry.screen + ':' + entry.key + ':' + nodeEpoch} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
            <Pessoas
              entry={entry}
              ownKey={ownKey}
              isTop={i === stack.length - 1}
              active={ready}
              onBack={goBack}
              onOpenMember={openMember}
              onFollowsChanged={followsChanged}
              onToast={showToast}
            />
          </StackLayer>
        )
      }
      const Screen = entry.screen === 'conversa' ? Conversa : entry.screen === 'curtidas' ? Curtidas : Membro
      return (
        <StackLayer key={i + ':' + entry.screen + ':' + entry.key + (entry.screen === 'conversa' && entry.key === threadReload.ref ? ':' + threadReload.n : '')} motion={stackMotion} index={i} entry={entry} onPop={goBack}>
          <Screen entry={entry} {...screenProps} />
        </StackLayer>
      )
    }
    content = (
      <View style={[styles.shell, wide && styles.shellWide]}>
        {tab !== 'diario'
          ? (
            <TopBar
              title={TAB_TITLES[tab]}
              onBack={tab === 'avisos' && !stacked ? closeAvisos : undefined}
              right={topRight}
            />
            )
          : null}
        <OfflineNote inset={tab === 'diario'} />
        {showArrival
          ? (
            <InviteArrival
              key={arrivalResult.recordId + ':' + generation}
              result={arrivalResult}
              request={node.request}
              resolve={resolveArrival}
              guard={arrivalGuard}
              onStale={reloadCard}
              onFollowed={followsChanged}
              onLater={closeArrival}
              onDone={closeArrival}
            />
            )
          : null}
        {scheduledDeletion !== null
          ? <DeletionNote scheduled={scheduledDeletion} onOpen={() => setAjustes('excluir')} inset={tab === 'diario' && node.online !== false} />
          : null}
        {inviteNoteShown
          ? <InviteDropNote record={inviteDrop.note} onShown={handleInviteShown} onOpen={() => { inviteDrop.dismiss(); openInvites() }} inset={tab === 'diario' && node.online !== false} />
          : null}
        {updateReady && !updateDismissed
          ? <UpdateNote onUpdate={() => { try { if (Platform.OS === 'web') window.location.reload() } catch {} }} onClose={() => setUpdateDismissed(true)} inset={tab === 'diario' && node.online !== false && !inviteNoteShown} />
          : installCardOpen && install.card !== 'none'
            ? <InstallCard kind={install.card} inset={tab === 'diario' && node.online !== false && !inviteNoteShown} onInstall={() => { install.promptInstall(); setInstallCardOpen(false) }} onClose={() => { setInstallCardOpen(false); install.dismissInstall() }} />
            : install.note !== 'none'
              ? <InstallNote kind={install.note} onInstall={() => { install.promptInstall() }} onClose={() => { install.dismissInstall() }} inset={tab === 'diario' && node.online !== false && !inviteNoteShown} />
              : push.note === 'offer' && pushMember !== null && push.member === pushMember ? <PushNote text={push.error || undefined} pending={push.pending} onEnable={() => { push.activatePush({ node, member: pushMember }) }} onClose={() => { push.dismissPush() }} inset={tab === 'diario' && node.online !== false && !inviteNoteShown} /> : null}
        <View style={styles.flex}>
          <View style={shown('rua')}>
            <ARua
              onBoot={onFeedBoot}
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
              onMessage={openMessage}
              onOpenMomentos={openMomentos}
              onCreateMoment={openMomentComposer}
              ownKey={ownKey}
              scrollToTop={scrollSignal.rua}
              followCount={followCount}
              onFollowSomeone={() => {
                setTab('busca')
                setBuscaPane((n) => n + 1)
              }}
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
          <View style={shown('busca')}>
            <BuscaGlobal
              active={on('busca')}
              refresh={version}
              paneRequest={buscaPane}
              ownKey={ownKey}
              scrollToTop={scrollSignal.busca}
              onOpenMember={openMember}
              onFollowsChanged={followsChanged}
              onToast={showToast}
              onReply={startReply}
              onReport={setReport}
              onQuote={startQuote}
              onOpenThread={openThread}
              onOpenMention={mentionHandler}
              onOpenEngagers={openEngagers}
            />
          </View>
          {/* Not a tab: kept mounted so its poll lights the bell's dot. */}
          <View style={shown('avisos')}>
            <Avisos
              active={on('avisos')}
              refresh={version + avisosReload}
              ownKey={ownKey}
              onOpenThread={openThread}
              onOpenMember={openMember}
              scrollToTop={scrollSignal.avisos}
              onFollowsChanged={followsChanged}
              onToast={showToast}
              onBadge={setAvisosNew}
              onSeenState={onAvisosSeen}
              remoteSeen={remoteSeen}
            />
          </View>
          {mode === 'hosted'
            ? (
              <View style={shown('comunidades')}>
                <Conversas
                  key={'g' + nodeEpoch}
                  active={on('comunidades') && !stacked}
                  onOpenGroup={openGroup}
                  onOpenCommunity={openCommunity}
                  onOpenThread={openMessage}
                  onOpenCommunities={openCommunities}
                  onOpenRequests={openRequests}
                  showInbox={dmOpenCount}
                  seenTick={seenTick}
                  composing={convCompose}
                  onComposing={setConvCompose}
                />
              </View>
              )
            : null}
          {mode === 'hosted'
            ? (
              <View style={shown('feira')}>
                <Feira
                  key={'f' + nodeEpoch}
                  active={on('feira') && !stacked}
                  ownKey={ownKey}
                  origin={installationOrigin()}
                  locationStore={feiraLocation}
                  onOpenListing={({ author, seq } = {}) => openListing(author, seq)}
                  onAnnounce={openAnnounce}
                  scrollToTop={scrollSignal.feira}
                />
              </View>
              )
            : null}
          <View style={shown('diario')}>
            <Diario
              onDeletedPost={deletedPost}
              active={on('diario')}
              refresh={version}
              onSettings={setAjustes}
              onToast={showToast}
              onReport={setReport}
              onReply={startReply}
              onPublish={openComposer}
              onMessage={openMessage}
              onOpenThread={openThread}
              onOpenEngagers={openEngagers}
              onOpenMember={openMember}
              onOpenMention={mentionHandler}
              onQuote={startQuote}
              onOpenCommunity={openCommunity}
              ownKey={ownKey}
              scrollToTop={scrollSignal.diario}
              onAvisos={mode === 'hosted' ? openAvisos : undefined}
              avisosNew={avisosNew}
              onOpenPeople={openPeople}
              onOpenTestimonials={openTestimonials}
              onOpenMomentos={openMomentos}
            />
          </View>
        </View>
        {stacked || stackMotion.leaving
          ? (
            <View style={styles.layer} pointerEvents='box-none'>
              {stackEntries(stack, stackMotion.leaving).map(({ entry, index }) => renderStackEntry(entry, index))}
            </View>
            )
          : null}
        {fabShown ? <Fab onPress={openComposer} /> : null}
        {/* After the Fab, and above it when it shows: a long toast wraps
            upward and must never sit under the button. */}
        {toast
          ? (
            <View style={[styles.toast, { bottom: fabShown ? insets.bottom + layout.tabBar + layout.fabAboveTabs + layout.fabSize + 12 : (barsHidden ? 0 : layout.tabBar) + insets.bottom + 12 }]} pointerEvents='box-none'>
              {/* Only the action takes touches: under box-none the label would
                  otherwise swallow taps meant for the screen below. */}
              <View pointerEvents='none' style={styles.toastLabel}>
                <Text style={styles.toastText} accessibilityRole='alert'>{toast.text}</Text>
              </View>
              {toast.onAction
                ? (
                  <Pressable
                    onPress={() => { clearTimeout(toastTimer.current); setToast(null); toast.onAction() }}
                    accessibilityRole='button'
                    accessibilityLabel={toast.actionLabel}
                    hitSlop={8}
                    style={styles.toastAction}
                  >
                    <Text style={styles.toastActionText}>{toast.actionLabel}</Text>
                  </Pressable>
                  )
                : null}
            </View>
            )
          : null}
        {/* Avisos is not a tab: the bar keeps the tab it was opened from, and that tab's icon closes it. */}
        {barsHidden ? null : <TabBar current={tab === 'avisos' ? returnTab : tab} onSelect={setTab} onReselect={tab === 'avisos' ? closeAvisos : reselectTab} badges={{ comunidades: groupsBadge || dmDot, feira: feiraBadge }} tabs={tabsFor(mode)} me={tabMe} />}
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

  // Set only past the early returns, so the intro, the terms and Conexão do
  // not count as the first screen; a patience expiry latches too.
  if (!coveringBoot) bootSettled.current = true
  // Side insets are applied once here (sidePad); top and bottom by each bar;
  // Modal content (sheets, photo viewer) pads itself. The wrapper is
  // permanent: a conditional one would remount Identidade at the reveal.
  return (
    <View style={[styles.root, coveringBoot && SPLASH_WRAP, { paddingHorizontal: sidePad }]}>
      {coveringBoot ? splash : null}
      <View style={coveringBoot ? styles.hidden : styles.flex}>{content}</View>
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
          momentRequest={composer.moment || 0}
          me={me}
          onClose={() => setComposer((c) => ({ ...c, open: false }))}
          onClearReply={() => setComposer((c) => ({ ...c, reply: null }))}
          onClearQuote={() => setComposer((c) => ({ ...c, quote: null }))}
          onPublished={(kind, sentRef) => {
            // A momento touches no post state: Publicar already told the
            // Momentos readers (momentsChanged).
            if (kind === 'moment') {
              setComposer((c) => ({ ...c, open: false }))
              return showToast('momento publicado')
            }
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
      <BlockSheet onToast={showToast} />
      <Denunciar
        open={report !== null}
        target={report}
        onClose={() => setReport(null)}
        onSent={(text) => {
          setReport(null)
          showToast(text)
        }}
      />
      <Ajustes key={locked ? 'locked' : 'open'} screen={ajustes} onNavigate={setAjustes} onClose={() => setAjustes(null)} onInfo={ajustesInfo} termsInfo={termsInfo} onTermsReset={dropTermsAndSync} scheduledDeletion={scheduledDeletion} onDeletionChanged={refreshAccount} inviteNudge={inviteNudge} onOpenPaginas={pagesOn({ hosted: node.hosted, accountOrigin: node.accountOrigin }) ? () => pushScreen({ screen: 'paginas' }) : undefined} />
      {/* Mounted after the splash, so it wins: while the boot cover shows it
          follows the splash, which stays cream on native (Splash.js). */}
      <StatusBar style={coveringBoot ? statusBarStyle(Platform.OS === 'web' ? scheme : 'light') : statusBarStyle(scheme, { overBand: light || viewerOnTop })} />
    </View>
  )
}

export default function App () {
  useEffect(() => { loadIcons().catch(() => {}) }, [])
  // The gate build never mounts Splash, which is what normally removes the overlay.
  useEffect(() => {
    if (!GATE_URL || typeof document === 'undefined') return
    const shell = document.getElementById('varanda-pre-splash')
    if (shell) shell.remove()
  }, [])
  if (GATE_URL) {
    const GateScreen = require('./src/gate/GateScreen').default
    return (
      <SafeAreaProvider>
        <ThemeProvider>
          <GateScreen url={GATE_URL} />
        </ThemeProvider>
      </SafeAreaProvider>
    )
  }
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <NodeProvider>
          <NamesProvider>
            <BlocksProvider>
              <OutboxProvider>
                <Member />
              </OutboxProvider>
            </BlocksProvider>
          </NamesProvider>
        </NodeProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1, backgroundColor: colors.bg },
  hidden: { display: 'none' },
  // Clear: each StackLayer paints its own background, so a slide shows the
  // screen (or tab) under it.
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 8 },
  shell: { flex: 1, width: '100%', maxWidth: layout.column, alignSelf: 'center', backgroundColor: colors.bg },
  shellWide: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.line },
  setupBody: { padding: 16, gap: 12 },
  link: { alignItems: 'center', paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.bg },
  linkText: { fontSize: 15, fontWeight: '600', color: colors.accent },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    // A long text wraps inside the screen instead of running off its edge.
    maxWidth: '92%',
    backgroundColor: colors.toastBg,
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center'
  },
  toastLabel: { flexShrink: 1 },
  toastText: { ...type.counter, color: colors.toastInk },
  toastAction: { marginLeft: 8 },
  toastActionText: { ...type.counter, color: colors.toastInk, fontWeight: '800' }
})
