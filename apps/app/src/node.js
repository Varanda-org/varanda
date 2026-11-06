/* global navigator, __DEV__ */

// The node connection of the app: starts or connects, keeps the phase, the
// sync state (fed by the node's events, so no event is lost while another tab
// is shown; `sync.stopped` carries the local time `at` it arrived, and
// `sync.starting` is true while a sync.start request is in flight) and hands
// the screens one `request` function.
//
// `passkey` (the browser node and the native web kind, src/client/webnode;
// null for the native core kind and varanda-serve): the node's passkey identity. `status` is the last
// identity.status() (read before the phase becomes 'ready' and after every
// unlock, complete, lock and reset; null until read), `error` the text of a
// failed read, `generation` is bumped when the unlocked identity may have
// changed (the shell drops its node.info then). unlock(opts) and complete()
// call the handle synchronously, so the WebAuthn ceremony stays inside the
// click that triggered it: never await anything before calling them.
// signOut() locks and forgets the session this browser keeps (the handle's
// identity.signOut(); `lock` stays for compatibility and keeps it). The status
// carries `resumed`: true when the identity was unlocked at load from that
// kept session, without a ceremony. A resume is an unlock without a click: no
// recovery runs for it unless the diary still lacks its member certificate
// (then the same recovery as after a ceremony, under recoveryPolicy.js).
// Recovery entries (docs/rpc.md 5.90 to 5.94): an unlock, complete() or
// unlockWithCode(code) that opens only a recovery entry is finished here
// (resolveWrapped: the account service's sealed root, then unlockWrapped), so
// the caller sees an install result, { needsPasskey: true } (a code: the
// screen then calls finishRecovery() in a press) or a fixed pt-BR error.
// addPasskey(), bindPasskey({ credentialId, userId }), makeRecoveryCode() and
// cancelRecovery() pass through and re-read the status; addPasskey and
// finishRecovery run a ceremony, so they are called synchronously too.
// `recovering` is true from an unlock until the once sync that follows it
// (recover()) has ended: one shared flag, so no screen sends a member request
// meanwhile (it would preempt that run, docs/rpc.md 6.1). A run preempted
// anyway is started once more if the certificate is still missing. The
// recovery run blocks the screens only when it has to (recoveryPolicy.js): a
// diary that already holds its member certificate, or a browser that says it
// is offline, ends the recovery at once without any sync request, so the
// local tabs open immediately; going offline during a recovery ends it too,
// and stops its run (it cannot reach the seeder, and Identidade holds its
// reads while a once run is active).
//
// `online` (web) is the browser's network hint (online.web.js; always true on
// native). `visible` is the page visibility on web; on native it follows
// AppState only while the node is hosted (the web kind), and is always true
// otherwise, because the core kind's worklet suspends its session in Bare.
// `hostedSource` is where the hosted configuration came from: 'live'
// (the installation answered), 'remembered' (the installation did not answer
// and the last valid configuration of this origin is used) or null.
//
// `legacyFollows` (browser node only, unlocked, handle has `follows`; null
// otherwise): `{ keys, confirm(keys) }`. The provider calls the handle's
// follows.legacy() itself, once per unlocked connection and passkey generation
// (it marks a device done when nothing is left, so it cannot wait for a
// screen); `keys` is null until it answered (or when it failed: silent, the
// next unlock retries), else the string[] still to confirm. confirm(keys) ->
// follows.confirmLegacy(keys) -> { published }; a success clears `keys` to []
// and bumps `followsVersion`.
// `media` (browser node only, while unlocked; null otherwise): `{ upload(args)
// }`, a pass-through to the handle's media.upload({ bytes, mime, width,
// height, sealed?, onProgress }) -> Promise<descriptor or private item>; the
// caller shows its errors (errorText). When the handle has them, also the
// chat media calls (client/webnode.native.js, client/browser.js mediaOf):
// putDm(args), read(ref), forgetReadFile(name), clearReadFiles(); a missing
// one means that capability is absent.
//
// `followsVersion` is bumped once per `follows.changed` event (the follows
// of the own diary changed, possibly on another device) and `followCount` is
// that event's `count` (null until one arrived on this connection): the
// screens reload what depends on the follows.
// `groupVersions` maps each group to a version bumped per groups.changed.
// `getGroupVersion(group)` reads it (0 until the first event). Screens can
// compare their last read's version to refresh or show a dot. Versions
// restart at 0 with every epoch (connect, close, lock, unlock, signOut), so
// screens compare with !== and key what they remember by epoch.
//
// Sync is automatic. The APP owns the intent (`setAutoSync(wanted)`, decided
// by the shell, never inferred here) because the node's `syncIntent` is lost
// on a reload or a lock (docs/rpc.md 6.1). While it is wanted and nothing
// blocks it (autoSyncPolicy.js), the provider sends ONE `sync.start {}`.
// Preemptions are left to the node: it restarts a preempted continuous run
// after the last queued operation, so the app only waits (a grace period
// extended by every request it sends meanwhile) and, if no run came back,
// asks `sync.status` (which never preempts) before starting anything. A lost
// `sync.start` response is uncertain (@varanda/rpc client.js) and may have
// started the run, so it is reconciled through `sync.status` too, never
// retried blindly. A run that ends by itself is restarted after a backoff.
// A hidden web page sends `sync.stop` once to release its continuous run, or,
// with no run active during the lease's idle gap, the node's continuous intent
// (a later request would otherwise restart a run while hidden); once runs and
// starts in flight are left alone. An uncertain stop is
// reconciled too: sync.status can restart a run, so a confirmed continuous
// run gets at most one more stop in that hidden period. Showing the page
// lets the start gate resume sync at once, also inside the idle gap (locking
// alone stops nothing). The start backoff keeps the failure ladder and the
// idle gap apart (autoSyncPolicy.js): any sync.started ends the idle part.
// syncNow() (pull-to-refresh) waits for the continuous run to catch up, and
// starts it if none is active, only when auto-sync could run now (connected,
// online, visible, wanted, not given up, nothing in flight); otherwise it
// resolves at once. Every awaited continuation re-checks the connection,
// epoch and passkey generation.
// `signals` folds the sync events into UI hints (syncSignals.js).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { displayText, isMutating } from '@varanda/rpc'
import { connectNode } from './client/connect'
import * as configStore from './configStore'
import { installationOrigin } from './installation'
import { isOnline, subscribeOnline } from './online'
import { effectiveVisible, isVisible, subscribeVisible } from './visibility'
import { askPersist } from './persist'
import { startPwa } from './pwa'
import { blockingRecovery } from './recoveryPolicy'
import { EMPTY_GROUP_VERSIONS, bumpGroupVersion, clearGroupVersions, readGroupVersion } from './groupVersions'
import { EMPTY_SIGNALS, endIdle, foldSignal, waitForCatchUp, ackFresh as ackFreshSignals } from './syncSignals'
import { FIRST_BACKOFF_MS, MAX_BACKOFF_MS, PREEMPT_GRACE_MS, afterPreempt, effectiveBackoff, graceExpired, nextBackoff, reconcileIdle, refreshPlan, shouldStopForHidden, startFailure, visibilityChange, wantsStart } from './autoSyncPolicy'
import { errorText } from './ui'
import { accountOriginOf } from './pageGate'
import { slowRequestLine } from './slowRequest'
import { createIdleTracker } from './idle'
import { noteOwnDmDrop } from './dmWakeMute'
import { setDmDropObserver } from './pages'
import { vitrineEnabled } from './vitrine/enabled'
import { recoveryFetch } from './account'
import { NOT_FOUND_TEXT, SERVICE_DOWN_TEXT } from './recovery'

const { loadConfig, saveConfig, clearConfig, discoverConfig, hostedPage, canConfigure } = configStore
// At import, not in an effect: a page DM send can then never run before the
// worker is told about its drops.
setDmDropObserver(noteOwnDmDrop)
// Native only (configStore.native.js): reads the saved or build-time
// installation and sets installationOrigin().
const loadInstallation = typeof configStore.loadInstallation === 'function' ? configStore.loadInstallation : null

