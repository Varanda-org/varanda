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
//
// The identity key (web only): the diary's key pair is derived from the
// member's passkey by the page (lib/passkey.js) and handed to the session
// through the host control setKeyPair(); it lives in this closure only (the
// storage holds the public key, ./node-store.js), reaches member-ops as
// ctx.keyPair for the duration of one operation, and is zero-filled by
// clearKeyPair(), reset() and close(). Reads work locked; a write without
// the key is USAGE 'identidade bloqueada: entre com a passkey'. The only
// signature the session makes outside the diary is account.sign: the
// domain-separated account-link statement (@varanda/core lib/account-link.js,
// prefix 'varanda-account-link-v1'), whose member and association the
// session fills in itself, so a caller can never get arbitrary bytes, a
// certificate or a block signed. It returns the signature only.
//
// Single writer (docs/app.md): the same passkey opens the same diary on
// every device, so before every diary write the session makes sure this
// device holds what the seeder holds (ensureCaughtUp: skipped only while a
// live, verified continuous run tracks the own diary; else an internal once
// run must receive the seeder's hello and reach its advertised length), and
// after the write it sends the diary to the seeder (an internal once run,
// or the continuous run that restarts). The internal runs show as normal
// once runs (sync.started / sync.event / sync.stopped) with the lines
// 'sincronizando antes de publicar' / 'enviando ao semeador', and never
// touch the user's sync intent.
const b4a = require('b4a')
const { RpcError, isSafeMessage, capList, capSyncResult, clipText, MAX_LINE, MAX_ID } = require('@varanda/rpc')
const { validRecordCopy, validateRecord, parseRef } = require('@varanda/core/lib/records')
const { formatEvent, key8 } = require('@varanda/core/lib/sync-format')
const { safe } = require('@varanda/core/lib/safe')
const { UsageError } = require('@varanda/core/lib/errors')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { verifyUsernameRecord } = require('@varanda/core/lib/cert')
const { latestUsernameRecord } = require('@varanda/core/lib/username')
const member = require('./member-ops')
const { runSync } = require('./sync')
const store = require('./node-store')
const { checkSeederUrl } = require('./seeder-url')

const HEX64 = /^[0-9a-fA-F]{64}$/
const LOCKED_MESSAGE = 'diretório de dados em uso'
const CLOSED_MESSAGE = 'sessão encerrada'
const INTERNAL_MESSAGE = 'erro interno'
const NOT_SYNCED_MESSAGE = 'sincronize com o semeador antes de publicar'
const BAD_USERNAME_RECORD = 'registro de nome inválido'
const OLD_USERNAME_RECORD = 'registro de nome antigo'
const GATE_LINE = 'sincronizando antes de publicar'
const PUSH_LINE = 'enviando ao semeador'
// One deadline for the internal catch-up and push runs.
const WRITE_GATE_TIMEOUT_MS = 15000

const noop = () => {}

// ---- error mapping (A6), the table of @varanda/core lib/session.js ----

