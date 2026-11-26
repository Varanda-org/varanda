'use strict'

// The node session (docs/rpc.md section 5, docs/protocol.md section 9): ONE
// serialized session over a member data dir that implements every RPC method
// on top of the core. Both transports use it unchanged: the in-app Bare
// worklet (framed IPC) and varanda-serve (loopback WebSocket) pass
// `session.handlers` to createServerDispatcher and `dispatcher.emit` to
// `session.attach`.
//
// Rules:
// - Handlers run strictly one at a time, in arrival order (one promise chain).
// - Every member operation opens the store and takes the data-dir lock, and a
//   running sync holds it: before any operation that opens the store, a
//   running sync is aborted and awaited; a continuous run is restarted
//   afterwards with a new runId (sync.stopped 'preempted', then sync.started).
//   The exception (#66): the own-diary writes (post.create, post.reply,
//   post.quote, profile.set, like.set, repost.set) run on a session of the
//   running sync's store, held so its teardown waits, and
//   the run goes on (same runId, no sync.stopped).
// - Configuration (association, bootstrap, DHT host) is fixed here, checked
//   before anything touches the network; the public DHT is opt-in.
// - Errors reach the wire only through toRpcError (an explicit table); any
//   other error is INTERNAL 'erro interno' and goes to onInternalError.
// - A LOCKED store open after creation puts the session in its error state:
//   every later request answers LOCKED and no sync restarts.

const fs = require('#fs')
const path = require('#path')
const { RpcError, isSafeMessage, capList, capSyncResult, clipText, FEED_INCOMPLETE_MAX, MAX_LINE, MAX_ID } = require('@varanda/rpc')
const member = require('./member')
const { runSync } = require('./sync')
const { readConfig, readFollows, readBlocklist, storeExists } = require('./store')
const { validRecordCopy, validateRecord, parseRef, genesisCert, decodeBlock } = require('./records')
const { certForKey } = require('./cert')
const { exportHead, exportFollowsPage, exportDiaryPage } = require('./export')
const { formatEvent, key8 } = require('./sync-format')
const { safe } = require('./safe')
const { UsageError } = require('./errors')
const { verifyInviteCard, isInviteCardExpired } = require('./invite-card')
const { validBootstrap, isLoopbackAddress, isLoopbackBootstrap } = require('./config')
const { createRekeyGate, REKEY_CHECK_MS } = require('./group-rekey')

const HEX64 = /^[0-9a-fA-F]{64}$/
const LOCKED_MESSAGE = 'diretório de dados em uso'
const CLOSED_MESSAGE = 'sessão encerrada'
const INTERNAL_MESSAGE = 'erro interno'

const noop = () => {}

// Media or a card on a call that is text only on this node.
function hasMediaParam (params) {
  if (params === null || typeof params !== 'object') return false
  const media = params.media
  const hasMedia = media !== undefined && media !== null && !(Array.isArray(media) && media.length === 0)
  return hasMedia || (params.card !== undefined && params.card !== null)
}

const MEDIA_WEB_ONLY = 'mídia disponível só na versão web'
const PEEK_WEB_ONLY = 'leitura sob demanda só na versão web'
const DM_WEB_ONLY = 'mensagens diretas disponíveis só no navegador'
// Of packages/web-member/lib/page-dm.js: no secrets of that page here.
const NO_PAGE_KEY = 'sem chave da página'
// The dm.* methods a core node answers with the `dm` factory.
const DM_CORE_METHODS = Object.freeze([
  'dm.enable', 'dm.lookup', 'dm.send', 'dm.react', 'dm.pull', 'dm.list', 'dm.thread', 'dm.set', 'dm.seen',
  'dm.pageGenerate', 'dm.pageShare', 'dm.pageSecrets', 'dm.pageDraft', 'dm.pageSend',
  'dm.pageLegacyChunk', 'dm.pageLegacyBlocks', 'dm.pageForget', 'dm.actorBox', 'dm.noticeKey'
])
const SEEN_WEB_ONLY = 'estado de vistos sincronizado só no navegador'
const BLOCK_WEB_ONLY = 'bloqueio de membros disponível só no navegador'
const MUTE_WEB_ONLY = 'silenciar membros disponível só no navegador'
const POST_SHARE_WEB_ONLY = 'A página pública de uma publicação só pode ser ligada pelo app ou pelo navegador.'
// How long downloads in a group are gathered into one groups.changed.
const GROUPS_CHANGED_MS = 50
// The longest an own-diary write waits for a starting run to lend its store
// before it preempts the run instead (as a read waits on the browser node).
const WRITE_WAIT_MS = 3000
// The bounded update of the writer cores before device.disconnect.
const DEVICE_REFRESH_MS = 15000
// How long after a continuous run starts, or a group grows, the periodic
// key rotation check waits: it preempts the run, so it is gathered, and a
// short-lived run never pays for it.
const REKEY_SESSION_DELAY_MS = 30 * 1000
// The rekey gate entry that keeps the check at a continuous run's start to
// once an hour (an app coming back to the foreground restarts the run).
const REKEY_START = 'start'

// ---- error mapping (A6) ----

// User-caused member errors that travel as USAGE with their own message.
const USAGE_MESSAGES = new Set([
  'certificado já gravado',
  'grave o certificado de membro antes de publicar',
  'não é possível seguir a própria chave',
  'limite de diários seguidos atingido',
  'limite do diário atingido',
  'sem permissão no grupo',
  'limite de grupos atingido',
  'nada a alterar',
  'limite do grupo atingido',
  'diretório não é de um membro',
  'associação diferente da configurada',
  'registro de nome inválido',
  'registro de nome antigo',
  'o registro não é uma publicação',
  'o registro não é um perfil',
  'não é possível apagar este registro',
  MEDIA_WEB_ONLY,
  PEEK_WEB_ONLY
])
// Reason codes are lowercase ASCII tokens (cert.js and records.js).
const USAGE_PATTERNS = [
  /^certificado inválido \([a-z0-9-]{1,40}\)$/,
  /^registro inválido: [a-z0-9-]{1,40}$/
]
const NOT_FOUND_MESSAGES = new Set([
  'identidade não encontrada',
  'sem dados locais para este diário',
  'grupo não encontrado',
  'comunidade não encontrada'
])

function messageOf (err) {
  try {
    return err !== null && typeof err === 'object' && typeof err.message === 'string' ? err.message : null
  } catch {
    return null
  }
}

function codeOf (err) {
  try {
    return err !== null && typeof err === 'object' && typeof err.code === 'string' ? err.code : null
  } catch {
    return null
  }
}

// Anything thrown inside the session -> an RpcError with a wire code and a
// message from the table below; never throws. The row order is the table:
//   RpcError raised by the session itself       -> unchanged
//   code LOCKED or LOCK_INVALID                 -> LOCKED 'diretório de dados em uso'
//   UsageError (code USAGE)                     -> USAGE, its message (else 'pedido inválido')
//   code NOT_FOUND with a NOT_FOUND_MESSAGES one -> NOT_FOUND, that message ('grupo não encontrado', 'comunidade não encontrada')
//   a user-caused member message (USAGE_*)      -> USAGE, that message
//   'identidade não encontrada', 'sem dados ...'-> NOT_FOUND, that message
//   anything else (STORE_INVALID included)      -> INTERNAL 'erro interno', onInternalError(err)
function toRpcError (err, onInternalError = noop) {
  if (err instanceof RpcError && err.isSessionError === true) return err
  const code = codeOf(err)
  const message = messageOf(err)
  if (code === 'LOCKED' || code === 'LOCK_INVALID') return rpcError('LOCKED', LOCKED_MESSAGE)
  if (code === 'USAGE' && err instanceof UsageError) {
    return rpcError('USAGE', isSafeMessage(message) ? message : 'pedido inválido')
  }
  if (code === 'NOT_FOUND' && NOT_FOUND_MESSAGES.has(message)) return rpcError('NOT_FOUND', message)
  // Member errors are plain Errors (no code); appendRecord's carry INVALID_RECORD.
  if (message !== null && (code === null || code === 'INVALID_RECORD')) {
    if (USAGE_MESSAGES.has(message) || USAGE_PATTERNS.some((re) => re.test(message))) return rpcError('USAGE', message)
    if (NOT_FOUND_MESSAGES.has(message)) return rpcError('NOT_FOUND', message)
  }
  try { onInternalError(err) } catch {}
  return rpcError('INTERNAL', INTERNAL_MESSAGE)
}

