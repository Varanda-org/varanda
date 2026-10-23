// The browser node session (docs/rpc.md section 5): ONE serialized session
// over a ./node-storage.js storage that implements the RPC methods the app
// uses on Hypercore 10, syncing through one seeder over a WebSocket
// (./sync.js). It mirrors @varanda/core lib/session.js rule for rule, so the
// app sees the same contract whether its node is the Bare worklet,
// varanda-serve or this session; the transport (./node.js) passes
// `session.handlers` to createServerDispatcher and `dispatcher.emit` to
// `session.attach`, in memory.
//
// Rules (as lib/session.js):
// - Handlers run strictly one at a time, in arrival order (one promise chain).
// - Every member operation opens the own diary, and a running sync holds it
//   open: before any operation that opens a core, a running sync is aborted
//   and awaited; a continuous run is restarted afterwards with a new runId
//   (sync.stopped 'preempted', then sync.started). Two Hypercore instances
//   on the same storage would corrupt it, so this is not optional here either.
// - Configuration (association, seeder address) is fixed here and checked
//   before anything touches the storage or the network. There is no DHT, so
//   node.info reports publicDht false.
// - Errors reach the wire only through toRpcError (an explicit table); any
//   other error is INTERNAL 'erro interno' and goes to onInternalError.
// Not mirrored: suspend/resume (the Bare worklet's background state) and the
// data-dir lock (the browser entry, web/node.js, takes a Web Lock instead).
const { RpcError, isSafeMessage, capList, capSyncResult, clipText, MAX_LINE, MAX_ID } = require('@varanda/rpc')
const { validRecordCopy, validateRecord, parseRef } = require('@varanda/core/lib/records')
const { formatEvent, key8 } = require('@varanda/core/lib/sync-format')
const { safe } = require('@varanda/core/lib/safe')
const { UsageError } = require('@varanda/core/lib/errors')
const member = require('./member-ops')
const { runSync } = require('./sync')
const { readFollows } = require('./node-store')
const { checkSeederUrl } = require('./seeder-url')

const HEX64 = /^[0-9a-fA-F]{64}$/
const LOCKED_MESSAGE = 'diretório de dados em uso'
const CLOSED_MESSAGE = 'sessão encerrada'
const INTERNAL_MESSAGE = 'erro interno'

const noop = () => {}

// ---- error mapping (A6), the table of @varanda/core lib/session.js ----