const MAX_SYNC_LINES = 200
// Identity operations that take their argument through (docs/rpc.md 5.91 to
// 5.94 and the handles' recovery methods).
const ARG_OPS = new Set(['unlock', 'unlockWrapped', 'unlockWithCode', 'bindPasskey', 'addPasskey', 'finishRecovery'])
// Operations that may install (or drop) the unlocked identity: a result that
// installed nothing ({ pending }, { wrapped }, { needsPasskey }) keeps the
// epoch and the generation. The rest (addPasskey, makeRecoveryCode,
// cancelRecovery, bindPasskey) never change who is unlocked.
const IDENTITY_OPS = new Set(['unlock', 'complete', 'unlockWrapped', 'finishRecovery', 'lock', 'signOut', 'reset'])
const UNLOCK_OPS = new Set(['unlock', 'complete', 'unlockWrapped', 'finishRecovery'])

function installedNothing (result) {
  return !!result && (result.pending === true || result.wrapped === true || result.needsPasskey === true)
}

// A complete() that only finished an added passkey: its wrapped root for the
// app to register, no install fields.
function addedOnly (result) {
  return !!result && typeof result.lookupId === 'string' && result.blob !== undefined &&
    result.publicKey === undefined && result.created === undefined
}

function recoveryError (message, code) {
  const err = new Error(message)
  err.code = code
  return err
}
const RECOVERY_TIMEOUT_MS = 30000

function appendLine (prev, line) {
  const lines = prev.lines.concat([line])
  return { ...prev, lines: lines.length > MAX_SYNC_LINES ? lines.slice(lines.length - MAX_SYNC_LINES) : lines }
}

const NodeContext = createContext(null)

// The chat media calls a handle may offer besides upload (see the header).
const CHAT_MEDIA_CALLS = ['putDm', 'read', 'forgetReadFile', 'clearReadFiles']

export function useNode () {
  return useContext(NodeContext)
}

// A screen notice ('publicado', 'seguindo', ...) describes what the current
// node did in one context of the screen (the post being answered, the sync
// run; null when the screen has none). It is cleared when that node ends or
// is replaced, or when the context changes, so it never outlives what it
// describes. -> [text, set(text, context = the current one)]
export function useNotice (context = null) {
  const { epoch } = useContext(NodeContext)
  const [notice, setNotice] = useState(null)
  useEffect(() => {
    setNotice((n) => (n !== null && (n.epoch !== epoch || n.context !== context) ? null : n))
  }, [epoch, context])
  // A handler keeps the epoch of the render that made it: a response that
  // arrives after its node ended sets a notice that is never shown.
  const set = useCallback((text, ctx = context) => {
    setNotice(text ? { text, epoch, context: ctx } : null)
  }, [epoch, context])
  const shown = notice !== null && notice.epoch === epoch && notice.context === context ? notice.text : ''
  return [shown, set]
}

const noConnection = () => Promise.reject(Object.assign(new Error('sem conexão com o nó'), { code: 'CLOSED' }))

// The Vitrine (src/vitrine/enabled.js): development bundles only, behind an
// opt-in env var. The literal member access is what Expo inlines.
const VITRINE = vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: process.env.EXPO_PUBLIC_VARANDA_VITRINE }, typeof __DEV__ !== 'undefined' && __DEV__)
let vitrine = null
if (VITRINE) {
  const { fixtures } = require('./vitrine/fixtures')
  const { createVitrineRequest } = require('./vitrine/request')
  const { saveTermsRecord } = require('./termsStore')
  const { withMember, withSynced } = require('./terms')
  const { LEGAL_VERSION } = require('./legal')
  // Saved before the shell mounts and loads the record (both stores write
  // synchronously up to here), so the terms gate opens for the fixture key;
  // synced, so nothing is sent to an account service. Under the Vitrine the
  // stores use their own key and file, so the device's real record is untouched.
  saveTermsRecord(withSynced(withMember(null, LEGAL_VERSION, fixtures.own, new Date().toISOString()), fixtures.own)).catch(() => {})
  vitrine = {
    fixtures,
    createVitrineRequest,
    status: { exists: true, publicKey: fixtures.own, legacy: false, unlocked: true, synced: true, resumed: false, passkeyKnown: false, credentialId: null, rpId: null, signedOut: false }
  }
}

export function NodeProvider ({ children }) {
  return VITRINE ? <VitrineNodeProvider>{children}</VitrineNodeProvider> : <LiveNodeProvider>{children}</LiveNodeProvider>
}

// What the shell reads to show the hosted, unlocked, member-certified
// screens over the fixtures: no connection, no sync, no passkey ceremony.
function VitrineNodeProvider ({ children }) {
  const [fixtureRequest] = useState(() => vitrine.createVitrineRequest(vitrine.fixtures))
  const [dmVersion, setDmVersion] = useState(0)
  const bumpDm = useCallback(() => setDmVersion((n) => n + 1), [])
  const [autoWanted, setAutoWanted] = useState(false)
  const setAutoSync = useCallback((wanted) => setAutoWanted(wanted === true), [])
  // The live node bumps these from its events; the fixtures have none, so a
  // change made here bumps them itself, or lists that reload on a version
  // change (Comunidades, A Rua, Pessoas) would keep their first read.
  const [groupVersions, setGroupVersions] = useState(EMPTY_GROUP_VERSIONS)
  const [followsVersion, setFollowsVersion] = useState(0)
  const vitrineRequest = useCallback((method, params) => fixtureRequest(method, params).then((result) => {
    if (/^(group|community)\./.test(method) && isMutating(method)) {
      setGroupVersions((prev) => {
        const group = params && typeof params.group === 'string' ? params.group : null
        return group !== null ? bumpGroupVersion(prev, group) : { ...prev }
      })
    }
    if (method === 'follow.add' || method === 'follow.remove') setFollowsVersion((n) => n + 1)
    return result
  }), [fixtureRequest])
  const getGroupVersion = useCallback((group) => readGroupVersion(groupVersions, group), [groupVersions])
  const value = useMemo(() => {
    const done = () => Promise.resolve({})
    // Anything that would change the identity or the connection refuses, so
    // callers stop before their own side effects and show the message.
    const unavailable = () => Promise.reject(Object.assign(new Error('indisponível no modo vitrine'), { code: 'USAGE' }))
    const status = vitrine.status
    return {
      phase: 'ready',
      config: null,
      error: '',
      hosted: true,
      accountOrigin: 'http://localhost:8080',
      hostedSource: 'live',
      online: true,
      visible: true,
      sync: { active: null, lines: [], stopped: null, starting: false },
      epoch: 1,
      request: vitrineRequest,
      restart: unavailable,
      reconnect: done,
      connect: unavailable,
      // Hides Ajustes › Conexão: saving an installation address would write
      // the real configuration before forgetConfig refuses.
      canConfigure: false,
      retryDiscovery: done,
      forgetConfig: unavailable,
      passkey: {
        status,
        error: '',
        generation: 1,
        refresh: () => Promise.resolve(status),
        unlock: unavailable,
        complete: unavailable,
        lock: unavailable,
        signOut: unavailable,
        reset: unavailable,
        unlockWithCode: unavailable,
        finishRecovery: unavailable,
        addPasskey: unavailable,
        bindPasskey: unavailable,
        makeRecoveryCode: unavailable,
        cancelRecovery: unavailable,
        recovering: false,
        beginRecovery: () => {},
        endRecovery: () => {},
        recover: () => Promise.resolve(false)
      },
      // Dev-only fixture photos (src/vitrine/media.js), never the network.
      media: fixtureRequest.media || null,
      legacyFollows: null,
      followsVersion,
      followCount: null,
      groupVersions,
      getGroupVersion,
      dmVersion,
      bumpDm,
      seenVersion: 0,
      // Never syncing, so always idle: background name reads wait for that
      // (autoSyncPolicy.js namesQuiet).
      autoSync: { wanted: autoWanted, backoffUntil: 0, failureUntil: 0, reconciling: false, idleSince: 1 },
      signals: EMPTY_SIGNALS,
      ackFresh: () => {},
      setAutoSync,
      syncNow: () => Promise.resolve()
    }
  }, [vitrineRequest, groupVersions, followsVersion, getGroupVersion, dmVersion, bumpDm, autoWanted, setAutoSync])
  return <NodeContext.Provider value={value}>{children}</NodeContext.Provider>
}

