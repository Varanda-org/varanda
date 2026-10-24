/* global navigator */

// The node connection of the app: starts or connects, keeps the phase, the
// sync state (fed by the node's events, so no event is lost while another tab
// is shown; `sync.stopped` carries the local time `at` it arrived, and
// `sync.starting` is true while a sync.start request is in flight) and hands
// the screens one `request` function.
//
// `passkey` (web, browser node only; null for the native node and
// varanda-serve): the in-page node's passkey identity. `status` is the last
// identity.status() (read before the phase becomes 'ready' and after every
// unlock, complete, lock and reset; null until read), `error` the text of a
// failed read, `generation` is bumped when the unlocked identity may have
// changed (the shell drops its node.info then). unlock(opts) and complete()
// call the handle synchronously, so the WebAuthn ceremony stays inside the
// click that triggered it: never await anything before calling them.
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
// native). `hostedSource` is where the hosted configuration came from: 'live'
// (the installation answered), 'remembered' (the installation did not answer
// and the last valid configuration of this origin is used) or null.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { displayText } from '@varanda/rpc'
import { connectNode } from './client/connect'
import { loadConfig, saveConfig, clearConfig, discoverConfig, hostedPage, canConfigure } from './configStore'
import { isOnline, subscribeOnline } from './online'
import { askPersist } from './persist'
import { startPwa } from './pwa'
import { blockingRecovery } from './recoveryPolicy'
import { errorText } from './ui'

const MAX_SYNC_LINES = 200
const RECOVERY_TIMEOUT_MS = 30000

const NodeContext = createContext(null)

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