function rpcError (code, message) {
  const err = new RpcError(code, message)
  err.isSessionError = true
  return err
}

// ---- configuration ----

function checkConfig ({ dataDir, association, bootstrap, dhtHost, allowPublicDht }) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new UsageError('diretório de dados inválido')
  if (typeof association !== 'string' || !HEX64.test(association)) {
    throw new UsageError('chave da associação inválida')
  }
  if (allowPublicDht !== true && allowPublicDht !== false) throw new UsageError('allowPublicDht inválido')
  let list = null
  if (bootstrap !== null && bootstrap !== undefined) {
    if (!Array.isArray(bootstrap)) throw new UsageError('bootstrap inválido')
    list = []
    for (const entry of bootstrap) {
      if (typeof entry !== 'string' || !validBootstrap(entry)) throw new UsageError('bootstrap inválido')
      list.push(entry)
    }
  }
  if (allowPublicDht) {
    if (list !== null) throw new UsageError('bootstrap e DHT pública são exclusivos')
  } else if (list === null || list.length === 0) {
    // Never fall back to the public DHT silently (V7).
    throw new UsageError('bootstrap inválido (vazio)')
  }
  let host = null
  if (dhtHost !== null && dhtHost !== undefined) {
    if (typeof dhtHost !== 'string' || !dhtHost || /\s/.test(dhtHost)) throw new UsageError('dht-host inválido')
    host = dhtHost
  }
  // A DHT bound to loopback never reaches a public peer: with the public DHT
  // the run would only time out (issue #10).
  if (allowPublicDht && host !== null && isLoopbackAddress(host)) {
    throw new UsageError('dht-host de loopback e DHT pública são exclusivos')
  }
  // A loopback DHT host disables firewall probing (lib/net.js createSwarm):
  // without it a local testnet is unreachable (V7).
  if (host === null && list !== null && list.every(isLoopbackBootstrap)) host = '127.0.0.1'
  // A seeder or association dir (or anything but a member config) is refused.
  let config = null
  try {
    config = readConfig(dataDir)
  } catch {
    throw new UsageError('diretório não é de um membro')
  }
  if (config !== null && (typeof config !== 'object' || config.role !== 'member')) {
    throw new UsageError('diretório não é de um membro')
  }
  // An association dir (its key pair, lib/assoc.js) is never a member's.
  if (fs.existsSync(path.join(dataDir, 'association.json'))) throw new UsageError('diretório não é de um membro')
  return { association: association.toLowerCase(), bootstrap: list, dhtHost: host }
}

// A minimal AbortSignal (runSync only uses `aborted` and add/removeEventListener):
// no dependency on the runtime's AbortController (Bare).
function createAbort () {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener (type, fn) { if (type === 'abort') listeners.add(fn) },
    removeEventListener (type, fn) { if (type === 'abort') listeners.delete(fn) }
  }
  function abort () {
    if (signal.aborted) return
    signal.aborted = true
    for (const fn of [...listeners]) {
      listeners.delete(fn)
      try { fn() } catch {}
    }
  }
  return { signal, abort }
}

// A once run that resolved at its deadline (docs/rpc.md section 6).
function isTimeout (result) {
  if (!result || result.ok !== false || !Array.isArray(result.errors)) return false
  const first = result.errors[0]
  return first === 'sem pares' || (typeof first === 'string' && first.startsWith('tempo esgotado'))
}

function line (text) {
  return clipText(String(text), MAX_LINE)
}

// runSync log lines may end with a raw error message ('aviso: <what>: <msg>',
// sync.js), which can carry a filesystem path or key material (A6). A line
// with a path separator or a run of 16+ hex digits keeps its prefix up to the
// first ': ' after 'aviso: ' and ends with ': erro interno'. -> [line, redacted]
const UNSAFE_LOG = /[/\\]|[0-9a-fA-F]{16}/

function redactLogLine (text) {
  const str = String(text)
  if (!UNSAFE_LOG.test(str)) return [str, false]
  const cut = str.indexOf(': ', 'aviso: '.length)
  const head = cut === -1 ? 'aviso' : str.slice(0, cut)
  return [UNSAFE_LOG.test(head) ? 'aviso: erro interno' : head + ': erro interno', true]
}

// ---- the session ----