function LiveNodeProvider ({ children }) {
  // loading | config (the Conectar form) | config-error (hosted page, no
  // configuration found: retry) | connecting | ready | error
  const [phase, setPhase] = useState('loading')
  const [config, setConfig] = useState(null)
  const [error, setError] = useState('')
  // true when the live configuration came from the installation's
  // /varanda.json (discovered, never saved).
  const [hosted, setHosted] = useState(false)
  // The https account origin a core node was configured with, or the one its
  // node.info answers (varanda-serve --account-origin, docs/rpc.md 5.2), else
  // undefined (src/pageGate.js decides whether Páginas show).
  const [infoOrigin, setInfoOrigin] = useState(undefined)
  const accountOrigin = useMemo(() => accountOriginOf(config && config.accountOrigin) || infoOrigin, [config, infoOrigin])
  const accountOriginRef = useRef(accountOrigin)
  accountOriginRef.current = accountOrigin
  // 'live' | 'remembered' | null (see the header).
  const [hostedSource, setHostedSource] = useState(null)
  const [online, setOnline] = useState(() => isOnline())
  const onlineRef = useRef(online)
  onlineRef.current = online
  // Raw visibility, and whether the node is hosted (both read by applyVisible).
  const rawVisibleRef = useRef(null)
  if (rawVisibleRef.current === null) rawVisibleRef.current = isVisible()
  const hostedRef = useRef(false)
  // Effective: what every stop and start decision reads (see the header).
  const [visible, setVisible] = useState(() => effectiveVisible(rawVisibleRef.current, false))
  const visibleRef = useRef(visible)
  // Replaced on visibility transitions, never by a late stop response.
  const hiddenStopRef = useRef({ attempts: 0, retry: false })
  const [sync, setSync] = useState({ active: null, lines: [], stopped: null })
  // Bumped when a connection starts and when one ends (useNotice).
  const [epoch, setEpoch] = useState(0)
  const connRef = useRef(null)
  const startedRef = useRef(false)
  const installationLoadedRef = useRef(false)
  const busyRef = useRef(false)
  // The connect in flight (settles, never rejects), or null.
  const inflightRef = useRef(null)
  // sync.start requests in flight: a lookup sent before the sync.started event
  // would preempt a once-run and end it for good (docs/rpc.md 6.1).
  const startingRef = useRef(0)
  // Requests in flight, for whenIdle (optional work waits for a quiet app).
  const idleRef = useRef(null)
  if (idleRef.current === null) idleRef.current = createIdleTracker()
  const [starting, setStarting] = useState(false)
  // Passkey identity of the browser node (see the header).
  const [hasPasskey, setHasPasskey] = useState(false)
  const [pkStatus, setPkStatus] = useState(null)
  const [pkError, setPkError] = useState('')
  const [pkGeneration, setPkGeneration] = useState(0)
  // The handle has media.upload (browser node).
  const [hasMedia, setHasMedia] = useState(false)
  // Which chat media calls the handle has (putDm, read, forgetReadFile,
  // clearReadFiles); decided once per connection like hasMedia.
  const [mediaCaps, setMediaCaps] = useState('')
  // The handle has follows.legacy / confirmLegacy (browser node).
  const [hasLegacy, setHasLegacy] = useState(false)
  // follows.changed (see the header): the version never goes back.
  const [follows, setFollows] = useState({ version: 0, count: null })
  const [groupVersions, setGroupVersions] = useState(EMPTY_GROUP_VERSIONS)
  const getGroupVersion = useCallback((group) => readGroupVersion(groupVersions, group), [groupVersions])
  // Bumped per dm.changed: a hint to re-read dm.list / dm.thread, never data.
  // The screens bump it too (bumpDm) after dm.set, dm.seen and every dm.pull
  // attempt, so the list, the open thread and the tab dot all read again.
  const [dmVersion, setDmVersion] = useState(0)
  const bumpDm = useCallback(() => setDmVersion((n) => n + 1), [])
  // Bumped per seen.changed: a hint for the seen pass (seenSync.js), never data.
  const [seenVersion, setSeenVersion] = useState(0)
  // null, or { runId: null (not started yet) | integer, restarted }
  const [recovery, setRecovery] = useState(null)
  const recoveryRef = useRef(null)
  recoveryRef.current = recovery
  // The connection whose resumed session was already checked for a recovery.
  const resumeCheckedRef = useRef(null)
  // The current sync state, for callbacks that must not depend on it.
  const syncRef = useRef(sync)
  syncRef.current = sync
  // Bumped when going offline cancels the recovery: a recovery step that
  // awaited across it starts nothing (independent of render timing).
  const recoveryEpochRef = useRef(0)
  // true while the recovery's own sync.start is in flight, then the runId it
  // started: going offline stops only that run, never an adopted one (a
  // continuous run, or a write's internal run that stands in for it).
  const recoveryStartRef = useRef(false)
  const recoveryOwnRunRef = useRef(null)
  // Mirrors of the epoch and the passkey generation, bumped synchronously
  // (bumpEpoch, bumpGeneration): an awaited continuation compares them.
  const epochRef = useRef(0)
  const pkGenRef = useRef(0)
  // Which op left the handle's pending creation ({ conn, kind }): complete()
  // of an 'add' wraps the unlocked root for a new passkey and installs
  // nothing, while the web 'recover' result has the same shape and installs.
  const pendingKindRef = useRef(null)
  // Bumped by every unlock, unlockWithCode or complete that resolved
  // { wrapped }: a recovery fetch outlived by a newer one does nothing.
  const wrappedAttemptRef = useRef(0)

  // Auto-sync (see the header). Every value has a ref for the callbacks.
  const [signals, setSignals] = useState(EMPTY_SIGNALS)
  const signalsRef = useRef(EMPTY_SIGNALS)
  const refreshWaitsRef = useRef(new Set())
  const [autoWanted, setAutoWanted] = useState(false)
  const wantedRef = useRef(false)
  // true after a start failed for good (no identity); the next
  // setAutoSync(true) clears it.
  const [gaveUp, setGaveUp] = useState(false)
  const gaveUpRef = useRef(false)
  // true from an uncertain start/stop (or an expired preemption grace) until an
  // authoritative sync.status answer; a failed read keeps it until the next
  // connection or epoch.
  const [reconciling, setReconciling] = useState(false)
  const reconcilingRef = useRef(false)
  // The effective backoff, and its two parts (see the header).
  const [backoffUntil, setBackoffUntil] = useState(0)
  const backoffUntilRef = useRef(0)
  const [failureUntil, setFailureUntil] = useState(0)
  const failureUntilRef = useRef(0)
  const idleUntilRef = useRef(0)
  const backoffMsRef = useRef(0)
  // While the node should restart a preempted continuous run: until when the
  // app waits for its sync.started (0 = not waiting).
  const [awaitingRestartUntil, setAwaitingRestartUntil] = useState(0)
  const awaitingRef = useRef(0)
  // true from the auto-start's sync.start until its continuation ran.
  const autoInflightRef = useRef(false)
  const runStartedAtRef = useRef(0)
  // The one re-evaluation timer (backoff end, grace end).
  const autoTimerRef = useRef(null)
  const [autoTick, setAutoTick] = useState(0)

  const setWait = useCallback((until) => {
    awaitingRef.current = until
    setAwaitingRestartUntil(until)
  }, [])
  // A part left out keeps its current value.
  const setBackoff = useCallback(({ failure = failureUntilRef.current, idle = idleUntilRef.current }) => {
    failureUntilRef.current = failure
    idleUntilRef.current = idle
    const until = effectiveBackoff({ failureUntil: failure, idleUntil: idle })
    backoffUntilRef.current = until
    setBackoffUntil(until)
    setFailureUntil(failure)
  }, [])
  const setRecon = useCallback((on) => {
    reconcilingRef.current = on
    setReconciling(on)
  }, [])
  const resetSignals = useCallback((next = EMPTY_SIGNALS) => {
    signalsRef.current = next
    setSignals(next)
  }, [])
  // A run learned from sync.status (no sync.started seen for it): its lines
  // are folded from now on. A run already followed is kept.
  const adoptSignals = useCallback((runId, once) => {
    if (signalsRef.current.runId !== null) return
    const now = Date.now()
    if (once === false) runStartedAtRef.current = now
    resetSignals({ ...signalsRef.current, runId, once, ready: false, peer: false, seederVerified: false, reconnecting: false, unverified: false, startedAt: now, idleSince: null })
  }, [resetSignals])
  // Open refresh waits: a run adopted without a sync.started they saw is
  // handed to them (a once run, or none, resolves the waits that follow
  // nothing); failWaits() resolves those at once after a failed start.
  const trackWaits = useCallback((runId, once, ended = false) => {
    const sig = signalsRef.current
    const peerUp = sig.runId === runId && sig.seederVerified === true
    for (const wait of refreshWaitsRef.current) {
      if (once === false && runId != null) wait.track(runId, { peerUp, ended })
      else wait.fail()
    }
  }, [])
  const failWaits = useCallback(() => {
    for (const wait of refreshWaitsRef.current) wait.fail()
  }, [])
  // A new connection, epoch or identity: what was being waited for, reconciled
  // or backed off belonged to the previous one.
  const resetAuto = useCallback(() => {
    for (const wait of refreshWaitsRef.current) wait.done()
    refreshWaitsRef.current.clear()
    if (signalsRef.current.idleSince !== null) resetSignals({ ...signalsRef.current, idleSince: null })
    if (autoTimerRef.current !== null) clearTimeout(autoTimerRef.current)
    autoTimerRef.current = null
    setRecon(false)
    setWait(0)
    setBackoff({ failure: 0, idle: 0 })
    backoffMsRef.current = 0
  }, [setRecon, setWait, setBackoff, resetSignals])
  const bumpEpoch = useCallback(() => {
    epochRef.current += 1
    setGroupVersions(clearGroupVersions)
    resetAuto()
    setEpoch((e) => e + 1)
  }, [resetAuto])
  // The identity may have changed: a give-up (no identity) no longer holds.
  const bumpGeneration = useCallback(() => {
    pkGenRef.current += 1
    setGroupVersions(clearGroupVersions)
    resetAuto()
    gaveUpRef.current = false
    setGaveUp(false)
    setPkGeneration((g) => g + 1)
  }, [resetAuto])

  useEffect(() => () => {
    for (const wait of refreshWaitsRef.current) wait.done()
    refreshWaitsRef.current.clear()
    if (autoTimerRef.current !== null) clearTimeout(autoTimerRef.current)
    autoTimerRef.current = null
  }, [])

  useEffect(() => subscribeOnline(setOnline), [])
  const applyVisible = useCallback(() => {
    const next = effectiveVisible(rawVisibleRef.current, hostedRef.current)
    const change = visibilityChange({ wasVisible: visibleRef.current, visible: next })
    if (change.newPeriod) hiddenStopRef.current = { attempts: 0, retry: false }
    if (change.clearIdle && idleUntilRef.current !== 0) setBackoff({ idle: 0 })
    visibleRef.current = next
    setVisible(next)
  }, [setBackoff])
  useEffect(() => {
    const unsubscribe = subscribeVisible((next) => {
      rawVisibleRef.current = next
      applyVisible()
    })
    // A change between the first render and this subscription fires no event.
    rawVisibleRef.current = isVisible()
    applyVisible()
    return unsubscribe
  }, [applyVisible])
  // Declared before the stop and start effects so they read the recomputed
  // ref in the same commit: a stale hidden state never stops a core-kind
  // run, and a backgrounded web-kind node is hidden as soon as it is hosted.
  useEffect(() => {
    hostedRef.current = hosted
    applyVisible()
  }, [hosted, applyVisible])
  // The service worker (hosted browser-node page only); never awaited.
  useEffect(() => { startPwa().catch(() => {}) }, [])

  const onEvent = useCallback((name, data) => {
    if (name === 'dm.sending') {
      noteOwnDmDrop()
      return
    }
    // Carries nothing and is no sync line.
    if (name === 'seen.changed') {
      setSeenVersion((n) => n + 1)
      return
    }
    if (name === 'groups.changed') {
      setGroupVersions((versions) => bumpGroupVersion(versions, data && data.group))
      return
    }
    if (name === 'dm.changed') {
      setDmVersion((n) => n + 1)
      return
    }
    if (name === 'follows.changed') {
      setFollows((f) => ({ version: f.version + 1, count: data && Number.isInteger(data.count) ? data.count : null }))
      return
    }
    const now = Date.now()
    if (name === 'sync.started') {
      // The run came back (or a new one began): no restart is awaited.
      if (awaitingRef.current) setWait(0)
      if (data.once === false) runStartedAtRef.current = now
      // A new run: an earlier idle gap no longer holds.
      if (idleUntilRef.current !== 0) setBackoff({ idle: 0 })
    } else if (name === 'sync.stopped') {
      // The mode of the run that ended: from the folded signals, else from
      // the adopted active run.
      const s = signalsRef.current
      const a = syncRef.current.active
      const once = s.runId === data.runId ? s.once : (a !== null && a.runId === data.runId ? a.once : null)
      if (once === false && data.reason === 'preempted') {
        const wait = afterPreempt({ once, wanted: wantedRef.current, now })
        if (wait !== null) setWait(wait.awaitingRestartUntil)
      } else if (once === false) {
        const ms = nextBackoff({ reason: data.reason, startedAt: runStartedAtRef.current, stoppedAt: now, previousMs: backoffMsRef.current })
        if (ms !== null) {
          // An idle lease gap is not a failure and never grows that ladder.
          if (data.reason === 'idle') {
            setBackoff({ idle: now + ms })
          } else {
            backoffMsRef.current = ms
            setBackoff({ failure: now + ms })
          }
        }
      }
    }
    resetSignals(foldSignal(signalsRef.current, name, data, now))
    for (const wait of refreshWaitsRef.current) wait.onEvent(name, data)
    setSync((prev) => {
      if (name === 'sync.started') return { ...prev, active: { runId: data.runId, once: data.once }, stopped: null }
      if (name === 'sync.stopped') {
        const stopped = { runId: data.runId, reason: data.reason, result: data.result, at: Date.now() }
        // Keyed by runId: a stop of a run that is no longer the active one
        // does not clear the state of the newer run.
        const active = prev.active && prev.active.runId === data.runId ? null : prev.active
        return { ...prev, active, stopped }
      }
      const line = name === 'warning' ? 'aviso: ' + data.line : '#' + data.runId + ' ' + data.line
      return appendLine(prev, line)
    })
  }, [setWait, setBackoff, resetSignals])

  const connectNow = useCallback(async (cfg, { save = false } = {}) => {
    // Native, the installation's own configuration (the web kind): hosted
    // only once that connection is ready; a failure is the retry screen.
    const nativeHosted = cfg !== null && typeof cfg === 'object' && cfg.kind === 'hosted'
    setPhase('connecting')
    setError('')
    setSync({ active: null, lines: [], stopped: null })
    resetSignals()
    bumpEpoch()
    setRecovery(null)
    setFollows((f) => ({ version: f.version, count: null }))
    const holder = {}
    try {
      const conn = await connectNode(cfg, {
        onEvent,
        onClose: ({ code }) => {
          if (connRef.current !== holder.conn) return
          connRef.current = null
          setRecovery(null)
          setSync({ active: null, lines: [], stopped: null })
          resetSignals()
          bumpEpoch()
          setError(code === 4000 ? 'outra aba assumiu a conexão' : 'a conexão com o nó foi encerrada')
          setPhase('error')
        }
      })
      holder.conn = conn
      connRef.current = conn
      setInfoOrigin(undefined)
      if (save && cfg) {
        try { await saveConfig(cfg) } catch { setError('a configuração não pôde ser guardada neste aparelho') }
      }
      const status = await conn.request('sync.status')
      if (status.state === 'running') {
        setSync((prev) => (prev.active ? prev : { ...prev, active: { runId: status.runId, once: status.once } }))
        adoptSignals(status.runId, status.once)
      }
      // First paint: the shell must know whether the identity is locked
      // before it renders anything for this connection.
      const identity = conn.identity || null
      let pk = null
      let pkErr = ''
      if (identity !== null) {
        try { pk = await identity.status() } catch (err) { pkErr = errorText(err) }
      }
      setHasPasskey(identity !== null)
      setHasMedia(identity !== null && conn.media != null && typeof conn.media.upload === 'function')
      setMediaCaps(identity !== null && conn.media != null ? CHAT_MEDIA_CALLS.filter((k) => typeof conn.media[k] === 'function').join(',') : '')
      setHasLegacy(identity !== null && conn.follows != null && typeof conn.follows.legacy === 'function' && typeof conn.follows.confirmLegacy === 'function')
      setPkStatus(pk)
      setPkError(pkErr)
      bumpGeneration()
      setConfig(cfg)
      if (nativeHosted) setHosted(true)
      setPhase('ready')
    } catch (err) {
      connRef.current = null
      if (holder.conn) { try { await holder.conn.close() } catch {} }
      if (cfg) setConfig(cfg) // the form keeps what was tried
      setError(errorText(err))
      setPhase(nativeHosted ? 'config-error' : canConfigure ? 'config' : 'error')
    } finally {
      busyRef.current = false
    }
  }, [onEvent, resetSignals, bumpEpoch, bumpGeneration, adoptSignals])

  // One connect at a time: a call while one is in flight returns that one.
  const connect = useCallback((cfg, opts) => {
    if (busyRef.current) return inflightRef.current
    busyRef.current = true
    const run = connectNow(cfg, opts)
    inflightRef.current = run
    run.then(() => { if (inflightRef.current === run) inflightRef.current = null })
    return run
  }, [connectNow])

  // Precedence: varanda-serve (no onboarding), then a saved configuration (an
  // explicit manual choice), then the installation's own (not saved, so a
  // changed key in the deployment propagates on reload), then the form. On a
  // hosted page a missing installation configuration is an error to retry,
  // never the form. Native: the saved core configuration wins until it is
  // cleared; then the chosen installation's /varanda.json starts the web
  // kind, and with no installation the form is shown.
  const begin = useCallback(async () => {
    if (loadInstallation !== null && !installationLoadedRef.current) {
      installationLoadedRef.current = true
      try { await loadInstallation() } catch {}
    }
    const saved = await loadConfig()
    setConfig(saved)
    if (!canConfigure) return connect(null)
    if (saved !== null) {
      setHosted(false)
      return connect(saved)
    }
    setPhase('loading')
    if (loadInstallation !== null && installationOrigin() !== null) {
      setHosted(false)
      const found = await discoverConfig({
        onLine: isOnline(),
        onStatus: (s) => setHostedSource(s.source === 'live' || s.source === 'remembered' ? s.source : null)
      })
      if (found !== null) return connect(found)
      setError('não foi possível carregar a configuração desta instalação')
      setPhase('config-error')
      return
    }
    const found = await discoverConfig({
      onLine: isOnline(),
      onStatus: (s) => setHostedSource(s.source === 'live' || s.source === 'remembered' ? s.source : null)
    })
    if (found !== null) {
      setHosted(true)
      return connect(found)
    }
    setHosted(false)
    if (hostedPage) {
      setError('não foi possível carregar a configuração desta instalação')
      setPhase('config-error')
    } else {
      setPhase('config')
    }
  }, [connect])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    begin()
  }, [begin])

  // Hosted page: look for the installation's configuration again.
  const retryDiscovery = useCallback(async () => {
    setError('')
    await begin()
  }, [begin])

  // Drop the saved manual configuration and go back to the installation's.
  const forgetConfig = useCallback(async () => {
    // A connect in flight (with the configuration being dropped) settles
    // first; its connection is then closed below.
    while (inflightRef.current !== null) await inflightRef.current
    const conn = connRef.current
    connRef.current = null
    if (conn) {
      setPhase('connecting')
      try { await conn.close() } catch {}
    }
    await clearConfig()
    setHostedSource(null)
    await begin()
  }, [begin])

  // Native: apply a new configuration (bootstrap, DHT): stop the node
  // (node.close, then terminate) and start it again. The client module
  // handles recover.
  const restart = useCallback(async (cfg) => {
    const conn = connRef.current
    connRef.current = null
    if (conn) {
      setPhase('connecting')
      try { await conn.close() } catch {}
    }
    setHosted(false)
    setHostedSource(null)
    await connect(cfg, { save: true })
  }, [connect])

  const reconnect = useCallback(async () => {
    const conn = connRef.current
    connRef.current = null
    if (conn) { try { await conn.close() } catch {} }
    await connect(config)
  }, [connect, config])

  // While the node should restart a preempted continuous run, every request
  // sent may queue behind (or preempt) it again: the node restarts after the
  // LAST queued operation, so the grace is extended at send and at settle.
  const extendWait = useCallback(() => {
    if (awaitingRef.current) setWait(Date.now() + PREEMPT_GRACE_MS)
  }, [setWait])

  const request = useCallback((method, params) => {
    const conn = connRef.current
    if (!conn) return noConnection()
    const waiting = awaitingRef.current !== 0
    if (waiting) extendWait()
    const startedAt = Date.now()
    const idle = idleRef.current
    idle.begin()
    const done = () => {
      const line = slowRequestLine(method, startedAt, Date.now())
      idle.end()
      if (line !== null && connRef.current === conn) setSync((prev) => appendLine(prev, 'aviso: ' + line))
    }
    if (method !== 'sync.start') {
      const pending = conn.request(method, params)
      pending.then(done, done)
      if (waiting) pending.then(extendWait, extendWait)
      return pending
    }
    startingRef.current += 1
    setStarting(true)
    const settled = () => {
      startingRef.current -= 1
      if (startingRef.current === 0) setStarting(false)
      if (waiting) extendWait()
    }
    const pending = conn.request(method, params)
    pending.then(done, done)
    pending.then(settled, settled)
    return pending
  }, [extendWait])

  const whenIdle = useCallback((quietMs) => idleRef.current.whenIdle(quietMs), [])

  // Re-reads identity.status() of `conn` (the current connection by
  // default); a result for a connection that is no longer current is dropped.
  // `changed` also bumps the generation in the same render.
  const readPasskey = useCallback(async (conn = connRef.current, changed = false) => {
    if (!conn || !conn.identity) return null
    try {
      const st = await conn.identity.status()
      if (connRef.current === conn) {
        setPkStatus(st)
        setPkError('')
        if (changed) bumpGeneration()
      }
      return st
    } catch (err) {
      if (connRef.current === conn) {
        setPkError(errorText(err))
        if (changed) bumpGeneration()
      }
      return null
    }
  }, [bumpGeneration])

  // Calls one identity operation synchronously (no await before it), then
  // re-reads the status whatever the outcome and resolves (or rejects) with
  // the operation's own result (or error, with its .code and .legacy).
  const passkeyOp = useCallback((name, arg) => {
    const conn = connRef.current
    if (!conn || !conn.identity) return noConnection()
    let pending
    try {
      // A node script without signOut (an older build) locks instead.
      const op = name === 'signOut' && typeof conn.identity.signOut !== 'function' ? 'lock' : name
      if (typeof conn.identity[op] !== 'function') throw recoveryError('este aparelho ainda não tem essa função; atualize o Varanda', 'UNSUPPORTED')
      pending = ARG_OPS.has(op) ? conn.identity[op](arg) : conn.identity[op]()
    } catch (err) {
      pending = Promise.reject(err)
    }
    return Promise.resolve(pending).then(
      async (result) => {
        const pendingKind = pendingKindRef.current !== null && pendingKindRef.current.conn === conn ? pendingKindRef.current.kind : null
        if (result && result.pending === true && (name === 'unlock' || name === 'addPasskey' || name === 'finishRecovery')) {
          pendingKindRef.current = { conn, kind: name === 'addPasskey' ? 'add' : name === 'finishRecovery' ? 'recover' : 'unlock' }
        } else if (name === 'complete') {
          pendingKindRef.current = null
        }
        // Bumping for an add would reset the shell's setup state and
        // navigation although the account did not change.
        const added = name === 'complete' && pendingKind === 'add' && addedOnly(result)
        const changed = IDENTITY_OPS.has(name) && !installedNothing(result) && !added
        // Locked at once: a failed re-read below keeps this, never the
        // previous unlocked status.
        if ((name === 'lock' || name === 'signOut' || name === 'reset') && connRef.current === conn) {
          setGroupVersions(clearGroupVersions)
          setPkStatus((st) => (st === null
            ? st
            : { ...st, unlocked: false, synced: false, resumed: false, ...(name === 'reset' ? { exists: false, publicKey: null, legacy: false } : {}) }))
        }
        await readPasskey(conn, changed)
        if (changed) bumpEpoch()
        if (changed && UNLOCK_OPS.has(name)) {
          // Right after the person's own click; a denial changes nothing.
          askPersist(typeof navigator === 'object' && navigator !== null ? navigator.storage : null).catch(() => {})
        }
        return result
      },
      async (err) => {
        await readPasskey(conn, false)
        throw err
      }
    )
  }, [readPasskey, bumpEpoch])

  // A passkey or a code that opened only a recovery entry ({ wrapped,
  // lookupId }): the account service holds the sealed root under that lookup
  // id. Only its marked 404 (recovery: true) means no entry, and then the
  // passkey or code opens nothing here (it is never installed directly).
  // Any other failure is "could not ask", never "not registered". The fetch
  // runs after the ceremony, so no WebAuthn call waits on it.
  const resolveWrapped = useCallback(async (r) => {
    if (!r || r.wrapped !== true) return r
    const attempt = ++wrappedAttemptRef.current
    // The newer attempt owns the held entry: the stale one must not cancel
    // or open it.
    const superseded = () => recoveryError('outra tentativa de entrar começou; esta foi deixada de lado', 'SUPERSEDED')
    const cancel = () => passkeyOp('cancelRecovery').catch(() => {})
    let entry
    try {
      entry = await recoveryFetch(r.lookupId, { origin: hostedRef.current ? undefined : accountOriginRef.current })
    } catch {
      if (wrappedAttemptRef.current !== attempt) throw superseded()
      await cancel()
      throw recoveryError(SERVICE_DOWN_TEXT, 'RECOVERY_SERVICE')
    }
    if (wrappedAttemptRef.current !== attempt) throw superseded()
    if (entry === null) {
      await cancel()
      throw recoveryError(NOT_FOUND_TEXT, 'RECOVERY_NOT_FOUND')
    }
    return passkeyOp('unlockWrapped', { blob: entry.blob, member: entry.member })
  }, [passkeyOp])

  const pkUnlock = useCallback((opts = {}) => passkeyOp('unlock', opts).then(resolveWrapped), [passkeyOp, resolveWrapped])
  const pkComplete = useCallback(() => passkeyOp('complete').then(resolveWrapped), [passkeyOp, resolveWrapped])
  // No ceremony: the code is checked in the node, then the same fetch.
  const pkUnlockWithCode = useCallback((code) => passkeyOp('unlockWithCode', { code }).then(resolveWrapped), [passkeyOp, resolveWrapped])
  // Synchronous in the press (WebAuthn): never await before these.
  const pkFinishRecovery = useCallback((opts = {}) => passkeyOp('finishRecovery', opts), [passkeyOp])
  const pkAddPasskey = useCallback((opts = {}) => passkeyOp('addPasskey', opts), [passkeyOp])
  const pkBindPasskey = useCallback(({ credentialId, userId }) => passkeyOp('bindPasskey', { credentialId, userId }), [passkeyOp])
  const pkMakeRecoveryCode = useCallback(() => passkeyOp('makeRecoveryCode'), [passkeyOp])
  const pkCancelRecovery = useCallback(() => passkeyOp('cancelRecovery'), [passkeyOp])
  const pkLock = useCallback(() => passkeyOp('lock'), [passkeyOp])
  const pkSignOut = useCallback(() => passkeyOp('signOut'), [passkeyOp])
  const pkReset = useCallback(() => passkeyOp('reset'), [passkeyOp])
  const pkRefresh = useCallback(() => readPasskey(), [readPasskey])

  // The recovery after an unlock. beginRecovery() is called (synchronously)
  // before the ceremony, endRecovery() when it did not unlock, recover()
  // once the diary exists: it starts the once run and resolves false when it
  // could not (the recovery is then over).
  const beginRecovery = useCallback(() => setRecovery({ runId: null, restarted: false }), [])
  const endRecovery = useCallback(() => setRecovery(null), [])
  // A run already active (started from Sincronizar, or a gate run) is
  // adopted as the recovery run: reads now would preempt it. With no run
  // active or starting, one local node.info read decides whether the run is
  // needed at all (recoveryPolicy.js).
  const startRecoveryRun = useCallback(async (restarted) => {
    const epoch = recoveryEpochRef.current
    // A continuous run never ends, so it cannot be a recovery that blocks the
    // screens until it stops: it keeps syncing in the background instead.
    const running = syncRef.current.active
    if (running !== null && running.once !== true) {
      setRecovery(null)
      return false
    }
    if (syncRef.current.active === null && startingRef.current === 0) {
      let info = null
      try { info = await request('node.info', {}) } catch {}
      // Cancelled while reading (the browser went offline): start nothing.
      if (recoveryEpochRef.current !== epoch) return false
      if (!blockingRecovery({ onLine: isOnline(), memberCert: info !== null && info.memberCert === true })) {
        setRecovery(null)
        return false
      }
    }
    recoveryStartRef.current = true
    try {
      const r = await request('sync.start', { once: true, timeoutMs: RECOVERY_TIMEOUT_MS })
      // Run ids restart with every node session: the run is tied to its
      // connection.
      recoveryOwnRunRef.current = { conn: connRef.current, runId: r.runId }
      setRecovery((cur) => (cur === null ? null : { runId: r.runId, restarted }))
      return true
    } catch {
    } finally {
      recoveryStartRef.current = false
    }
    try {
      const st = await request('sync.status', {}) // never preempts
      if (st.state === 'running') {
        setRecovery((cur) => (cur === null ? null : { runId: st.runId, restarted }))
        return true
      }
    } catch {}
    setRecovery(null)
    return false
  }, [request])
  const recover = useCallback(() => startRecoveryRun(false), [startRecoveryRun])

  // A resumed session (see the header): once per connection, one local
  // node.info read; only a diary without its member certificate, while the
  // browser may be online, gets the recovery run a ceremony would start. Never
  // when a recovery (a ceremony) or a run is already on, or the diary does not
  // exist yet (the setup step creates it).
  useEffect(() => {
    if (phase !== 'ready' || pkStatus === null || pkStatus.unlocked !== true || pkStatus.resumed !== true) return
    const conn = connRef.current
    if (!conn || resumeCheckedRef.current === conn) return
    resumeCheckedRef.current = conn
    const gen = pkGenRef.current
    ;(async () => {
      let info = null
      try { info = await request('node.info', {}) } catch {}
      if (connRef.current !== conn || pkGenRef.current !== gen) return
      if (info === null || info.publicKey === null) return
      if (!blockingRecovery({ onLine: isOnline(), memberCert: info.memberCert === true })) return
      if (recoveryRef.current !== null || syncRef.current.active !== null || startingRef.current > 0) return
      setRecovery({ runId: null, restarted: false })
      startRecoveryRun(false)
    })()
  }, [phase, pkStatus, request, startRecoveryRun])

  // Offline: the recovery stops blocking the screens, and its run (which
  // cannot reach the seeder now) is stopped too: Identidade holds its reads
  // while a once run is active, so a run left to time out would keep the
  // local tabs closed for up to RECOVERY_TIMEOUT_MS. Native is always online.
  useEffect(() => {
    if (online) return
    recoveryEpochRef.current += 1
    setRecovery(null)
    // Only the run the recovery itself started is stopped (offline it can
    // only time out, and Identidade holds its reads while a once run is
    // active). An adopted run is left alone: sync.stop would also clear the
    // person's continuous-sync intent, which a write's internal run preserves.
    // A start still in flight is the recovery's own: the session runs
    // requests in order, so this stop ends the run it begins.
    const active = syncRef.current.active
    const own = recoveryOwnRunRef.current
    const ownActive = active !== null && own !== null && own.conn === connRef.current && active.runId === own.runId
    if (ownActive || (active === null && recoveryStartRef.current)) {
      request('sync.stop', {}).catch(() => {})
    }
  }, [online, request])

  useEffect(() => {
    if (recovery === null || recovery.runId === null) return
    const stopped = sync.stopped
    if (stopped === null || stopped.runId !== recovery.runId) {
      // One run at a time: another one active means ours ended (its stop
      // was replaced by the next start); that one is followed instead.
      if (sync.active !== null && sync.active.runId !== recovery.runId) {
        setRecovery({ runId: sync.active.runId, restarted: recovery.restarted })
      }
      return
    }
    if (stopped.reason === 'preempted' && !recovery.restarted) {
      // The run that preempted it, if a sync run, is adopted instead.
      if (sync.active !== null) {
        setRecovery({ runId: sync.active.runId, restarted: true })
        return
      }
      setRecovery({ runId: null, restarted: true })
      ;(async () => {
        try {
          const i = await request('node.info', {})
          if (i.publicKey !== null && i.memberCert === true) {
            setRecovery(null)
            readPasskey()
            return
          }
        } catch {}
        if (await startRecoveryRun(true)) return
        readPasskey()
      })()
      return
    }
    setRecovery(null)
    readPasskey()
  }, [recovery, sync.stopped, sync.active, request, readPasskey, startRecoveryRun])

  // One node.info read per connection of a node that is not hosted: its
  // accountOrigin, if any, turns the Páginas on (a failed read leaves them
  // off until the next connection).
  const infoConnRef = useRef(null)
  useEffect(() => {
    if (phase !== 'ready' || hosted) return
    const conn = connRef.current
    if (!conn || infoConnRef.current === conn) return
    infoConnRef.current = conn
    request('node.info', {}).then((info) => {
      if (connRef.current === conn) setInfoOrigin(accountOriginOf(info && info.accountOrigin))
    }, () => {})
  }, [phase, hosted, request])

  // An awaited continuation of `conn` in the epoch/generation it began in.
  const stillCurrent = useCallback((conn, ep, gen) => (
    connRef.current === conn && epochRef.current === ep && pkGenRef.current === gen
  ), [])

  // Is a run active? Asks sync.status on the same connection (it never
  // preempts, the pattern of startRecoveryRun): a running run is adopted;
  // only an authoritative idle answer lets the auto-start fire again (after
  // FIRST_BACKOFF_MS). A failed read keeps `reconciling` until the next
  // connection or epoch (resetAuto): no start is ever sent blindly.
  const reconcile = useCallback(async () => {
    const conn = connRef.current
    if (!conn) return
    const ep = epochRef.current
    const gen = pkGenRef.current
    setWait(0)
    setRecon(true)
    let st
    try {
      st = await request('sync.status', {})
    } catch {
      if (stillCurrent(conn, ep, gen)) failWaits()
      return
    }
    if (!stillCurrent(conn, ep, gen) || !reconcilingRef.current) return
    if (st && st.state === 'running') {
      setSync((prev) => (prev.active && prev.active.runId === st.runId && prev.active.once === st.once ? prev : { ...prev, active: { runId: st.runId, once: st.once } }))
      adoptSignals(st.runId, st.once)
      trackWaits(st.runId, st.once)
      setRecon(false)
    } else if (st && st.state === 'idle') {
      setSync((prev) => (prev.active ? { ...prev, active: null } : prev))
      const parts = reconcileIdle({
        failureUntil: failureUntilRef.current,
        idleUntil: idleUntilRef.current,
        lastStopIdle: signalsRef.current.idleSince !== null,
        now: Date.now()
      })
      setBackoff({ failure: parts.failureUntil, idle: parts.idleUntil })
      failWaits()
      setRecon(false)
    } else {
      failWaits()
    }
    return st
  }, [request, stillCurrent, setWait, setRecon, setBackoff, adoptSignals, trackWaits, failWaits])

  // The one auto-start: sync.start {} and the handling of its outcome.
  const autoStart = useCallback(() => {
    const conn = connRef.current
    if (!conn) return
    const ep = epochRef.current
    const gen = pkGenRef.current
    autoInflightRef.current = true
    runStartedAtRef.current = Date.now()
    request('sync.start', {}).then((r) => {
      autoInflightRef.current = false
      if (!stillCurrent(conn, ep, gen)) return
      // sync.started precedes this response; adopted only if it was missed
      // and the run has not ended already.
      const runId = r && r.runId
      setSync((prev) => (prev.active || (prev.stopped && prev.stopped.runId === runId) ? prev : { ...prev, active: { runId, once: false } }))
      const stopped = syncRef.current.stopped
      trackWaits(runId, false, stopped !== null && stopped.runId === runId)
    }, (err) => {
      autoInflightRef.current = false
      if (connRef.current !== conn) return
      const action = startFailure({ code: err && err.code, message: err && err.message, uncertain: Boolean(err) && err.uncertain === true })
      // Reconciling only reads; it is safe even when the epoch moved on.
      // It hands an adopted run to the refresh waits, or resolves them.
      if (action === 'reconcile') { reconcile(); return }
      if (!stillCurrent(conn, ep, gen)) return
      if (action === 'ignore') {
        // A run is active that this provider has not seen: read it, never
        // start again.
        const active = syncRef.current.active
        if (active === null) reconcile()
        else trackWaits(active.runId, active.once)
        return
      }
      // A failed start ends the idle gap and the refresh waits.
      resetSignals(endIdle(signalsRef.current))
      failWaits()
      if (action === 'give-up') {
        gaveUpRef.current = true
        setGaveUp(true)
        return
      }
      const ms = Math.min(MAX_BACKOFF_MS, backoffMsRef.current ? backoffMsRef.current * 2 : FIRST_BACKOFF_MS)
      backoffMsRef.current = ms
      setBackoff({ failure: Date.now() + ms })
    }).finally(() => setAutoTick((t) => t + 1))
  }, [request, stillCurrent, reconcile, setBackoff, resetSignals, trackWaits, failWaits])

  // Refresh waits before reading: member reads would preempt this run.
  // Subscribe before starting, since even sync.started can arrive immediately.
  // Never starts or waits when auto-sync could not run now (refreshPlan).
  const syncNow = useCallback(async () => {
    const active = syncRef.current.active
    const sig = signalsRef.current
    const plan = refreshPlan({
      connected: connRef.current !== null,
      phase,
      online: onlineRef.current,
      visible: visibleRef.current,
      wanted: wantedRef.current,
      gaveUp: gaveUpRef.current,
      busy: startingRef.current > 0 || autoInflightRef.current || reconcilingRef.current || recoveryRef.current !== null,
      active,
      seederUp: active !== null && sig.runId === active.runId && sig.seederVerified === true,
      // Only the browser node (configured with a seederUrl) leases its link.
      leased: !!(config && config.seederUrl)
    })
    if (plan.action === 'skip') return
    const wait = waitForCatchUp({ runId: plan.action === 'wait' ? plan.runId : null, peerUp: plan.peerUp === true })
    refreshWaitsRef.current.add(wait)
    try {
      if (plan.action === 'start') {
        setBackoff({ failure: 0, idle: 0 })
        autoStart()
      }
      await wait.promise
    } finally {
      wait.done()
      refreshWaitsRef.current.delete(wait)
    }
  }, [phase, config, autoStart, setBackoff])

  // The only visibility stop path. Reserve each attempt synchronously, even
  // if React evaluates again before rendering. Only an authoritative status
  // after an uncertain stop permits the second attempt in this hidden period.
  useEffect(() => {
    if (phase !== 'ready' || startingRef.current > 0 || autoInflightRef.current || reconcilingRef.current) return
    const idleIntent = signalsRef.current.runId === null && signalsRef.current.idleSince !== null
    if (!shouldStopForHidden({ active: syncRef.current.active, visible: visibleRef.current, idleIntent })) return
    const period = hiddenStopRef.current
    if (period.attempts >= 2 || (period.attempts > 0 && !period.retry)) return
    const conn = connRef.current
    if (!conn) return
    const ep = epochRef.current
    const gen = pkGenRef.current
    period.attempts += 1
    period.retry = false
    const idlePath = syncRef.current.active === null
    request('sync.stop', {}).then(() => {
      // The node's continuous intent is cleared: no idle gap is left (the
      // start gate starts a fresh run once the page is shown).
      if (!idlePath || !stillCurrent(conn, ep, gen)) return
      if (signalsRef.current.runId === null) resetSignals(endIdle(signalsRef.current))
      setBackoff({ idle: 0 })
    }, async (err) => {
      if (!stillCurrent(conn, ep, gen) || !err || err.uncertain !== true) return
      const st = await reconcile()
      if (!stillCurrent(conn, ep, gen) || hiddenStopRef.current !== period || visibleRef.current !== false) return
      if (period.attempts < 2 && st && st.state === 'running' && st.once === false) {
        period.retry = true
        setAutoTick((t) => t + 1)
      }
    })
  }, [phase, visible, sync.active, starting, reconciling, autoTick, signals.idleSince, request, reconcile, stillCurrent, resetSignals, setBackoff])

  // Re-evaluated on every relevant change and by the one timer. Decisions read
  // the refs (always current), so two evaluations before a re-render can never
  // send two starts: the first one sets startingRef and autoInflightRef
  // synchronously.
  useEffect(() => {
    if (autoTimerRef.current !== null) clearTimeout(autoTimerRef.current)
    autoTimerRef.current = null
    const now = Date.now()
    const active = syncRef.current.active
    if (graceExpired({ awaitingRestartUntil: awaitingRef.current, active, now })) {
      reconcile()
      return
    }
    const wanted = wantedRef.current && !gaveUpRef.current
    const args = {
      wanted,
      phase,
      online,
      visible: visibleRef.current,
      active,
      starting: startingRef.current > 0 || autoInflightRef.current,
      recovering: recovery !== null,
      reconciling: reconcilingRef.current,
      backoffUntil: backoffUntilRef.current,
      awaitingRestartUntil: awaitingRef.current,
      now
    }
    if (wantsStart(args)) {
      autoStart()
      return
    }
    if (!wanted) return
    const at = Math.max(args.backoffUntil > now ? args.backoffUntil : 0, args.awaitingRestartUntil > now ? args.awaitingRestartUntil : 0)
    if (at > now) {
      autoTimerRef.current = setTimeout(() => {
        autoTimerRef.current = null
        setAutoTick((t) => t + 1)
      }, at - now)
    }
  }, [autoWanted, gaveUp, phase, online, visible, sync.active, starting, recovery, reconciling, backoffUntil, awaitingRestartUntil, autoTick, reconcile, autoStart])

  // The shell's decision; true also clears a give-up.
  const setAutoSync = useCallback((wanted) => {
    const on = wanted === true
    wantedRef.current = on
    setAutoWanted(on)
    if (on && gaveUpRef.current) {
      gaveUpRef.current = false
      setGaveUp(false)
    }
  }, [])

  // Clears the fresh hints of `keys` (all when null) once a screen showed them.
  const ackFresh = useCallback((keys = null) => {
    resetSignals(ackFreshSignals(signalsRef.current, keys))
  }, [resetSignals])

  const autoSync = useMemo(() => ({ wanted: autoWanted, backoffUntil, failureUntil, reconciling, idleSince: signals.idleSince }), [autoWanted, backoffUntil, failureUntil, reconciling, signals.idleSince])

  const recovering = recovery !== null
  const passkey = useMemo(() => (hasPasskey
    ? { status: pkStatus, error: pkError, generation: pkGeneration, refresh: pkRefresh, unlock: pkUnlock, complete: pkComplete, lock: pkLock, signOut: pkSignOut, reset: pkReset, unlockWithCode: pkUnlockWithCode, finishRecovery: pkFinishRecovery, addPasskey: pkAddPasskey, bindPasskey: pkBindPasskey, makeRecoveryCode: pkMakeRecoveryCode, cancelRecovery: pkCancelRecovery, recovering, beginRecovery, endRecovery, recover }
    : null), [hasPasskey, pkStatus, pkError, pkGeneration, pkRefresh, pkUnlock, pkComplete, pkLock, pkSignOut, pkReset, pkUnlockWithCode, pkFinishRecovery, pkAddPasskey, pkBindPasskey, pkMakeRecoveryCode, pkCancelRecovery, recovering, beginRecovery, endRecovery, recover])

  // Thin pass-through to the handle (see the header).
  const mediaUpload = useCallback((args) => {
    const conn = connRef.current
    if (!conn || !conn.media) return noConnection()
    return conn.media.upload(args)
  }, [])
  const unlocked = pkStatus !== null && pkStatus.unlocked === true
  const media = useMemo(() => {
    if (!(hasPasskey && hasMedia && unlocked)) return null
    const out = { upload: mediaUpload }
    for (const k of mediaCaps === '' ? [] : mediaCaps.split(',')) {
      out[k] = (args) => {
        const conn = connRef.current
        if (!conn || !conn.media || typeof conn.media[k] !== 'function') return noConnection()
        return conn.media[k](args)
      }
    }
    return out
  }, [hasPasskey, hasMedia, unlocked, mediaUpload, mediaCaps])

  const [legacyKeys, setLegacyKeys] = useState(null)
  const legacyCheckedRef = useRef(null)
  useEffect(() => {
    const conn = connRef.current
    if (phase !== 'ready' || !hasPasskey || !hasLegacy || !unlocked || !conn || !conn.follows) {
      legacyCheckedRef.current = null
      setLegacyKeys(null)
      return
    }
    const gen = pkGenRef.current
    const done = legacyCheckedRef.current
    if (done !== null && done.conn === conn && done.gen === gen) return
    legacyCheckedRef.current = { conn, gen }
    setLegacyKeys(null)
    conn.follows.legacy().then((r) => {
      if (connRef.current !== conn || pkGenRef.current !== gen) return
      setLegacyKeys(r && Array.isArray(r.keys) ? r.keys.filter((k) => typeof k === 'string') : [])
    }, () => {})
  }, [phase, hasPasskey, hasLegacy, unlocked, pkGeneration])
  const legacyConfirm = useCallback(async (keys) => {
    const conn = connRef.current
    if (!conn || !conn.follows) return noConnection()
    const r = await conn.follows.confirmLegacy(keys)
    setLegacyKeys([])
    setFollows((f) => ({ version: f.version + 1, count: f.count }))
    return r
  }, [])
  const legacyFollows = useMemo(() => (hasPasskey && hasLegacy && unlocked ? { keys: legacyKeys, confirm: legacyConfirm } : null), [hasPasskey, hasLegacy, unlocked, legacyKeys, legacyConfirm])

  const value = useMemo(() => ({
    phase, config, error, hosted, accountOrigin, hostedSource, online, visible, sync: { ...sync, starting }, epoch, request, restart, reconnect, connect, canConfigure, retryDiscovery, forgetConfig, passkey, media, legacyFollows, followsVersion: follows.version, followCount: follows.count, groupVersions, getGroupVersion, dmVersion, bumpDm, seenVersion, autoSync, signals, ackFresh, setAutoSync, syncNow, whenIdle
  }), [phase, config, error, hosted, accountOrigin, hostedSource, online, visible, sync, starting, epoch, request, restart, reconnect, connect, retryDiscovery, forgetConfig, passkey, media, legacyFollows, follows, groupVersions, getGroupVersion, dmVersion, bumpDm, seenVersion, autoSync, signals, ackFresh, setAutoSync, syncNow, whenIdle])

  return <NodeContext.Provider value={value}>{children}</NodeContext.Provider>
}

// 'hh:mm' style time for an ISO instant (peer-derived: falls back to the
// escaped raw text).
export function timeText (at) {
  const d = new Date(String(at))
  if (Number.isNaN(d.getTime())) return displayText(at)
  try {
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return displayText(d.toISOString())
  }
}