export function NodeProvider ({ children }) {
  // loading | config (the Conectar form) | config-error (hosted page, no
  // configuration found: retry) | connecting | ready | error
  const [phase, setPhase] = useState('loading')
  const [config, setConfig] = useState(null)
  const [error, setError] = useState('')
  // true when the live configuration came from the installation's
  // /varanda.json (discovered, never saved).
  const [hosted, setHosted] = useState(false)
  // 'live' | 'remembered' | null (see the header).
  const [hostedSource, setHostedSource] = useState(null)
  const [online, setOnline] = useState(() => isOnline())
  const [sync, setSync] = useState({ active: null, lines: [], stopped: null })
  // Bumped when a connection starts and when one ends (useNotice).
  const [epoch, setEpoch] = useState(0)
  const connRef = useRef(null)
  const startedRef = useRef(false)
  const busyRef = useRef(false)
  // The connect in flight (settles, never rejects), or null.
  const inflightRef = useRef(null)
  // sync.start requests in flight: a lookup sent before the sync.started event
  // would preempt a once-run and end it for good (docs/rpc.md 6.1).
  const startingRef = useRef(0)
  const [starting, setStarting] = useState(false)
  // Passkey identity of the browser node (see the header).
  const [hasPasskey, setHasPasskey] = useState(false)
  const [pkStatus, setPkStatus] = useState(null)
  const [pkError, setPkError] = useState('')
  const [pkGeneration, setPkGeneration] = useState(0)
  // null, or { runId: null (not started yet) | integer, restarted }
  const [recovery, setRecovery] = useState(null)
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

  useEffect(() => subscribeOnline(setOnline), [])
  // The service worker (hosted browser-node page only); never awaited.
  useEffect(() => { startPwa().catch(() => {}) }, [])

  const onEvent = useCallback((name, data) => {
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
      const lines = prev.lines.concat([line])
      return { ...prev, lines: lines.length > MAX_SYNC_LINES ? lines.slice(lines.length - MAX_SYNC_LINES) : lines }
    })
  }, [])

  const connectNow = useCallback(async (cfg, { save = false } = {}) => {
    setPhase('connecting')
    setError('')
    setSync({ active: null, lines: [], stopped: null })
    setEpoch((e) => e + 1)
    setRecovery(null)
    const holder = {}
    try {
      const conn = await connectNode(cfg, {
        onEvent,
        onClose: ({ code }) => {
          if (connRef.current !== holder.conn) return
          connRef.current = null
          setRecovery(null)
          setSync({ active: null, lines: [], stopped: null })
          setEpoch((e) => e + 1)
          setError(code === 4000 ? 'outra aba assumiu a conexão' : 'a conexão com o nó foi encerrada')
          setPhase('error')
        }
      })
      holder.conn = conn
      connRef.current = conn
      if (save && cfg) {
        try { await saveConfig(cfg) } catch { setError('a configuração não pôde ser guardada neste aparelho') }
      }
      const status = await conn.request('sync.status')
      if (status.state === 'running') setSync((prev) => (prev.active ? prev : { ...prev, active: { runId: status.runId, once: status.once } }))
      // First paint: the shell must know whether the identity is locked
      // before it renders anything for this connection.
      const identity = conn.identity || null
      let pk = null
      let pkErr = ''
      if (identity !== null) {
        try { pk = await identity.status() } catch (err) { pkErr = errorText(err) }
      }
      setHasPasskey(identity !== null)
      setPkStatus(pk)
      setPkError(pkErr)
      setPkGeneration((g) => g + 1)
      setConfig(cfg)
      setPhase('ready')
    } catch (err) {
      connRef.current = null
      if (holder.conn) { try { await holder.conn.close() } catch {} }
      if (cfg) setConfig(cfg) // the form keeps what was tried
      setError(errorText(err))
      setPhase(canConfigure ? 'config' : 'error')
    } finally {
      busyRef.current = false
    }
  }, [onEvent])

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
  // never the form.
  const begin = useCallback(async () => {
    const saved = await loadConfig()
    setConfig(saved)
    if (!canConfigure) return connect(null)
    if (saved !== null) {
      setHosted(false)
      return connect(saved)
    }
    setPhase('loading')
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

  const request = useCallback((method, params) => {
    const conn = connRef.current
    if (!conn) return noConnection()
    if (method !== 'sync.start') return conn.request(method, params)
    startingRef.current += 1
    setStarting(true)
    const settled = () => {
      startingRef.current -= 1
      if (startingRef.current === 0) setStarting(false)
    }
    const pending = conn.request(method, params)
    pending.then(settled, settled)
    return pending
  }, [])

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
        if (changed) setPkGeneration((g) => g + 1)
      }
      return st
    } catch (err) {
      if (connRef.current === conn) {
        setPkError(errorText(err))
        if (changed) setPkGeneration((g) => g + 1)
      }
      return null
    }
  }, [])

  // Calls one identity operation synchronously (no await before it), then
  // re-reads the status whatever the outcome and resolves (or rejects) with
  // the operation's own result (or error, with its .code and .legacy).
  const passkeyOp = useCallback((name, arg) => {
    const conn = connRef.current
    if (!conn || !conn.identity) return noConnection()
    let pending
    try {
      pending = name === 'unlock' ? conn.identity.unlock(arg) : conn.identity[name]()
    } catch (err) {
      pending = Promise.reject(err)
    }
    return Promise.resolve(pending).then(
      async (result) => {
        const changed = !(result && result.pending === true)
        // Locked at once: a failed re-read below keeps this, never the
        // previous unlocked status.
        if ((name === 'lock' || name === 'reset') && connRef.current === conn) {
          setPkStatus((st) => (st === null
            ? st
            : { ...st, unlocked: false, synced: false, ...(name === 'reset' ? { exists: false, publicKey: null, legacy: false } : {}) }))
        }
        await readPasskey(conn, changed)
        if (changed) setEpoch((e) => e + 1)
        if (changed && (name === 'unlock' || name === 'complete')) {
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
  }, [readPasskey])

  const pkUnlock = useCallback((opts = {}) => passkeyOp('unlock', opts), [passkeyOp])
  const pkComplete = useCallback(() => passkeyOp('complete'), [passkeyOp])
  const pkLock = useCallback(() => passkeyOp('lock'), [passkeyOp])
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

  const recovering = recovery !== null
  const passkey = useMemo(() => (hasPasskey
    ? { status: pkStatus, error: pkError, generation: pkGeneration, refresh: pkRefresh, unlock: pkUnlock, complete: pkComplete, lock: pkLock, reset: pkReset, recovering, beginRecovery, endRecovery, recover }
    : null), [hasPasskey, pkStatus, pkError, pkGeneration, pkRefresh, pkUnlock, pkComplete, pkLock, pkReset, recovering, beginRecovery, endRecovery, recover])

  const value = useMemo(() => ({
    phase, config, error, hosted, hostedSource, online, sync: { ...sync, starting }, epoch, request, restart, reconnect, connect, canConfigure, retryDiscovery, forgetConfig, passkey
  }), [phase, config, error, hosted, hostedSource, online, sync, starting, epoch, request, restart, reconnect, connect, retryDiscovery, forgetConfig, passkey])

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