const USAGE_MESSAGES = new Set([
  'certificado já gravado',
  'grave o certificado de membro antes de publicar',
  'não é possível seguir a própria chave',
  'limite de diários seguidos atingido',
  'limite do diário atingido',
  'diretório não é de um membro',
  'associação diferente da configurada'
])
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
// message from the table above; never throws.
function toRpcError (err, onInternalError = noop) {
  if (err instanceof RpcError && err.isSessionError === true) return err
  const code = codeOf(err)
  const message = messageOf(err)
  if (code === 'LOCKED') return rpcError('LOCKED', LOCKED_MESSAGE)
  if (code === 'USAGE' && err instanceof UsageError) {
    return rpcError('USAGE', isSafeMessage(message) ? message : 'pedido inválido')
  }
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

function checkConfig ({ storage, association, seederUrl, createSocket }) {
  if (storage === null || typeof storage !== 'object' || typeof storage.core !== 'function') {
    throw new TypeError('storage required')
  }
  if (typeof createSocket !== 'function') throw new TypeError('createSocket required')
  if (typeof association !== 'string' || !HEX64.test(association)) {
    throw new UsageError('chave da associação inválida')
  }
  return { association: association.toLowerCase(), seederUrl: checkSeederUrl(seederUrl) }
}

// A minimal AbortSignal (runSync only uses `aborted` and add/removeEventListener).
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

function isTimeout (result) {
  if (!result || result.ok !== false || !Array.isArray(result.errors)) return false
  const first = result.errors[0]
  return first === 'sem pares' || (typeof first === 'string' && first.startsWith('tempo esgotado'))
}

function line (text) {
  return clipText(String(text), MAX_LINE)
}

// A log line with a path separator (a URL included) or a run of 16+ hex
// digits keeps its prefix up to the first ': ' after 'aviso: ' and ends with
// ': erro interno' (@varanda/core lib/session.js redactLogLine). -> [line, redacted]
const UNSAFE_LOG = /[/\\]|[0-9a-fA-F]{16}/

function redactLogLine (text) {
  const str = String(text)
  if (!UNSAFE_LOG.test(str)) return [str, false]
  const cut = str.indexOf(': ', 'aviso: '.length)
  const head = cut === -1 ? 'aviso' : str.slice(0, cut)
  return [UNSAFE_LOG.test(head) ? 'aviso: erro interno' : head + ': erro interno', true]
}

// ---- the session ----

// syncOptions: test-only overrides passed to runSync (limits and timings).
// limits: test-only overrides of the own diary limits.
function createBrowserSession ({
  storage,
  association,
  seederUrl,
  createSocket,
  onInternalError = noop,
  syncOptions = {},
  limits
} = {}) {
  const cfg = checkConfig({ storage, association, seederUrl, createSocket })
  const reportInternal = (err) => {
    try { onInternalError(err) } catch {}
  }

  function ctx () {
    return { storage, association: cfg.association, limits }
  }

  let emitter = null
  let chain = Promise.resolve()
  let queued = 0 // operations accepted and not finished
  let closed = false
  let closing = null
  let run = null // { runId, once, abort, reason, done }
  let lastRunId = 0
  let connection = 0 // epoch, bumped by detach()
  let syncIntent = null // 'continuous' while a user-started continuous run should be running
  // Own identity, cached once known (the key never changes; block 0 is
  // append-only, so only `memberCert: true` is cached).
  let ownKey = null
  let certKnown = false

  function send (event, data) {
    const fn = emitter
    if (fn === null) return
    try { fn(event, data) } catch {}
  }

  function warning (text) {
    send('warning', { line: line(text) })
  }

  // ---- sync runs ----

  function startRun ({ once, timeoutMs }) {
    lastRunId = lastRunId >= MAX_ID ? 1 : lastRunId + 1
    const runId = lastRunId
    const { signal, abort } = createAbort()
    const r = { runId, once, abort, reason: null, done: null }
    run = r
    send('sync.started', { runId, once })
    r.done = (async () => {
      let result = null
      let error = null
      try {
        result = await runSync({
          ...syncOptions,
          storage,
          associationKey: cfg.association,
          seederUrl: cfg.seederUrl,
          createSocket,
          once,
          timeoutMs: once ? timeoutMs : undefined,
          log: (text) => {
            const [clean, redacted] = redactLogLine(text)
            if (redacted) reportInternal(new Error(String(text)))
            warning(safe(clean))
          },
          onEvent: (ev) => {
            if (ev && ev.event === 'skipped') {
              warning('aviso: diário ' + key8(ev.key) + ' ignorado (' + safe(ev.reason) + ')')
              return
            }
            const text = formatEvent(ev)
            if (text !== null) send('sync.event', { runId, line: line(text) })
          },
          signal
        })
      } catch (err) {
        error = err
      }
      if (run === r) run = null
      if (error !== null) {
        syncIntent = null
        warning('erro: ' + toRpcError(error, reportInternal).message)
        send('sync.stopped', { runId, reason: 'error' })
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
      send('sync.stopped', data)
    })()
    return runId
  }

  async function stopRun (reason) {
    const r = run
    if (r === null) return false
    if (r.reason === null) r.reason = reason
    r.abort()
    await r.done
    return true
  }

  function restartIfWanted () {
    if (syncIntent !== 'continuous' || run !== null || closed) return
    startRun({ once: false })
  }

  // Restarts only when no other operation is waiting (one preemption for a
  // burst of requests). `self` = how many queued operations are the caller.
  function restartWhenIdle (self) {
    if (queued <= self) restartIfWanted()
  }

  // ---- serialization ----

  async function withStore (fn) {
    if (run !== null) await stopRun('preempted')
    return fn(ctx())
  }

  function serial (fn) {
    return (params) => {
      const epoch = connection
      queued++
      const p = chain.then(async () => {
        if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
        try {
          return await fn(params, epoch)
        } catch (err) {
          throw toRpcError(err, reportInternal)
        } finally {
          restartWhenIdle(1)
        }
      })
      const settled = () => { queued-- }
      chain = p.then(settled, settled)
      return p
    }
  }

  // ---- identity ----

  async function identity () {
    if (ownKey !== null && certKnown) return { publicKey: ownKey, memberCert: true }
    const r = await withStore((c) => member.identityState(c))
    if (r.publicKey !== null) ownKey = r.publicKey
    if (r.memberCert) certKnown = true
    return r
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
      const { publicKey, memberCert } = await identity()
      restartWhenIdle(1)
      return {
        publicKey,
        memberCert,
        followCount: (await readFollows(storage)).length,
        sync: syncState(),
        publicDht: false
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

    'profile.set': serial(async ({ name, bio }) => {
      const own = await requireOwnKey()
      const { seq } = await withStore((c) => member.profileSet(c, { name, bio }))
      return { seq, ref: own + ':' + seq }
    }),

    'post.create': serial(async ({ text }) => {
      const r = await withStore((c) => member.postCreate(c, { text }))
      return { seq: r.seq, ref: r.ref }
    }),

    'post.reply': serial(async ({ to, text }) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      const r = await withStore((c) => member.postReply(c, { to: ref, text }))
      return { seq: r.seq, ref: r.ref }
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

    'log.read': serial(async ({ author, limit }) => {
      const r = await withStore((c) => member.logRead(c, { author: author === undefined ? null : author }))
      const all = r.entries
      const window = all.slice(Math.max(0, all.length - limit))
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
      return { key: r.key, entries, invalid, entriesTruncated: Math.max(0, all.length - limit) }
    }),

    'feed.read': serial(async ({ limit }) => {
      const r = await withStore((c) => member.feedRead(c, { limit }))
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

    'sync.start': serial(async ({ once, timeoutMs }, epoch) => {
      const gone = () => epoch !== connection
      if (gone()) throw rpcError('USAGE', 'conexão encerrada')
      if (run !== null) throw rpcError('USAGE', 'sincronização já em andamento')
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

    'sync.status': serial(async () => {
      restartWhenIdle(1)
      return syncState()
    })
  }

  // ---- host controls ----

  function attach (emit) {
    if (typeof emit !== 'function') throw new TypeError('emit required')
    emitter = emit
  }

  // The connection closed: no more events, and a running sync stops.
  function detach () {
    connection++
    emitter = null
    syncIntent = null
    return stopRun('stopped').then(noop)
  }

  // Stops accepting requests (later ones -> LOCKED 'sessão encerrada'),
  // stops the sync and awaits every queued operation. Idempotent. The
  // storage stays open: its owner (./node.js) closes it after this.
  function close () {
    if (closing !== null) return closing
    closed = true
    syncIntent = null
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
    close,
    // 'open' | 'closed'
    get state () {
      return closed ? 'closed' : 'open'
    }
  }
}

module.exports = { createBrowserSession, toRpcError, checkConfig, redactLogLine }
