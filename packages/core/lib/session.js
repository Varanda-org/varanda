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
// - Configuration (association, bootstrap, DHT host) is fixed here, checked
//   before anything touches the network; the public DHT is opt-in.
// - Errors reach the wire only through toRpcError (an explicit table); any
//   other error is INTERNAL 'erro interno' and goes to onInternalError.
// - A LOCKED store open after creation puts the session in its error state:
//   every later request answers LOCKED and no sync restarts.

const fs = require('#fs')
const path = require('#path')
const { RpcError, isSafeMessage, capList, capSyncResult, clipText, MAX_LINE, MAX_ID } = require('@varanda/rpc')
const member = require('./member')
const { runSync } = require('./sync')
const { readConfig, readFollows, storeExists } = require('./store')
const { validRecordCopy, validateRecord, parseRef, genesisCert, decodeBlock } = require('./records')
const { certForKey } = require('./cert')
const { formatEvent, key8 } = require('./sync-format')
const { safe } = require('./safe')
const { UsageError } = require('./errors')
const { validBootstrap, isLoopbackAddress, isLoopbackBootstrap } = require('./config')

const HEX64 = /^[0-9a-fA-F]{64}$/
const LOCKED_MESSAGE = 'diretório de dados em uso'
const CLOSED_MESSAGE = 'sessão encerrada'
const INTERNAL_MESSAGE = 'erro interno'

const noop = () => {}

const MEDIA_WEB_ONLY = 'mídia disponível só na versão web'
const PEEK_WEB_ONLY = 'leitura sob demanda só na versão web'

// ---- error mapping (A6) ----

// User-caused member errors that travel as USAGE with their own message.
const USAGE_MESSAGES = new Set([
  'certificado já gravado',
  'grave o certificado de membro antes de publicar',
  'não é possível seguir a própria chave',
  'limite de diários seguidos atingido',
  'limite do diário atingido',
  'diretório não é de um membro',
  'associação diferente da configurada',
  'registro de nome inválido',
  'registro de nome antigo',
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
  'sem dados locais para este diário'
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
  onInternalError = noop
} = {}) {
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

  function startRun ({ once, timeoutMs }) {
    lastRunId = lastRunId >= MAX_ID ? 1 : lastRunId + 1
    const runId = lastRunId
    const epoch = connection
    const { signal, abort } = createAbort()
    const r = { runId, once, abort, reason: null, done: null }
    run = r
    send('sync.started', { runId, once }, epoch)
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
            if (ev && ev.event === 'skipped') {
              warning('aviso: diário ' + key8(ev.key) + ' ignorado (' + safe(ev.reason) + ')', epoch)
              return
            }
            const text = formatEvent(ev)
            if (text !== null) send('sync.event', { runId, line: line(text) }, epoch)
          },
          signal,
          storeOptions: currentStoreOptions()
        })
      } catch (err) {
        error = err
      }
      if (run === r) run = null
      if (error !== null) {
        if (codeOf(error) === 'LOCKED') enterErrorState()
        syncIntent = null
        warning('erro: ' + toRpcError(error, reportInternal).message, epoch)
        send('sync.stopped', { runId, reason: 'error' }, epoch)
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
      send('sync.stopped', data, epoch)
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

  // ---- serialization ----

  // Every operation that opens the store runs through here: the running sync
  // is aborted and awaited first (it holds the data-dir lock).
  async function withStore (fn) {
    if (run !== null) await stopRun('preempted')
    if (errorState) throw rpcError('LOCKED', LOCKED_MESSAGE)
    return fn(ctx())
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
      if (diary.contiguousLength > 0) {
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

  function syncState () {
    return run === null ? { state: 'idle' } : { state: 'running', runId: run.runId, once: run.once }
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

    'profile.set': serial(async ({ name, bio }) => {
      const own = await requireOwnKey()
      const { seq } = await withStore((c) => member.profileSet(c, { name, bio }))
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
    'post.create': serial(async ({ text, media }) => {
      if (media !== undefined) throw new UsageError(MEDIA_WEB_ONLY)
      const r = await withStore((c) => member.postCreate(c, { text }))
      return { seq: r.seq, ref: r.ref }
    }),

    'post.reply': serial(async ({ to, text, media }) => {
      if (media !== undefined) throw new UsageError(MEDIA_WEB_ONLY)
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      const r = await withStore((c) => member.postReply(c, { to: ref, text }))
      return { seq: r.seq, ref: r.ref }
    }),

    'post.quote': serial(async ({ to, text, media }) => {
      if (media !== undefined) throw new UsageError(MEDIA_WEB_ONLY)
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      const r = await withStore((c) => member.postQuote(c, { to: ref, text }))
      return { seq: r.seq }
    }),

    'like.set': serial(async ({ to, on }) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      return withStore((c) => member.likeSet(c, { to: ref, on }))
    }),

    'repost.set': serial(async ({ to, on }) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      return withStore((c) => member.repostSet(c, { to: ref, on }))
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
      for (const { seq, record } of window) {
        if (record === null) {
          invalid.push({ seq, reason: 'malformed' })
          continue
        }
        const copy = validRecordCopy(record, seq)
        if (copy !== null) entries.push({ seq, record: copy })
        else invalid.push({ seq, reason: validateRecord(record, seq) || 'malformed' })
      }
      return { key: r.key, entries, invalid, entriesTruncated: Math.max(0, end - limit) }
    }),

    // `before` (a { at, author, seq } cursor, docs/rpc.md 5.13) pages
    // backwards; moderation is re-checked on every request.
    'feed.read': serial(async ({ limit, before }) => {
      // The feed warnings are not events: the lists carry the same information.
      const r = await withStore((c) => member.feedRead(c, { limit, before: before === undefined ? null : before }))
      const skipped = capList(r.skipped)
      const future = capList(r.future)
      return {
        items: r.items,
        skipped: skipped.list,
        skippedTruncated: skipped.truncated,
        future: future.list,
        futureTruncated: future.truncated
      }
    }),

    // Names, bios and handles of a batch of authors (docs/rpc.md 5.21), local
    // data only, with feed.read's admission rules; never creates a core.
    'profile.read': serial(async ({ authors }) => {
      const r = await withStore((c) => member.profileRead(c, { authors }))
      return { profiles: r.profiles, missing: r.missing }
    }),

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
    releaseGate()
    closing = (async () => {
      await chain
      await stopRun('stopped')
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
    // 'open' | 'suspended' | 'error' | 'closed'
    get state () {
      if (closed) return 'closed'
      if (errorState) return 'error'
      return suspended ? 'suspended' : 'open'
    }
  }
}

module.exports = { createSession, toRpcError, checkConfig, redactLogLine }