function createSession ({
  dataDir,
  association,
  bootstrap = null,
  dhtHost = null,
  allowPublicDht = false,
  storeOptions,
  onInternalError = noop,
  // The periodic key rotation of private groups (lib/group-rekey.js);
  // injectable for tests.
  rekeyClock = Date.now,
  rekeyRandom = Math.random,
  rekeyDelayMs = REKEY_SESSION_DELAY_MS,
  writerWaitMs = WRITE_WAIT_MS,
  // Conversas (docs/rpc.md 5.73 to 5.80, 5.89, 5.114, 5.161): an optional
  // factory, ({ dataDir, association, ops, emit, log }) -> { handlers,
  // readMedia, close } (@varanda/web-member/lib/core-dm.js). Without it
  // every dm.* method answers as before: USAGE DM_WEB_ONLY.
  dm = null
} = {}) {
  if (dm !== null && typeof dm !== 'function') throw new TypeError('dm must be a function')
  const cfg = checkConfig({ dataDir, association, bootstrap, dhtHost, allowPublicDht })
  const baseStore = storeOptions !== null && typeof storeOptions === 'object' ? { ...storeOptions } : {}
  const reportInternal = (err) => {
    try { onInternalError(err) } catch {}
  }

  // `recover` (worklet lock takeover) applies to the FIRST store open only:
  // the first open that reads it spends it, so a stray second worklet can
  // never have its live lock taken over by a later open of this session.
  let recoverPending = baseStore.recover === true
  function currentStoreOptions () {
    if (!recoverPending) return { ...baseStore, recover: false }
    const opts = { ...baseStore }
    delete opts.recover
    Object.defineProperty(opts, 'recover', {
      enumerable: true,
      get () {
        const value = recoverPending
        recoverPending = false
        return value
      }
    })
    return opts
  }

  function ctx () {
    return { dataDir, association: cfg.association, storeOptions: currentStoreOptions() }
  }

  let emitter = null
  let chain = Promise.resolve()
  let active = null // the operation running now
  let queued = 0 // operations accepted and not finished
  let suspended = false
  let releaseGate = noop
  let gate = Promise.resolve()
  let closed = false
  let closing = null
  let errorState = false
  let run = null // { runId, once, abort, reason, done }
  let lastRunId = 0
  let connection = 0 // epoch, bumped by detach(): a request of a closed connection starts no run
  let syncIntent = null // 'continuous' while a user-started continuous run should be running
  // Own identity, cached once known: the diary key never changes, and block 0
  // (the member certificate) is append-only, so only `memberCert: true` is cached.
  let ownKey = null
  let certKnown = false
  let deviceOffSent = false // the last devices.changed `off` sent (none sent: false)
  const rekeyGate = createRekeyGate({ now: rekeyClock, random: rekeyRandom })
  const rekeyWanted = new Set()
  let rekeyAll = false
  let rekeyTimer = null
  let rekeyDueTimer = null
  let rekeyDueAt = 0
  let rekeyStart = false
  const rekeyDeferred = new Set()
  let rekeyDeferTimer = null
  let rekeyDeferAt = Infinity
  // Groups a check found public: never private, never checked again.
  const rekeyPublic = new Set()

  // A run's events carry the connection epoch it started in: once that
  // connection is detached, a run still unwinding reports to nobody, not to
  // the connection that attached after it.
  function send (event, data, epoch = connection) {
    const fn = emitter
    if (fn === null || epoch !== connection) return
    try { fn(event, data) } catch {}
  }

  function warning (text, epoch) {
    send('warning', { line: line(text) }, epoch)
  }

  function enterErrorState () {
    errorState = true
    syncIntent = null
  }

  // ---- sync runs ----

  // `internal`: a run the node starts for itself (the device.disconnect
  // refresh): no sync.started, sync.event or sync.stopped, and its end never
  // touches the user's sync intent. Warnings still go out.
  function startRun ({ once, timeoutMs, internal = false }) {
    lastRunId = lastRunId >= MAX_ID ? 1 : lastRunId + 1
    const runId = lastRunId
    const epoch = connection
    const { signal, abort } = createAbort()
    // The roots of the Páginas held here (docs/rpc.md 5.114).
    const pages = dmNode === null ? [] : dmNode.heldPages()
    // lent: the run's store lend (lib/sync.js `lend`), null until it opened
    // its store and once it is ending; lentReady settles with the first lend,
    // or null when the run ends without one.
    let lentFirst
    const r = { runId, once, internal, abort, reason: null, done: null, pages, lent: null, lentReady: null }
    r.lentReady = new Promise((resolve) => { lentFirst = resolve })
    const syncEvent = (event, data) => {
      if (!internal) send(event, data, epoch)
    }
    run = r
    // A burst of downloads in one group (a writer catching up block by
    // block) becomes one groups.changed per group.
    const grown = new Set()
    let grownTimer = null
    const flushGrown = () => {
      grownTimer = null
      // A grown community core (C's root or a CW) may change every group
      // whose header names C: the gate, admins and the catalogue.
      const out = new Set(grown)
      for (const key of grown) for (const group of groupsOf.get(key) || []) out.add(group)
      for (const group of out) send('groups.changed', { group }, epoch)
      if (!once) wantRekey([...grown])
      grown.clear()
    }
    // Community -> the local groups whose held root names it, from the
    // run's group-parent events (one per local group, at run start for the
    // roots held then).
    const groupsOf = new Map()
    const noteParentEvent = (ev) => {
      if (typeof ev.key !== 'string' || typeof ev.group !== 'string') return
      if (!groupsOf.has(ev.key)) groupsOf.set(ev.key, new Set())
      groupsOf.get(ev.key).add(ev.group)
    }
    const groupGrew = (group) => {
      grown.add(group)
      if (grownTimer === null) grownTimer = setTimeout(flushGrown, GROUPS_CHANGED_MS)
    }
    syncEvent('sync.started', { runId, once })
    r.done = (async () => {
      let result = null
      let error = null
      try {
        result = await runSync({
          dataDir,
          associationKey: cfg.association,
          bootstrap: cfg.bootstrap === null ? undefined : cfg.bootstrap,
          host: cfg.dhtHost === null ? undefined : cfg.dhtHost,
          once,
          timeoutMs: once ? timeoutMs : undefined,
          log: (text) => {
            const [clean, redacted] = redactLogLine(text)
            if (redacted) reportInternal(new Error(String(text)))
            warning(safe(clean), epoch)
          },
          onEvent: (ev) => {
            if (ev && ev.event === 'group-downloaded' && typeof ev.group === 'string') groupGrew(ev.group)
            if (ev && ev.event === 'group-parent') noteParentEvent(ev)
            if (ev && ev.event === 'skipped') {
              warning('aviso: diário ' + key8(ev.key) + ' ignorado (' + safe(ev.reason) + ')', epoch)
              return
            }
            const text = formatEvent(ev)
            if (text !== null) syncEvent('sync.event', { runId, line: line(text) })
          },
          signal,
          pages,
          storeOptions: currentStoreOptions(),
          lend: (api) => {
            r.lent = api
            lentFirst(api)
          }
        })
      } catch (err) {
        error = err
      }
      r.lent = null
      lentFirst(null)
      if (grownTimer !== null) {
        clearTimeout(grownTimer)
        flushGrown()
      }
      if (run === r) run = null
      if (error !== null) {
        if (codeOf(error) === 'LOCKED') enterErrorState()
        if (!internal) syncIntent = null
        warning('erro: ' + toRpcError(error, reportInternal).message, epoch)
        syncEvent('sync.stopped', { runId, reason: 'error' })
        return
      }
      let reason = r.reason
      if (reason === null) {
        if (once) {
          reason = isTimeout(result) ? 'timeout' : 'done'
        } else {
          reason = 'done'
          syncIntent = null
        }
      }
      const data = { runId, reason }
      if (once) data.result = capSyncResult(result)
      syncEvent('sync.stopped', data)
    })()
    return runId
  }

  // Aborts the running run (if any) and awaits it: its store is closed and
  // its sync.stopped sent when this resolves. -> whether a run was active.
  async function stopRun (reason) {
    const r = run
    if (r === null) return false
    if (r.reason === null) r.reason = reason
    r.abort()
    await r.done
    return true
  }

  function restartIfWanted () {
    if (syncIntent !== 'continuous' || run !== null) return
    if (suspended || closed || errorState) return
    startRun({ once: false })
  }

  // Restarts only when no other operation is waiting: with several requests
  // queued during a continuous run, the run is preempted once and restarted
  // by the last of them (no teardown and rebuild of the swarm per request).
  // `self` = how many of the queued operations are the caller itself.
  function restartWhenIdle (self) {
    if (queued <= self) restartIfWanted()
  }

  // ---- periodic key rotation (lib/group-rekey.js) ----

  // Node-initiated and best effort: only while a continuous run is wanted,
  // at most one check per group an hour (each check stops and restarts the
  // run, like a request), never retried after a failure before the next
  // check. `groups` null = every local group. Only a group the check can
  // mark counts (a local group that is not a community nor known public),
  // so a community's growth never stops the run. Growth inside a group's
  // hour is kept and checked when the hour ends, on one timer.
  function wantRekey (groups) {
    if (closed || syncIntent !== 'continuous') return
    if (groups === null) {
      rekeyAll = true
    } else {
      for (const g of checkable(groups)) {
        if (rekeyGate.ready(g)) rekeyWanted.add(g)
        else rekeyDeferred.add(g)
      }
      armRekeyDeferred()
    }
    if (rekeyTimer !== null || (!rekeyAll && rekeyWanted.size === 0)) return
    rekeyTimer = setTimeout(rekeyPass, rekeyDelayMs)
    if (typeof rekeyTimer.unref === 'function') rekeyTimer.unref()
  }

  // The same filter as member.periodicRekey, read from groups.json without
  // the store.
  function checkable (groups) {
    if (groups.length === 0) return []
    const local = new Set(member.localGroups(dataDir).filter((g) => g.kind !== 'community').map((g) => g.group))
    const out = []
    for (const g of groups) {
      const key = typeof g === 'string' ? g.toLowerCase() : ''
      if (local.has(key) && !rekeyPublic.has(key)) out.push(key)
    }
    return out
  }

  function armRekeyDeferred () {
    if (rekeyDeferred.size === 0) return
    let at = Infinity
    for (const g of rekeyDeferred) at = Math.min(at, rekeyGate.readyAt(g))
    if (rekeyDeferTimer !== null && rekeyDeferAt <= at) return
    if (rekeyDeferTimer !== null) clearTimeout(rekeyDeferTimer)
    rekeyDeferAt = at
    const delay = Math.min(Math.max(at - rekeyGate.now(), 0), 0x7fffffff)
    rekeyDeferTimer = setTimeout(() => {
      rekeyDeferTimer = null
      rekeyDeferAt = Infinity
      const groups = [...rekeyDeferred]
      rekeyDeferred.clear()
      wantRekey(groups)
    }, delay)
    if (typeof rekeyDeferTimer.unref === 'function') rekeyDeferTimer.unref()
  }

  function armRekeyDue (at) {
    const delay = Math.min(Math.max(at - rekeyGate.now(), REKEY_CHECK_MS), 0x7fffffff)
    const fireAt = Date.now() + delay
    if (rekeyDueTimer !== null && rekeyDueAt <= fireAt) return
    if (rekeyDueTimer !== null) clearTimeout(rekeyDueTimer)
    rekeyDueAt = fireAt
    rekeyDueTimer = setTimeout(() => {
      rekeyDueTimer = null
      wantRekey(null)
    }, delay)
    if (typeof rekeyDueTimer.unref === 'function') rekeyDueTimer.unref()
  }

  function clearRekey () {
    if (rekeyTimer !== null) clearTimeout(rekeyTimer)
    if (rekeyDueTimer !== null) clearTimeout(rekeyDueTimer)
    if (rekeyDeferTimer !== null) clearTimeout(rekeyDeferTimer)
    rekeyTimer = null
    rekeyDueTimer = null
    rekeyDeferTimer = null
    rekeyDeferAt = Infinity
    rekeyWanted.clear()
    rekeyDeferred.clear()
    rekeyAll = false
    rekeyStart = false
  }

  function rekeyPass () {
    rekeyTimer = null
    if (closed || syncIntent !== 'continuous') return clearRekey()
    // Never in the way of a request: try again after the queue drains.
    if (suspended || queued > 0) return wantRekey([])
    const groups = rekeyAll ? null : [...rekeyWanted]
    const start = rekeyStart
    rekeyWanted.clear()
    rekeyAll = false
    rekeyStart = false
    rekeyCheck({ groups, start }).catch(noop)
  }

  const rekeyCheck = serial(async ({ groups, start }, epoch) => {
    if (syncIntent !== 'continuous') return
    // The start check counts once it runs: a run stopped before it did
    // leaves the next start free to check.
    if (start) rekeyGate.checked(REKEY_START)
    const r = await withStore((c) => member.periodicRekey(c, {
      groups,
      now: rekeyGate.now(),
      ready: rekeyGate.ready,
      jitter: rekeyGate.jitter
    }))
    for (const g of r.checked) rekeyGate.checked(g)
    for (const g of r.public) rekeyPublic.add(g)
    for (const g of r.rotated) send('groups.changed', { group: g }, epoch)
    if (r.next !== null) armRekeyDue(r.next)
  })

  // ---- serialization ----

  // Every operation that opens the store runs through here: the running sync
  // is aborted and awaited first (it holds the data-dir lock).
  async function withStore (fn) {
    if (run !== null) await stopRun('preempted')
    if (errorState) throw rpcError('LOCKED', LOCKED_MESSAGE)
    return fn(ctx())
  }

  // An own-diary write (see the rules at the top): while a run exists it runs on a
  // session of the run's store (ctx.store), held so the run's teardown waits
  // for it, and the run is not stopped. A run that has not lent its store
  // within writerWaitMs, or is ending, is preempted as by any operation. The
  // fallback happens only before fn starts: a write that failed on the lent
  // store is never run again (no retry of a state-changing request).
  async function withOwnWrite (fn) {
    const r = run
    if (r === null) return withStore(fn)
    let timer = null
    const api = await Promise.race([
      r.lentReady,
      new Promise((resolve) => { timer = setTimeout(resolve, writerWaitMs, null) })
    ])
    clearTimeout(timer)
    const lent = api === null ? null : r.lent
    if (lent === null || run !== r || !lent.hold()) return withStore(fn)
    let store = null
    try {
      if (errorState) throw rpcError('LOCKED', LOCKED_MESSAGE)
      store = lent.session()
      return await fn({ ...ctx(), store })
    } finally {
      if (store !== null) await store.close().catch(noop)
      lent.release()
    }
  }

  function isGated () {
    return suspended && !closed
  }

  function serial (fn) {
    return (params) => {
      // The connection epoch when the request arrived (see detach()).
      const epoch = connection
      queued++
      const p = chain.then(async () => {
        // suspend() and resume() change these flags from outside the loop.
        while (isGated()) await gate
        if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
        if (errorState) throw rpcError('LOCKED', LOCKED_MESSAGE)
        const body = (async () => fn(params, epoch))()
        active = body
        try {
          return await body
        } catch (err) {
          if (codeOf(err) === 'LOCKED' && !(err instanceof RpcError)) enterErrorState()
          throw toRpcError(err, reportInternal)
        } finally {
          active = null
          restartWhenIdle(1)
        }
      })
      const settled = () => { queued-- }
      chain = p.then(settled, settled)
      return p
    }
  }

  // ---- identity ----

  // { publicKey, memberCert } without creating anything: no config.json or
  // no store -> { null, false }.
  async function identity () {
    if (ownKey !== null && certKnown) return { publicKey: ownKey, memberCert: true }
    if (readConfig(dataDir) === null || !storeExists(dataDir)) return { publicKey: null, memberCert: false }
    return withStore((c) => member.withIdentity(c, async ({ diary, ownHex, association: assoc }) => {
      ownKey = ownHex
      let ok = false
      // has(0), not contiguousLength: the own diary may hold cleared deleted
      // blocks, and block 0 is never cleared.
      if (diary.length > 0 && await diary.has(0)) {
        const block0 = decodeBlock(await diary.get(0, { wait: false, raw: true }))
        const cert = genesisCert([{ seq: 0, record: block0 }])
        ok = cert !== null && certForKey(cert, ownHex, assoc).ok
      }
      if (ok) certKnown = true
      return { publicKey: ownHex, memberCert: ok }
    }))
  }

  async function requireOwnKey () {
    if (ownKey !== null) return ownKey
    const { publicKey } = await identity()
    if (publicKey === null) throw new Error('identidade não encontrada')
    return publicKey
  }

  // ---- connected devices ----

  // devices.changed when a device.* call sees this device's state differ
  // from the last one sent (none sent: false, connected).
  function noteDeviceOff (off, epoch) {
    if (typeof off !== 'boolean' || off === deviceOffSent) return
    deviceOffSent = off
    send('devices.changed', { off }, epoch)
  }

  // Before device.disconnect marks the writers: one bounded internal once
  // run (at most DEVICE_REFRESH_MS, whatever the user's sync state) brings
  // the writer cores up to what the peers hold, so the marks keep what the
  // lost device wrote before the call. A user's run is preempted as by any
  // write and restarted after the call (restartWhenIdle). Skipped while the
  // app is backgrounded, closed or in the error state. A run aborted before
  // its end (detach, or a stop from outside) refuses as the web node does:
  // a mark is never raised, so marks over a partial refresh would cut the
  // lost device short for good. A plain timeout of the bound proceeds.
  async function refreshGroupCores (epoch) {
    if (closed || errorState || suspended) return
    if (run !== null) await stopRun('preempted')
    startRun({ once: true, timeoutMs: DEVICE_REFRESH_MS, internal: true })
    const r = run
    if (r !== null) await r.done
    if (epoch !== connection || closed || (r !== null && r.reason !== null)) throw rpcError('USAGE', 'conexão encerrada')
  }

  function syncState () {
    return run === null || run.internal ? { state: 'idle' } : { state: 'running', runId: run.runId, once: run.once }
  }

  // ---- Conversas (the injected engine, see the `dm` option) ----

  // Each op opens the store on the chain, as a request does; the engine's
  // handlers run off it, so one awaiting an op never holds the chain.
  const onChain = (fn) => serial((params) => fn(params))
  const dmOps = {
    own: onChain(() => requireOwnKey()),
    signer: onChain(() => withStore((c) => member.dmSigner(c))),
    dmKeyEnsure: onChain(({ box, gen }) => withStore((c) => member.dmKeyEnsure(c, { box, gen }))),
    dmLookup: (key) => onChain(() => withStore((c) => member.dmLookup(c, key)))({}),
    moderation: async () => member.enforcedBlocklist(dataDir, cfg.association),
    // The delegate file only: no store opened, no run preempted.
    delegate: onChain(() => member.readDelegate(ctx())),
    actorBox: onChain(({ box, gen }) => member.dmActorBox(ctx(), { box, gen })),
    pageRead: (key) => onChain(() => withStore((c) => member.pageRead(c, { key })))({}),
    pagesChanged: () => pagesChanged(),
    readers: {
      cert: onChain(() => withStore((c) => member.withIdentity(c, async ({ diary }) => {
        if (diary.length === 0 || !(await diary.has(0))) return null
        const block0 = decodeBlock(await diary.get(0, { wait: false, raw: true }))
        return block0 !== null && typeof block0 === 'object' ? block0.cert : null
      }))),
      // No member blocks on a core node (block.set is the browser's).
      memberBlocks: async () => [],
      blocklist: async () => readBlocklist(dataDir),
      follows: async () => readFollows(dataDir)
    }
  }
  const dmNode = dm === null
    ? null
    : dm({
      dataDir,
      association: cfg.association,
      ops: dmOps,
      emit: (event, data) => send(event, data),
      log: (text) => warning(safe(text))
    })

  // A dm.* handler of the engine, with the session's closed, gated and
  // error checks and its error mapping.
  function dmHandler (name) {
    const fn = dmNode.handlers[name]
    return async (params) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      while (isGated()) await gate
      // close() releases the gate: a call queued while suspended never
      // enters the engine after it.
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      if (errorState) throw rpcError('LOCKED', LOCKED_MESSAGE)
      try {
        return await fn(params)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
    }
  }

  // The plaintext of a received DM item -> { bytes, mime, w, h, ms }, for
  // the host's media.readFile only (never over RPC). Without the factory:
  // USAGE DM_WEB_ONLY.
  async function dmReadMedia (params) {
    if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
    if (dmNode === null) throw rpcError('USAGE', DM_WEB_ONLY)
    try {
      return await dmNode.readMedia(params)
    } catch (err) {
      throw toRpcError(err, reportInternal)
    }
  }

  // group.read and group.seal with `page` (docs/rpc.md 5.114) with the
  // factory: the page's group box comes from the engine off the chain (the
  // engine's ops queue on it), then the fold runs on the chain. Text only:
  // media or a card is refused before any key use. Without the page's
  // secrets a read answers the root header's visibility (state 'no-key')
  // and a seal NO_PAGE_KEY.
  // The fold runs inside the factory's withPageGroupBox, so a dm.pageForget
  // is ordered with it, and takes its box copy only once its turn on the
  // chain came and the run stopped: a suspend before that holds no copy.
  function pageGroupOp (operation) {
    const fold = serial(({ params, take }) => withStore(async (c) => {
      const box = take()
      if (box === null) {
        if (operation !== member.pageGroupRead) throw rpcError('USAGE', NO_PAGE_KEY)
        return member.pageGroupNoKey(c, params)
      }
      try {
        return await operation(c, { ...params, box })
      } finally {
        box.secretKey.fill(0)
      }
    }))
    return async (params) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      if (hasMediaParam(params)) throw rpcError('USAGE', MEDIA_WEB_ONLY)
      if (typeof params.page !== 'string') throw rpcError('USAGE', 'parâmetro inválido: page')
      while (isGated()) await gate
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      if (errorState) throw rpcError('LOCKED', LOCKED_MESSAGE)
      // Errors of the fold keep the chain's mapping; the factory's are
      // mapped here.
      let folding = false
      try {
        return await dmNode.withPageGroupBox(params.page.toLowerCase(), (take) => {
          folding = true
          return fold({ params, take })
        })
      } catch (err) {
        if (folding) throw err
        throw toRpcError(err, reportInternal)
      }
    }
  }

  // The held pages changed (Conversas unlocked, a page adopted or
  // forgotten): a continuous run started with another list restarts, so
  // the roots it pages follow them. Also with requests queued: one that
  // never opens the store does not stop the run, and the last of them
  // restarts it (serial's restartWhenIdle).
  function pagesChanged () {
    const r = run
    if (r === null || r.once || closed || suspended || errorState) return
    const now = dmNode.heldPages()
    if (now.length === r.pages.length && now.every((p) => r.pages.includes(p))) return
    stopRun('preempted').then(() => restartWhenIdle(0), reportInternal)
  }

  // ---- handlers (docs/rpc.md section 5; params arrive validated) ----

  const handlers = {
    'node.info': serial(async () => {
      // identity() may preempt the run: restart it (when nothing else is
      // queued) BEFORE reading the sync state, so the response matches the
      // sync.started event sent first.
      const { publicKey, memberCert } = await identity()
      restartWhenIdle(1)
      return {
        publicKey,
        memberCert,
        followCount: readFollows(dataDir).length,
        sync: syncState(),
        publicDht: allowPublicDht === true
      }
    }),

    'identity.create': serial(async () => {
      const r = await withStore((c) => member.idCreate(c))
      ownKey = r.publicKey
      return { publicKey: r.publicKey, association: r.association }
    }),

    'identity.show': serial(async () => {
      const r = await withStore((c) => member.idShow(c))
      ownKey = r.publicKey
      return { publicKey: r.publicKey, association: r.association }
    }),

    'cert.add': serial(async ({ cert }) => {
      const r = await withStore((c) => member.certAdd(c, cert))
      certKnown = true
      return { seq: r.seq }
    }),

    // Registered so the dispatcher answers USAGE rather than INTERNAL: a
    // Hypercore 11 diary key is not the raw signer (docs/protocol.md:13), so
    // only the browser node, whose diary key is the Ed25519 public key, can
    // prove it (packages/web-member/lib/session.js). Nothing is opened.
    'account.sign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    // The same for the report statement (docs/rpc.md 5.20): verified against
    // the diary key as the Ed25519 public key, so only the browser signs it.
    'report.sign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    // And for the appeal statement (docs/rpc.md 5.99).
    'appeal.sign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    // And for the terms-acceptance statement (docs/rpc.md 5.29).
    'terms.sign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    // And for the recovery-entry request (docs/rpc.md 5.90).
    'recovery.sign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    // And for the signup-invite request (docs/rpc.md 5.30).
    'invite.sign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    // And for the invite card (docs/rpc.md 5.101): signed only in the browser.
    'inviteCard.sign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    // docs/rpc.md 5.102: pure, no identity needed. Still serial, so a closed
    // or errored session answers LOCKED like every other request.
    'inviteCard.verify': serial(async (params) => {
      try {
        const { signature, ...fields } = params
        const result = verifyInviteCard({ ...fields, association: cfg.association }, signature)
        if (result.ok && isInviteCardExpired(fields.expires, Math.floor(Date.now() / 1000))) return { ok: false, reason: 'expired' }
        return result
      } catch {
        return { ok: false, reason: 'malformed' }
      }
    }),

    // And for the push-subscription statement (docs/rpc.md 5.31).
    'push.sign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    'pushDevice.sign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    // And for the age-verification request (docs/rpc.md 5.32).
    'age.sign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    // And for the phone-verification request (docs/rpc.md 5.115).
    'phone.sign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    // The age attestations are kept only by the browser node (docs/rpc.md 5.83).
    'age.proof': serial(async () => {
      throw new UsageError('disponível só no navegador')
    }),

    // The phone attestations are kept only by the browser node (docs/rpc.md 5.116).
    'phone.proof': serial(async () => {
      throw new UsageError('disponível só no navegador')
    }),

    // Page statements and records (docs/rpc.md 5.84) are signed with the
    // page delegate (5.87), never with a key the caller names. It reads only
    // private/page-actor.json, so no store is opened and a running sync is
    // not preempted.
    'page.sign': serial(async ({ action, nonce, page, op }) => member.pageSign(ctx(), { action, nonce, page, op })),

    // A page diary this node already holds, read whole (docs/rpc.md 5.85).
    'page.read': serial(({ key }) => withStore((c) => member.pageRead(c, { key }))),

    // A page's feed peeks diaries over the browser node's seeder link
    // (docs/rpc.md 5.86). Nothing is opened.
    'page.feed': serial(async () => {
      throw new UsageError('feed de página disponível só no navegador')
    }),

    // The page delegate (docs/rpc.md 5.87): a pair kept in
    // private/page-actor.json and named by a page-delegate in the own diary.
    'page.register': serial(() => withStore((c) => member.pageRegister(c))),

    // Espiadinha reads diaries this node does not store through the browser
    // node's seeder WebSocket link (packages/web-member/lib/peek.js).
    // Nothing is opened.
    'peek.read': serial(async () => {
      throw new UsageError('Espiadinha disponível só no navegador')
    }),

    // Follow notices need proof of ownership of the diary key, which takes the
    // Ed25519 identity key; a Hypercore 11 core-node diary key is not that
    // signer (docs/protocol.md:13), so only the browser node can prove it
    // (docs/rpc.md 5.28). Nothing is opened, read or written.
    'notices.list': serial(async () => {
      throw new UsageError('avisos disponíveis só no navegador')
    }),

    // Only the browser node signs, seals and merges the seen blob (docs/rpc.md
    // 5.95 and 5.96, docs/protocol.md section 14); these open nothing here,
    // and group.seen keeps writing group-seen.json only.
    'seen.sign': serial(async () => { throw new UsageError(SEEN_WEB_ONLY) }),
    'seen.merge': serial(async () => { throw new UsageError(SEEN_WEB_ONLY) }),
    'seen.onceKey': serial(async () => { throw new UsageError(SEEN_WEB_ONLY) }),
    // The seen momentos live in the seen document (rpc.md 5.149, 5.150).
    'moment.seen': serial(async () => { throw new UsageError(SEEN_WEB_ONLY) }),
    'moments.seen': serial(async () => { throw new UsageError(SEEN_WEB_ONLY) }),

    // The browser node's own block list (docs/rpc.md 5.111, 5.112): the reads
    // it filters (peek.read, notices.list, dm.*) exist only there.
    'block.set': serial(async () => { throw new UsageError(BLOCK_WEB_ONLY) }),
    'block.list': serial(async () => { throw new UsageError(BLOCK_WEB_ONLY) }),
    'mute.set': serial(async () => { throw new UsageError(MUTE_WEB_ONLY) }),
    'mute.list': serial(async () => { throw new UsageError(MUTE_WEB_ONLY) }),

    // The applied moderation list's number and dates (docs/rpc.md 5.177):
    // blocklist.json only, no store opened, no run preempted.
    'moderation.status': serial(async () => member.moderationStatus(dataDir, cfg.association)),

    // Public post sharing belongs to the browser node (docs/rpc.md 5.121
    // to 5.123 and 5.169).
    'post.uncovered': serial(async () => { throw new UsageError(POST_SHARE_WEB_ONLY) }),
    'post.shared': serial(async () => { throw new UsageError(POST_SHARE_WEB_ONLY) }),
    'post.share': serial(async () => { throw new UsageError(POST_SHARE_WEB_ONLY) }),
    'post.cover': serial(async () => { throw new UsageError(POST_SHARE_WEB_ONLY) }),
    'post.unshare': serial(async () => { throw new UsageError(POST_SHARE_WEB_ONLY) }),

    // Conversas seal to an X25519 box key derived from the Ed25519 identity
    // key and talk to the seeder over the browser node's link, so only the
    // browser node offers them (docs/rpc.md 5.73 to 5.81). Nothing is opened.
    'dm.enable': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.lookup': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.send': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.react': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.pull': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.list': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.thread': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.set': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.seen': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.noticeKey': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    // A Página's secrets live on the browser node only (docs/rpc.md 5.114).
    'dm.pageGenerate': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.pageShare': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.pageSecrets': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.pageDraft': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.pageSend': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.pageLegacyChunk': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.pageLegacyBlocks': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'dm.pageForget': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    // With the `dm` factory the delegate's box is signed (docs/rpc.md 5.161).
    'dm.actorBox': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    'group.seal': serial(async () => { throw new UsageError(DM_WEB_ONLY) }),
    // Like report.sign (docs/rpc.md 5.20).
    'dm.reportSign': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    // A photo lives in a media core only the browser node writes.
    'profile.set': serial(async ({ name, bio, avatar }) => {
      if (avatar !== undefined && avatar !== null) throw new UsageError(MEDIA_WEB_ONLY)
      const own = await requireOwnKey()
      const { seq } = await withOwnWrite((c) => member.profileSet(c, { name, bio, avatar }))
      return { seq, ref: own + ':' + seq }
    }),

    // Appends an issuer-signed username record (docs/rpc.md 5.19), verified
    // for the own key and the association; idempotent, and a record not newer
    // than the diary's latest is USAGE 'registro de nome antigo'. A Hypercore
    // 11 diary key is not the signer, so a record for it is normally not
    // issued and this answers USAGE 'registro de nome inválido'.
    'username.add': serial(async ({ record }) => {
      await requireOwnKey()
      const r = await withStore((c) => member.usernameAdd(c, record))
      if (!r.changed) return { changed: false, username: record.username }
      return { changed: true, username: record.username, seq: r.seq }
    }),

    // Photos live in media cores only the browser node writes: a post with
    // `media` is refused before anything is opened (like account.sign).
    'post.create': serial(async ({ text, media, preview, poll, event }) => {
      if (poll !== undefined || event !== undefined) throw new UsageError(PEEK_WEB_ONLY)
      if (media !== undefined || (preview && preview.image !== null)) throw new UsageError(MEDIA_WEB_ONLY)
      const r = await withOwnWrite((c) => member.postCreate(c, { text, preview }))
      return { seq: r.seq, ref: r.ref }
    }),

    'post.reply': serial(async ({ to, text, media, preview }) => {
      if (media !== undefined || (preview && preview.image !== null)) throw new UsageError(MEDIA_WEB_ONLY)
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      const r = await withOwnWrite((c) => member.postReply(c, { to: ref, text, preview }))
      return { seq: r.seq, ref: r.ref }
    }),

    'post.quote': serial(async ({ to, text, media, preview }) => {
      if (media !== undefined || (preview && preview.image !== null)) throw new UsageError(MEDIA_WEB_ONLY)
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      const r = await withOwnWrite((c) => member.postQuote(c, { to: ref, text, preview }))
      return { seq: r.seq }
    }),

    'like.set': serial(async ({ to, on }) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      return withOwnWrite((c) => member.likeSet(c, { to: ref, on }))
    }),

    'repost.set': serial(async ({ to, on }) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      return withOwnWrite((c) => member.repostSet(c, { to: ref, on }))
    }),

    // The core node writes the tombstone only: it neither clears media bytes
    // nor writes media.
    'post.delete': serial(async ({ to }) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      return withStore((c) => member.postDelete(c, { to: ref }))
    }),

    'profile.delete': serial(async ({ to }) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      return withStore((c) => member.profileDelete(c, { to: ref }))
    }),

    // Feira listings (docs/rpc.md, listing.*). Photos live in media cores
    // only the browser node writes: a list is refused before anything opens.
    'listing.create': serial(async ({ kind, title, text, price, unit, cat, place, media }) => {
      if (media !== undefined && media !== null) throw new UsageError(MEDIA_WEB_ONLY)
      const r = await withStore((c) => member.listingCreate(c, { kind, title, text, price, unit, cat, place }))
      return { seq: r.seq, ref: r.ref }
    }),

    'listing.edit': serial(async ({ to, expectedRevision, title, text, price, unit, cat, place, media }) => {
      if (media !== undefined && media !== null) throw new UsageError(MEDIA_WEB_ONLY)
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      const r = await withStore((c) => member.listingEdit(c, { to: ref, expectedRevision, title, text, price, unit, cat, place }))
      return { seq: r.seq, ref: r.ref }
    }),

    'listing.status': serial(async ({ to, status }) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      const r = await withStore((c) => member.listingStatus(c, { to: ref, status }))
      return { seq: r.seq, ref: r.ref }
    }),

    'listing.delete': serial(async ({ to }) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      return withStore((c) => member.listingDelete(c, { to: ref }))
    }),

    'listing.rate': serial(async ({ to, offer, consent, stars, text }) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      const r = await withStore((c) => member.listingRate(c, { to: ref, offer, consent, stars, text }))
      return { seq: r.seq, ref: r.ref }
    }),

    'listing.mine': serial(async ({ before, limit }) => {
      return withStore((c) => member.listingMine(c, { before: before === undefined ? null : before, limit }))
    }),

    // The deal consent is signed where the offer arrived, in the browser's
    // DM store; verified ratings need its seeder link. Both are refused
    // before anything opens.
    'listing.consent': serial(async () => {
      throw new UsageError('assinatura disponível só no navegador')
    }),

    'listing.ratings': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),

    // Which refs the own diary likes / reposts (docs/rpc.md), local data only.
    'engagement.read': serial(async ({ refs }) => {
      const r = await withStore((c) => member.engagementRead(c, { refs }))
      return { liked: r.liked, reposted: r.reposted }
    }),

    // On-demand reads of another diary need the browser's seeder link: refused
    // before anything is opened (like account.sign).
    'diary.peek': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),

    // Depoimentos need diary.peek and the DM box key of the browser node
    // (docs/rpc.md 5.100): refused the same way, nothing opened.
    'testimonial.write': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'testimonial.pending': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'testimonial.show': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'testimonial.delete': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'testimonial.decide': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),

    // Recados read the page owner's wall through the seeder index and
    // diary.peek (docs/rpc.md): refused the same way, nothing opened.
    'scrap.write': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'scrap.hide': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'scrap.wall': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'scrap.delete': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),

    // The rich profile (docs/rpc.md): written by the browser node only, the
    // same refusal, nothing written.
    'profile.about': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'profile.mood': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'profile.extra.delete': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),

    // Fas e Melhores amigos (docs/rpc.md): written by the browser node only
    // (the writer's own key and the page check need its reads), the same
    // refusal, nothing written.
    'fan.set': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'top.set': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),

    // Visitas (docs/rpc.md visits.*): pings ride the browser node's dm keys
    // and visit lane, and the target check needs its peeks; refused the
    // same way, nothing written.
    'visits.set': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'visits.state': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'visits.list': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'visits.clear': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'visits.note': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),

    // Aparelhos conectados (docs/rpc.md 5.152 to 5.155).
    'device.hello': serial(async (params, epoch) => {
      const r = await withStore((c) => member.deviceHello(c, params))
      noteDeviceOff(r.off, epoch)
      return r
    }),
    'device.list': serial(async (params, epoch) => {
      const r = await withStore((c) => member.deviceList(c))
      noteDeviceOff(r.off, epoch)
      return r
    }),
    'device.disconnect': serial(async (params, epoch) => {
      // The refusals first, so a refused call starts no run.
      const { pairs } = await withStore((c) => member.deviceDisconnect(c, params, { write: false }))
      if (pairs > 0) await refreshGroupCores(epoch)
      const r = await withStore((c) => member.deviceDisconnect(c, params))
      for (const group of r.groups) send('groups.changed', { group }, epoch)
      return { cut: r.cut, empty: r.empty }
    }),
    'device.reconnect': serial(async (params, epoch) => {
      const r = await withStore((c) => member.deviceReconnect(c, params))
      noteDeviceOff(false, epoch)
      return r
    }),

    // Varandinha (docs/rpc.md garden.*): the help check needs peeks of the
    // owner's diary and the seeder index the core node does not read, and a
    // give and a take do too. Refused the same way, before any core is opened.
    'garden.set': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'groups.show': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'garden.state': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'garden.play': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'garden.help': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'garden.decor': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'garden.stall': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'garden.give': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'garden.take': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'garden.drop': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),

    // Foruns e enquetes (docs/rpc.md): a vote checks the poll post with a
    // peek the core node does not make; refused, nothing written.
    'choice.set': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),
    'choice.mine': serial(async () => {
      throw new UsageError(PEEK_WEB_ONLY)
    }),

    // A momento's photo lives in the browser node's anonymous blob pool
    // (docs/rpc.md 5.113): refused the same way, nothing opened.
    'moment.create': serial(async () => {
      throw new UsageError(MEDIA_WEB_ONLY)
    }),
    'moments.read': serial(async () => {
      throw new UsageError(MEDIA_WEB_ONLY)
    }),
    'moment.lookup': serial(async () => {
      throw new UsageError(MEDIA_WEB_ONLY)
    }),
    'moment.delete': serial(async () => {
      throw new UsageError(MEDIA_WEB_ONLY)
    }),

    'follow.add': serial(async ({ key }) => {
      const r = await withStore((c) => member.followAdd(c, key))
      return { changed: r.changed, followCount: r.follows.length }
    }),

    'follow.remove': serial(async ({ key }) => {
      const r = await withStore((c) => member.followRemove(c, key))
      return { changed: r.changed, followCount: r.follows.length }
    }),

    'follow.list': serial(async ({ offset, limit }) => {
      const { follows } = await withStore((c) => member.followList(c))
      return { follows: follows.slice(offset, offset + limit), total: follows.length }
    }),

    // `before` is an exclusive block-seq bound (docs/rpc.md 5.12); a bound
    // past the length clamps to the newest page. readAll entries are
    // contiguous with seq === index, so the window is a slice.
    'log.read': serial(async ({ author, limit, before }) => {
      const r = await withStore((c) => member.logRead(c, { author: author === undefined ? null : author }))
      const all = r.entries
      const end = before === undefined ? all.length : Math.min(before, all.length)
      const window = all.slice(Math.max(0, end - limit), end)
      const entries = []
      const invalid = []
      for (const { seq, record, deleted } of window) {
        if (record === null) {
          invalid.push({ seq, reason: deleted === true ? 'deleted' : 'malformed' })
          continue
        }
        const copy = validRecordCopy(record, seq)
        if (copy !== null) entries.push({ seq, record: copy })
        else invalid.push({ seq, reason: validateRecord(record, seq) || 'malformed' })
      }
      return { key: r.key, entries, invalid, entriesTruncated: Math.max(0, end - limit) }
    }),

    // Stateless export pages (docs/rpc.md 5.180): each call rereads the
    // own diary; the snapshot bound travels in `until`, so a block appended
    // after the head is never in the export.
    'export.read': serial(async ({ part = 'head', offset, until }) => {
      const r = await withStore((c) => member.exportBlocks(c))
      const out = { key: r.key, head: null, follows: [], entries: [], invalid: [], next: null }
      if (part === 'head') {
        const { follows } = await withStore((c) => member.followList(c))
        const { head, next } = exportHead({ association: cfg.association, length: r.length, entries: r.entries, follows, blocked: null, muted: null })
        return { ...out, head, next }
      }
      if (part === 'follows') {
        const { follows } = await withStore((c) => member.followList(c))
        return { ...out, ...exportFollowsPage(follows, offset, until) }
      }
      return { ...out, ...exportDiaryPage(r.entries, offset, until) }
    }),

    // `before` (a { at, author, seq } cursor, docs/rpc.md 5.13) pages
    // backwards; moderation is re-checked on every request.
    'feed.read': serial(async ({ limit, before }) => {
      // The feed warnings are not events: the lists carry the same information.
      const r = await withStore((c) => member.feedRead(c, { limit, before: before === undefined ? null : before }))
      const skipped = capList(r.skipped)
      const future = capList(r.future)
      const incomplete = capList(r.incomplete, FEED_INCOMPLETE_MAX)
      return {
        items: r.items,
        skipped: skipped.list,
        skippedTruncated: skipped.truncated,
        future: future.list,
        futureTruncated: future.truncated,
        incomplete: incomplete.list,
        incompleteTruncated: incomplete.truncated
      }
    }),

    // Names, bios and handles of a batch of authors (docs/rpc.md 5.21), local
    // data only, with feed.read's admission rules; never creates a core.
    'profile.read': serial(async ({ authors }) => {
      const r = await withStore((c) => member.profileRead(c, { authors }))
      return { profiles: r.profiles, missing: r.missing }
    }),

    'group.create': serial(async (params, epoch) => {
      const r = await withStore((c) => member.groupCreate(c, params))
      send('groups.changed', { group: r.group }, epoch)
      if (typeof params.community === 'string') send('groups.changed', { group: params.community.toLowerCase() }, epoch)
      return r
    }),

    'group.join': serial(async (params, epoch) => {
      const r = await withStore((c) => member.groupJoin(c, params))
      send('groups.changed', { group: params.group }, epoch)
      return r
    }),

    'group.leave': serial(async (params, epoch) => {
      const r = await withStore((c) => member.groupLeave(c, params))
      send('groups.changed', { group: params.group }, epoch)
      return r
    }),

    'group.post': serial(async (params, epoch) => {
      // The core node seals nothing itself: `sealed` (media or a card
      // thumbnail, rpc.md 5.98) is refused here even beside a text card.
      if (params.topic !== undefined || params.poll !== undefined || params.event !== undefined) throw new UsageError(PEEK_WEB_ONLY)
      if (params.media !== undefined || params.sealed === true || (params.card && params.card.image !== null)) throw new UsageError(MEDIA_WEB_ONLY)
      const r = await withStore((c) => member.groupPost(c, params))
      send('groups.changed', { group: params.group }, epoch)
      return r
    }),

    // A page reads its private groups only on a node that holds its secrets
    // (browser node, or with the `dm` factory: pageGroupOp), never as this
    // member.
    'group.read': serial((params) => {
      if (params.page !== undefined) throw new UsageError(DM_WEB_ONLY)
      // Topic marks never go unanswered as a plain page: refused.
      if (params.marks !== undefined || params.topic !== undefined) throw new UsageError(PEEK_WEB_ONLY)
      return withStore((c) => member.groupRead(c, params))
    }),
    'group.seen': serial((params) => withStore((c) => member.groupSeen(c, params))),

    'group.list': serial((params) => withStore((c) => member.groupList(c, params))),

    'group.standalone': serial((params) => withStore((c) => member.groupStandalone(c, params))),

    'group.image': serial(() => { throw new UsageError(MEDIA_WEB_ONLY) }),
    'community.image': serial(() => { throw new UsageError(MEDIA_WEB_ONLY) }),
    'group.info': serial((params) => withStore((c) => member.groupInfo(c, params))),

    'group.members': serial((params) => withStore((c) => member.groupMembers(c, params))),

    'group.requests': serial((params) => withStore((c) => member.groupRequests(c, params))),

    'group.admit': serial(async (params, epoch) => {
      const r = await withStore((c) => member.groupAdmit(c, params))
      send('groups.changed', { group: params.group }, epoch)
      return r
    }),

    'group.ban': serial(async (params, epoch) => {
      const r = await withStore((c) => member.groupBan(c, params))
      send('groups.changed', { group: params.group }, epoch)
      return r
    }),

    'group.admin': serial(async (params, epoch) => {
      const r = await withStore((c) => member.groupAdmin(c, params))
      send('groups.changed', { group: params.group }, epoch)
      return r
    }),

    'group.hide': serial(async (params, epoch) => {
      const r = await withStore((c) => member.groupHide(c, params))
      send('groups.changed', { group: params.group }, epoch)
      return r
    }),

    'group.react': serial(async (params, epoch) => {
      const r = await withStore((c) => member.groupReact(c, params))
      send('groups.changed', { group: params.group }, epoch)
      return r
    }),

    'group.reactors': serial((params) => withStore((c) => member.groupReactors(c, params))),
    // Foruns e enquetes: browser node only, as group.seal.
    'group.choose': serial(async () => { throw new UsageError(PEEK_WEB_ONLY) }),
    'group.topics': serial(async () => { throw new UsageError(PEEK_WEB_ONLY) }),
    'group.voters': serial(async () => { throw new UsageError(PEEK_WEB_ONLY) }),
    // Eventos: browser node only, as the forum methods.
    'group.events': serial(async () => { throw new UsageError(PEEK_WEB_ONLY) }),

    'group.meta': serial(async (params, epoch) => {
      const r = await withStore((c) => member.groupMeta(c, params))
      send('groups.changed', { group: params.group }, epoch)
      return r
    }),

    'group.about': serial(async (params, epoch) => {
      const r = await withStore((c) => member.groupAbout(c, params))
      send('groups.changed', { group: params.group }, epoch)
      return r
    }),

    // A flag written on a CW changes C's log too, so `affected` names both.
    'group.invitePolicy': serial(async (params, epoch) => {
      const affected = new Set()
      const r = await withStore((c) => member.groupInvitePolicy(c, params, { affected }))
      for (const group of affected) send('groups.changed', { group }, epoch)
      return r
    }),

    'group.rekey': serial(async (params, epoch) => {
      const r = await withStore((c) => member.groupRekey(c, params))
      send('groups.changed', { group: params.group }, epoch)
      return r
    }),

    // Every community mutation announces the keys member.js puts in
    // `affected` (docs/rpc.md section 6): C, plus Geral on create and join,
    // plus every local group of C on leave, admit, ban and admin.
    'community.create': serial(async (params, epoch) => {
      const affected = new Set()
      const r = await withStore((c) => member.communityCreate(c, params, { affected }))
      for (const group of affected) send('groups.changed', { group }, epoch)
      return r
    }),

    'community.join': serial(async (params, epoch) => {
      const affected = new Set()
      const r = await withStore((c) => member.communityJoin(c, params, { affected }))
      for (const group of affected) send('groups.changed', { group }, epoch)
      return r
    }),

    'community.leave': serial(async (params, epoch) => {
      const affected = new Set()
      const r = await withStore((c) => member.communityLeave(c, params, { affected }))
      for (const group of affected) send('groups.changed', { group }, epoch)
      return r
    }),

    'community.admit': serial(async (params, epoch) => {
      const affected = new Set()
      const r = await withStore((c) => member.communityAdmit(c, params, { affected }))
      for (const group of affected) send('groups.changed', { group }, epoch)
      return r
    }),

    'community.ban': serial(async (params, epoch) => {
      const affected = new Set()
      const r = await withStore((c) => member.communityBan(c, params, { affected }))
      for (const group of affected) send('groups.changed', { group }, epoch)
      return r
    }),

    'community.meta': serial(async (params, epoch) => {
      const affected = new Set()
      const r = await withStore((c) => member.communityMeta(c, params, { affected }))
      for (const group of affected) send('groups.changed', { group }, epoch)
      return r
    }),

    'community.about': serial(async (params, epoch) => {
      const affected = new Set()
      const r = await withStore((c) => member.communityAbout(c, params, { affected }))
      for (const group of affected) send('groups.changed', { group }, epoch)
      return r
    }),

    'community.invitePolicy': serial(async (params, epoch) => {
      const affected = new Set()
      const r = await withStore((c) => member.communityInvitePolicy(c, params, { affected }))
      for (const group of affected) send('groups.changed', { group }, epoch)
      return r
    }),

    'community.removeGroup': serial(async (params, epoch) => {
      const affected = new Set()
      const r = await withStore((c) => member.communityRemoveGroup(c, params, { affected }))
      for (const group of affected) send('groups.changed', { group }, epoch)
      return r
    }),

    'community.admin': serial(async (params, epoch) => {
      const affected = new Set()
      const r = await withStore((c) => member.communitySetAdmin(c, params, { affected }))
      for (const group of affected) send('groups.changed', { group }, epoch)
      return r
    }),

    'community.members': serial((params) => withStore((c) => member.communityMembers(c, params))),

    'community.requests': serial((params) => withStore((c) => member.communityRequests(c, params))),

    'community.info': serial((params) => withStore((c) => member.communityInfo(c, params))),

    'community.list': serial(() => withStore((c) => member.communityList(c))),

    'sync.start': serial(async ({ once, timeoutMs }, epoch) => {
      // A connection closed meanwhile (detach) must not leave a run behind
      // with nobody attached: re-checked after every await.
      const gone = () => epoch !== connection
      if (gone()) throw rpcError('USAGE', 'conexão encerrada')
      if (run !== null) throw rpcError('USAGE', 'sincronização já em andamento')
      // runSync needs an identity: say so before starting (no run, no event).
      const { publicKey } = await identity()
      if (gone()) throw rpcError('USAGE', 'conexão encerrada')
      if (publicKey === null) throw rpcError('NOT_FOUND', 'identidade não encontrada')
      if (run !== null) throw rpcError('USAGE', 'sincronização já em andamento')
      syncIntent = once ? null : 'continuous'
      const runId = startRun({ once, timeoutMs })
      if (!once && rekeyGate.ready(REKEY_START)) {
        rekeyStart = true
        wantRekey(null)
      }
      return { runId }
    }),

    'sync.stop': serial(async () => {
      syncIntent = null
      const stopped = await stopRun('stopped')
      return { stopped }
    }),

    // A continuous run paused by suspend() restarts after the operations
    // queued meanwhile; the status reports it as running.
    'sync.status': serial(async () => {
      restartWhenIdle(1)
      return syncState()
    })
  }

  // With the factory, the methods in its scope route to it (personal
  // dm.send, dm.react and dm.set text only), and group.seal and
  // group.read with a page fold as the page (pageGroupOp); dm.reportSign
  // keeps its refusal.
  if (dmNode !== null) {
    for (const name of Object.keys(dmNode.handlers)) {
      if (DM_CORE_METHODS.includes(name)) handlers[name] = dmHandler(name)
    }
    const plainRead = handlers['group.read']
    const pageRead = pageGroupOp(member.pageGroupRead)
    handlers['group.read'] = (params, ...rest) => {
      if (params.page === undefined) return plainRead(params, ...rest)
      // A page's groups are private: no topics there.
      if (params.marks !== undefined || params.topic !== undefined) return Promise.reject(rpcError('USAGE', PEEK_WEB_ONLY))
      return pageRead(params)
    }
    handlers['group.seal'] = pageGroupOp(member.pageGroupSeal)
  }

  // ---- host controls ----

  // The transport passes dispatcher.emit; one emitter at a time.
  function attach (emit) {
    if (typeof emit !== 'function') throw new TypeError('emit required')
    emitter = emit
  }

  // The connection closed: no more events, and a running sync stops
  // (reason 'stopped', docs/rpc.md section 6; not delivered).
  // Bumps the connection epoch, so a sync.start still in flight starts no
  // run; restartIfWanted cannot start one either until a new sync.start.
  function detach () {
    connection++
    emitter = null
    syncIntent = null
    clearRekey()
    return stopRun('stopped').then(noop)
  }

  // App backgrounded: the running sync is paused (sync.stopped 'preempted')
  // after the current operation finished; new operations queue until resume().
  async function suspend () {
    if (closed) return
    if (!suspended) {
      suspended = true
      gate = new Promise((resolve) => { releaseGate = resolve })
    }
    if (active !== null) await active.catch(noop)
    await stopRun('preempted')
    // resume() may have run while the run was still stopping (it could not
    // restart it then): restart now.
    if (!suspended) restartWhenIdle(0)
  }

  // Queued operations run; a continuous run that was paused restarts (when
  // operations are queued, the last of them restarts it).
  function resume () {
    if (!suspended) return
    suspended = false
    releaseGate()
    restartWhenIdle(0)
  }

  // Stops accepting requests (later ones -> LOCKED 'sessão encerrada'),
  // stops the sync and awaits every queued operation. Idempotent.
  function close () {
    if (closing !== null) return closing
    closed = true
    syncIntent = null
    clearRekey()
    releaseGate()
    closing = (async () => {
      await chain
      await stopRun('stopped')
      if (dmNode !== null) await dmNode.close().catch(reportInternal)
    })()
    return closing
  }

  return {
    handlers,
    attach,
    detach,
    suspend,
    resume,
    close,
    dmReadMedia,
    // 'open' | 'suspended' | 'error' | 'closed'
    get state () {
      if (closed) return 'closed'
      if (errorState) return 'error'
      return suspended ? 'suspended' : 'open'
    }
  }
}

module.exports = { createSession, toRpcError, checkConfig, redactLogLine }