const USAGE_MESSAGES = new Set([
  'certificado já gravado',
  'grave o certificado de membro antes de publicar',
  'não é possível seguir a própria chave',
  'limite de diários seguidos atingido',
  'limite do diário atingido',
  'diretório não é de um membro',
  'associação diferente da configurada',
  store.LOCKED,
  store.MISMATCH,
  NOT_SYNCED_MESSAGE,
  BAD_USERNAME_RECORD,
  OLD_USERNAME_RECORD
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
// writeGate: the catch-up run before every diary write and the push run
// after it (test fixtures without a seeder pass false; the browser entry
// never passes it). writeGateTimeoutMs: their deadline (tests).
function createBrowserSession ({
  storage,
  association,
  seederUrl,
  createSocket,
  onInternalError = noop,
  syncOptions = {},
  limits,
  writeGate = true,
  writeGateTimeoutMs = WRITE_GATE_TIMEOUT_MS
} = {}) {
  const cfg = checkConfig({ storage, association, seederUrl, createSocket })
  const reportInternal = (err) => {
    try { onInternalError(err) } catch {}
  }

  function ctx () {
    return { storage, association: cfg.association, keyPair, limits }
  }

  let emitter = null
  let chain = Promise.resolve()
  let queued = 0 // operations accepted and not finished
  let closed = false
  let closing = null
  let run = null // { runId, once, internal, ownSynced, onOwnSynced, abort, reason, done }
  let lastRunId = 0
  let connection = 0 // epoch, bumped by detach()
  let syncIntent = null // 'continuous' while a user-started continuous run should be running
  // Own identity, cached once known (the key never changes; block 0 is
  // append-only, so only `memberCert: true` is cached).
  let ownKey = null
  let certKnown = false
  let diaryInfo = null // { publicKey, legacy } once the stored diary was looked at
  // The identity key pair (session-owned copies, zero-filled when cleared).
  let keyPair = null
  // Last own-sync verdict of a run: the own diary held what the verified
  // seeder advertised (or the seeder held nothing for the key).
  let synced = false
  // The seeder may not hold the diary's current length: set by every append
  // (and at start, unknown), cleared when a run confirms the local length
  // (a once run's seederConfirmed, or a continuous run's have/admitted for
  // the own key at the length of the last write). While set, every write
  // handler pushes, an idempotent one included.
  let unpushed = true
  let localLength = null // length after the last write here, when known

  function send (event, data) {
    const fn = emitter
    if (fn === null) return
    try { fn(event, data) } catch {}
  }

  function warning (text) {
    send('warning', { line: line(text) })
  }

  // ---- sync runs ----

  // internal: a gate or push run of the session itself (its line names it;
  // it never changes syncIntent). onOwnSynced: called on the run's first
  // own-synced. -> the run record.
  function startRun ({ once, timeoutMs, internal = false, label = null, onOwnSynced = noop }) {
    lastRunId = lastRunId >= MAX_ID ? 1 : lastRunId + 1
    const runId = lastRunId
    const { signal, abort } = createAbort()
    const r = { runId, once, internal, ownSynced: false, abort, reason: null, done: null }
    run = r
    send('sync.started', { runId, once })
    if (label !== null) send('sync.event', { runId, line: line(label) })
    const event = (text) => send('sync.event', { runId, line: line(text) })
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
            if (!ev) return
            switch (ev.event) {
              case 'skipped':
                warning('aviso: diário ' + key8(ev.key) + ' ignorado (' + safe(ev.reason) + ')')
                return
              case 'own-synced':
                synced = true
                event('diário próprio sincronizado (' + safe(String(ev.length)) + ')')
                if (!r.ownSynced) {
                  r.ownSynced = true
                  try { onOwnSynced() } catch {}
                }
                return
              case 'own-behind':
                synced = false
                r.ownSynced = false
                event('diário próprio atrasado (' + safe(String(ev.length)) + '/' + safe(String(ev.theirs)) + ')')
                return
              case 'link-closed':
                synced = false
                r.ownSynced = false
                return
              case 'own-recovered':
                certKnown = true
                event('certificado recuperado do semeador')
                return
              case 'have':
              case 'admitted':
                if (ev.key === ownKey && localLength !== null && ev.length >= localLength) unpushed = false
                break
              default:
                break
            }
            const text = formatEvent(ev)
            if (text !== null) event(text)
          },
          signal
        })
      } catch (err) {
        error = err
      }
      if (run === r) run = null
      if (error !== null) {
        if (!internal) syncIntent = null
        warning('erro: ' + toRpcError(error, reportInternal).message)
        send('sync.stopped', { runId, reason: 'error' })
        return
      }
      if (once && result && result.seederConfirmed === true) unpushed = false
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
    return r
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

  // ---- the write gate and the push ----

  // A live, verified continuous run that confirmed own-sync for the current
  // length (own-synced, and no own-behind or link loss since).
  function trackingOwn () {
    return run !== null && !run.once && run.ownSynced === true
  }

  // Before a diary write: this device must hold what the seeder holds for
  // its key. Unless a continuous run tracks it, an internal once run must
  // receive the seeder's hello and reach the advertised length (own-synced
  // from THAT run); it is stopped as soon as that happened. The user's sync
  // intent is restored whatever the outcome.
  // epoch: the handler's connection epoch; a client that detached while the
  // gate ran gets 'conexão encerrada' and nothing is written, and the sync
  // intent is restored only when nothing (detach) changed it meanwhile.
  async function ensureCaughtUp (epoch) {
    if (!writeGate || trackingOwn()) return
    if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
    if (run !== null) await stopRun('preempted')
    const intent = syncIntent
    synced = false
    let ok = false
    let arrived
    const caughtUp = new Promise((resolve) => { arrived = resolve })
    const r = startRun({
      once: true,
      timeoutMs: writeGateTimeoutMs,
      internal: true,
      label: GATE_LINE,
      onOwnSynced: () => {
        ok = true
        arrived()
      }
    })
    await Promise.race([caughtUp, r.done])
    await stopRun('preempted')
    if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
    syncIntent = intent
    if (!ok) throw new UsageError(NOT_SYNCED_MESSAGE)
  }

  // After a diary write (or any write handler while the seeder is not known
  // to hold the current length): the seeder receives it. A continuous run
  // that the write preempted restarts afterwards (restartWhenIdle) and
  // pushes; else an internal once run does, awaited so the caller knows it
  // ended (its outcome is in the sync.stopped event; the write stays either
  // way, and an unconfirmed push is retried on the next write).
  async function pushAfterWrite () {
    if (!writeGate || closed || !unpushed || syncIntent === 'continuous') return
    if (run !== null) await stopRun('preempted')
    const r = startRun({ once: true, timeoutMs: writeGateTimeoutMs, internal: true, label: PUSH_LINE })
    await r.done
  }

  // Marks the diary as having grown here to `length`.
  function wrote (seq) {
    localLength = seq + 1
    unpushed = true
  }

  // Writes need the identity AND the key; checked before any network run.
  async function requireUnlocked () {
    const own = await requireOwnKey()
    if (keyPair === null) throw new UsageError(store.LOCKED)
    return own
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
        followCount: (await store.readFollows(storage)).length,
        sync: syncState(),
        publicDht: false
      }
    }),

    'identity.create': serial(async () => {
      const r = await withStore((c) => member.idCreate(c))
      ownKey = r.publicKey
      // Only a diary made now is known not to be legacy; an existing one is
      // read from its header by identityStatus.
      if (r.created) {
        diaryInfo = { publicKey: r.publicKey, legacy: false }
        unpushed = true
      }
      return { publicKey: r.publicKey, association: r.association }
    }),

    'identity.show': serial(async () => {
      const r = await withStore((c) => member.idShow(c))
      ownKey = r.publicKey
      return { publicKey: r.publicKey, association: r.association }
    }),

    'cert.add': serial(async ({ cert }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.certAdd(c, cert))
      certKnown = true
      if (r.appended) wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq }
    }),

    // Signs the account-link statement with the in-memory key (docs/rpc.md
    // 5.18). Not a diary write: no withStore/ensureCaughtUp (they would
    // preempt a running sync for nothing), no append, no network, and the
    // key stays set. The result never carries the payload or a key.
    'account.sign': serial(async ({ phase, nonce, username, sub }) => {
      // The diary's key, without opening the store: setKeyPair forgets
      // ownKey, but diaryInfo (cached by identityStatus from the header)
      // still holds it, and the key never changes short of reset. Only a
      // node that has seen neither reads the store, which preempts a run as
      // node.info does, and restarts it the same way.
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      // A pair for another diary would only make a signature the service
      // refuses.
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      const signature = signAccountLink({ phase, nonce, member: own, username, association: cfg.association, sub }, keyPair)
      return { signature }
    }),

    'profile.set': serial(async ({ name, bio }, epoch) => {
      const own = await requireUnlocked()
      await ensureCaughtUp(epoch)
      const { seq } = await withStore((c) => member.profileSet(c, { name, bio }))
      wrote(seq)
      await pushAfterWrite()
      return { seq, ref: own + ':' + seq }
    }),

    // Appends an issuer-signed username record (docs/rpc.md 5.19). The record
    // must verify for the own key and the configured association. The gate
    // runs before the "already the latest" check, so a record another device
    // published (caught up here by the gate) is not appended again; a record
    // that already is the diary's latest verified one is not written, but is
    // still pushed while the seeder is not known to hold it (a push that
    // failed after the append is retried by handing the record in again).
    // The newest record by seq is the displayed name, so a record not newer
    // (by `date`) than the latest one is refused: an earlier name would
    // revert a rename, and two records of the same instant cannot be ordered.
    'username.add': serial(async ({ record }, epoch) => {
      const own = await requireUnlocked()
      if (!verifyUsernameRecord(record, own, cfg.association).ok) throw new UsageError(BAD_USERNAME_RECORD)
      await ensureCaughtUp(epoch)
      const { entries } = await withStore((c) => member.ownEntries(c))
      const latest = latestUsernameRecord(entries, own, cfg.association)
      if (latest !== null && member.deepEqual(latest, record)) {
        await pushAfterWrite()
        return { changed: false, username: record.username }
      }
      if (latest !== null && record.date <= latest.date) throw new UsageError(OLD_USERNAME_RECORD)
      const { seq } = await withStore((c) => member.usernameAdd(c, record))
      wrote(seq)
      await pushAfterWrite()
      return { changed: true, username: record.username, seq }
    }),

    'post.create': serial(async ({ text }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.postCreate(c, { text }))
      wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    'post.reply': serial(async ({ to, text }, epoch) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.postReply(c, { to: ref, text }))
      wrote(r.seq)
      await pushAfterWrite()
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
      const { runId } = startRun({ once, timeoutMs })
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

  // Every control below runs on the handler chain (serial), so none can
  // overlap an RPC on the same storage or an append signing with the key.

  function copyKey (buf, size) {
    if (!(buf instanceof Uint8Array) || buf.byteLength !== size) throw new TypeError('par de chaves inválido')
    const out = new Uint8Array(size)
    out.set(buf)
    return out
  }

  function zeroKeyPair () {
    if (keyPair === null) return
    keyPair.secretKey.fill(0)
    keyPair.publicKey.fill(0)
    keyPair = null
  }

  // Unlocks the identity with the pair derived from the passkey. The pair is
  // copied synchronously (the caller may zero its buffers right away); any
  // previous pair is zero-filled. The cached identity is forgotten so a
  // stored diary of another key surfaces on the next operation as USAGE
  // 'passkey não corresponde ao diário guardado'. Nothing is written.
  function setKeyPair (pair) {
    if (pair === null || typeof pair !== 'object') throw new TypeError('par de chaves inválido')
    const copy = { publicKey: copyKey(pair.publicKey, 32), secretKey: copyKey(pair.secretKey, 64) }
    return serial(async () => {
      zeroKeyPair()
      keyPair = copy
      synced = false
      ownKey = null
      certKnown = false
    })().catch((err) => {
      copy.secretKey.fill(0)
      copy.publicKey.fill(0)
      throw err
    })
  }

  // Locks the identity: the pair is zero-filled. After close() it already is.
  function clearKeyPair () {
    if (closing !== null) return closing.then(noop)
    return serial(async () => { zeroKeyPair() })()
  }

  // -> { exists, publicKey (hex | null), legacy, unlocked, synced }, from the
  // storage (cached once the diary was seen: its key never changes short of
  // reset) without the key pair, so a mismatch is reported, not thrown.
  const identityStatus = serial(async () => {
    if (diaryInfo === null) {
      const s = await withStore((c) => store.diaryStatus(c.storage))
      if (s.exists) {
        diaryInfo = { publicKey: s.publicKey, legacy: s.legacy }
        ownKey = s.publicKey
      }
      return { ...s, unlocked: keyPair !== null, synced }
    }
    return { exists: true, publicKey: diaryInfo.publicKey, legacy: diaryInfo.legacy, unlocked: keyPair !== null, synced }
  })

  // Removes the diary (every page, the oplog header slots of a legacy store
  // included) and locks; 'config' and 'follows' stay. A sync in progress is
  // stopped and not restarted.
  const reset = serial(async () => {
    syncIntent = null
    await stopRun('stopped')
    await storage.deleteCore(store.DIARY)
    store.forgetLegacy(storage)
    zeroKeyPair()
    ownKey = null
    certKnown = false
    diaryInfo = null
    synced = false
    unpushed = true
    localLength = null
  })

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
  // stops the sync (a gate run a write is waiting on included: that write
  // fails instead of holding the close for its deadline), awaits every
  // queued operation and zero-fills the key. Idempotent. The storage stays
  // open: its owner (./node.js) closes it after this.
  function close () {
    if (closing !== null) return closing
    closed = true
    syncIntent = null
    closing = (async () => {
      await stopRun('stopped')
      await chain
      await stopRun('stopped')
      zeroKeyPair()
    })()
    return closing
  }

  return {
    handlers,
    attach,
    detach,
    close,
    setKeyPair,
    clearKeyPair,
    identityStatus: () => identityStatus({}),
    reset: () => reset({}),
    // 'open' | 'closed'
    get state () {
      return closed ? 'closed' : 'open'
    }
  }
}

module.exports = { createBrowserSession, toRpcError, checkConfig, redactLogLine }
