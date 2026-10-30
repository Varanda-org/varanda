'use strict'

// apps/cli/lib/account/ai/worker.js: the AI report triage's worker, the only
// piece that has side effects. It takes open reports from the moderation
// store, fetches the VERIFIED post text through the injected reader (never
// the reporter's quote), embeds it, asks the pure rule in ./triage what to do
// and either records a suggestion ('sombra' mode) or decides the report as
// 'ia' ('auto' mode) within daily caps. It also learns: every post report a
// human decides by hand becomes an exemplar, taken from the read cached when
// the report arrived, so the text is exactly what the moderator could see.
//
// Everything is injected (moderation store, exemplar store, ledger, reader,
// embedder, clock, logger), so tests run with fakes and no model. One serial
// in-process queue with a short gap between jobs: onReport, onHumanDecision,
// onCancel, onUnblock and start only enqueue and never throw, and nothing is
// decided in the caller's stack (the HTTP handler that received the report
// has long answered). stop() resolves when the running job ends, or after a
// bounded wait when a read hangs.
//
// Durable source of truth. The queue is memory; the moderation store is the
// truth. start() and a 10-minute timer (unref'd) scan the open reports in
// (at, id) order from an in-memory cursor, wrapping around, at most
// SCAN_LIMIT per scan, skipping reports whose ledger retryAt is still in the
// future. Failed reads back off (5 min, 1 h, 6 h, 24 h); a rule abstention
// is retried when the exemplar bank changed or after an hour, so a cold bank
// never hot-loops and a later human decision is picked up. A report that
// fails forever therefore never starves the ones behind it.
//
// What is never done here: unblock, cancel, pull, ack, or anything that signs
// or publishes. Blocks the AI decides still go through the operator's `mod
// apply`. Before deciding, the worker abstains when a human already touched
// the target (humanReversed, any pending change) or the target is already in
// the published list; those checks run in both modes.
//
// Appeals. A post the AI already decided on (target:seq, rebuilt at start
// from moderation.exportRows rows with decidedBy === AI_ACTOR, then kept in
// memory) is never decided by the AI again: a second report on it is an
// appeal and goes to a human ('recurso'). Nothing of that set lives in the
// ledger, so a crash cannot undercount it.
//
// Caps. Today's AI decisions (UTC day) are counted from exportRows at start,
// per action, and bumped in memory after each decision; the day rolls over in
// memory. If decide throws, the row is re-read: a row now decided by
// AI_ACTOR committed before the error and still counts.
//
// Learning. onHumanDecision(row) and the reconcile (every scan walks the
// cached reads: a row that vanished or was decided by the AI drops its read,
// a row decided by a human is learned) add an exemplar ONLY from a read
// captured before the decision (read.at < decidedAt), for a reason the AI may
// act on, without media, quote, truncation or short text, and with a vector.
// readPost and embed are never called at decision time: the text may be gone
// (the seeder purges a blocked diary) and would not be what the human saw.
// onCancel / onUnblock withdraw precedents a human reversed.
//
// Group messages (rows with a writer, report v2) are human-only: no scan,
// onReport, reconcile or learning step touches them, because readPost would
// read the author's diary at the writer core's seq, another block entirely.
//
// Logging: log({ event: 'triage', reason: <token> }) only. No text, quote,
// embedding, key, token or e-mail ever reaches the logger or an error.

const { blockedSet } = require('@varanda/core/lib/blocklist')
const { MAX_REPORTS } = require('../moderation-store')
const {
  judge,
  quantize,
  dequantize,
  AI_ACTOR,
  MIN_TEXT_CP,
  BLOCK_REASONS,
  DISCARD_REASONS,
  MAX_AI_BLOCKS_PER_DAY,
  MAX_AI_DISMISSALS_PER_DAY
} = require('./triage')

const MODES = ['sombra', 'auto']
// Reports processed per scan and cached reads reconciled per scan.
const SCAN_LIMIT = 200
const RECONCILE_LIMIT = 200
const SCAN_EVERY_MS = 10 * 60 * 1000
// Gap between jobs: each job makes at most one read, so 300 ms keeps a
// backlog under the seeder route's own budget (4/s, burst 8) instead of
// collecting 503s that would push reports into long backoff.
const GAP_MS = 300
const STOP_WAIT_MS = 20 * 1000
const RETRY_ABSTAIN_MS = 60 * 60 * 1000
// Backoff of failed reads by consecutive attempt (the last one repeats).
const BACKOFF_MS = Object.freeze([5 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000])
// Failure codes that follow the exponential backoff (never rerun early on a
// bank change): failed reads, and an embedder failure ('falha-ia').
const READ_FAIL_CODES = Object.freeze(['timeout', 'ausente', 'recusado', 'certificado', 'config', 'erro', 'falha-ia'])
const TOKEN_RE = /^[a-z0-9-]{1,32}$/
// Reasons whose verified text is embedded and learned from.
const ACTIONABLE_REASONS = Object.freeze([...new Set([...BLOCK_REASONS, ...DISCARD_REASONS])])

function isFn (f) {
  return typeof f === 'function'
}

// A short token for logs and marks; anything else becomes 'erro'.
function token (x) {
  return typeof x === 'string' && TOKEN_RE.test(x) ? x : 'erro'
}

function codeOf (err) {
  return token(err && err.code)
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function dayOf (iso) {
  return typeof iso === 'string' ? iso.slice(0, 10) : ''
}

function isGroupRow (row) {
  return row.writer !== undefined && row.writer !== null
}

function postKey (row) {
  return row.target + ':' + row.seq
}

// (at, id) order of report rows: the moderation store's 'aberta' order plus
// a total tie-break, so the cursor is unambiguous.
function order (a, b) {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// The policy codes the rule applies before any bank is consulted, mirrored
// here so a report can be marked (and the human checks run) before the
// embedder is paid for. `judge` re-checks every one of them.
function policyCode (row, read) {
  if (row.reason === 'ilegal') return 'ilegal'
  if (row.reason === 'assedio') return 'contexto'
  if (!ACTIONABLE_REASONS.includes(row.reason)) return 'motivo'
  if (read.hasMedia !== false) return 'midia'
  if (read.hasQuote !== false) return 'citacao'
  if (read.truncated !== false) return 'truncado'
  if (!(Number.isInteger(read.textCp) && read.textCp >= MIN_TEXT_CP)) return 'curto'
  return null
}

function createWorker ({
  mode = 'sombra',
  moderation,
  exemplars,
  ledger,
  readPost,
  embed,
  log = () => {},
  now = Date.now,
  modelId,
  judgeOpts = {},
  // Test seams: the gap between jobs and the bound on stop().
  gapMs = GAP_MS,
  stopWaitMs = STOP_WAIT_MS
} = {}) {
  if (!MODES.includes(mode)) throw new TypeError('mode must be sombra or auto')
  if (!moderation || !isFn(moderation.list) || !isFn(moderation.get) || !isFn(moderation.decide) ||
    !isFn(moderation.pending) || !isFn(moderation.exportRows)) {
    throw new TypeError('moderation store required')
  }
  if (!exemplars || !isFn(exemplars.add) || !isFn(exemplars.list) || !isFn(exemplars.size)) throw new TypeError('exemplar store required')
  if (!ledger || !isFn(ledger.get) || !isFn(ledger.mark) || !isFn(ledger.read) || !isFn(ledger.putRead) || !isFn(ledger.dropRead)) {
    throw new TypeError('ledger required')
  }
  if (!isFn(readPost) || !isFn(embed) || !isFn(log) || !isFn(now)) throw new TypeError('readPost, embed, log and now must be functions')
  if (modelId !== undefined && typeof modelId !== 'string') throw new TypeError('modelId must be a string')
  if (judgeOpts === null || typeof judgeOpts !== 'object') throw new TypeError('judgeOpts must be an object')

  // Serial queue state.
  let chain = Promise.resolve()
  let running = null
  let stopped = false
  let started = false
  let timer = null
  const queued = new Set()
  // Scan state.
  let cursor = null
  let reconcileFrom = 0
  // Appeal set and daily counters, both derived from moderation.json at
  // start and kept in memory afterwards.
  const decidedPosts = new Set()
  const counts = { day: '', bloquear: 0, descartar: 0 }
  // Set when the exemplar store was written by another model: scoring and
  // learning stay off for the rest of the process (reads still happen, so
  // the panel keeps its verified text).
  let disabled = false

  function emit (reason) {
    try {
      log({ event: 'triage', reason: token(reason) })
    } catch {}
  }

  function iso (ms) {
    return new Date(ms).toISOString()
  }

  function today () {
    return dayOf(iso(now()))
  }

  function bump (action) {
    const day = today()
    if (counts.day !== day) {
      counts.day = day
      counts.bloquear = 0
      counts.descartar = 0
    }
    if (action) counts[action]++
  }

  function capped (action) {
    bump(null)
    if (action === 'bloquear') return counts.bloquear >= MAX_AI_BLOCKS_PER_DAY
    return counts.descartar >= MAX_AI_DISMISSALS_PER_DAY
  }

  // ---- queue ---------------------------------------------------------

  // Appends a job. A thrown job never breaks the chain: its code is logged
  // (tokens only) and the next job still runs after the gap.
  function enqueue (fn) {
    if (stopped) return
    chain = chain.then(async () => {
      if (stopped) return
      // An async wrapper turns a synchronous throw into a rejection too.
      running = (async () => fn())()
      try {
        await running
      } catch (err) {
        emit(codeOf(err))
      } finally {
        running = null
      }
      if (!stopped && gapMs > 0) await sleep(gapMs)
    })
  }

  // Resolves when the queue has drained, including jobs that running jobs
  // enqueue (a scan enqueues its report jobs).
  async function idle () {
    let c
    do {
      c = chain
      await c
    } while (c !== chain)
  }

  function aborted () {
    const err = new Error('parado')
    err.code = 'parado'
    return err
  }

  // ---- marks --------------------------------------------------------

  function markAbstain (id, code, extra = {}) {
    ledger.mark(id, {
      code: token(code),
      retryAt: iso(now() + RETRY_ABSTAIN_MS),
      suggestion: null,
      nearest: null,
      exemplars: safeSize(),
      ...extra
    })
  }

  function markFailed (id, code) {
    const prev = ledger.get(id)
    const attempts = (prev ? prev.attempts : 0) + 1
    const wait = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]
    ledger.mark(id, { code: token(code), retryAt: iso(now() + wait), attempts, suggestion: null, nearest: null })
  }

  function safeSize () {
    try {
      return exemplars.size()
    } catch {
      return 0
    }
  }

  // ---- human checks (amendment e) -------------------------------------

  // 'humano-revisou' when a human reversed a block of the target or any
  // change on it is pending; 'ja-bloqueado' when the target is published as
  // blocked; null otherwise. A store without humanReversed fails closed.
  function humanCode (target) {
    if (!isFn(moderation.humanReversed) || moderation.humanReversed(target) === true) return 'humano-revisou'
    const p = moderation.pending()
    if (p.changes.some((c) => c.member === target)) return 'humano-revisou'
    if (blockedSet(p.published.snapshot).has(target)) return 'ja-bloqueado'
    return null
  }

  // Was this post (target:seq) already decided in another report, by a
  // human or by the AI? Then a new report is an appeal and goes to a human:
  // the AI must never block a post a moderator dismissed (a second reporter
  // would otherwise turn a human 'descartar' into an automatic block).
  // Read from moderation.json itself, so nothing is lost across restarts.
  function decidedBefore (row) {
    for (const r of moderation.exportRows({ member: row.target })) {
      if (r.id !== row.id && r.target === row.target && r.kind === 'post' && !isGroupRow(r) && r.seq === row.seq && r.status !== 'aberta') return true
    }
    return false
  }

  // Does a block of `target` stand right now? Its last pending change
  // decides; with none, the published list does.
  function blockStands (target) {
    const p = moderation.pending()
    let last = null
    for (const c of p.changes) if (c.member === target) last = c
    if (last !== null) return last.op === 'block'
    return blockedSet(p.published.snapshot).has(target)
  }

  // ---- one report ---------------------------------------------------

  // Reads the post, or reuses the cached verified read (a post at a given
  // seq never changes), caching a fresh read at once with no vector: the
  // text must survive a later block and the seeder's purge, and a failed
  // embed must not lose it. null means the job already marked the report.
  async function fetchRead (row) {
    const cached = ledger.read(row.id)
    if (cached !== null && cached.target === row.target && cached.seq === row.seq) return cached
    let r
    try {
      r = await readPost({ diaryKey: row.target, seq: row.seq })
    } catch (err) {
      markFailed(row.id, codeOf(err))
      return null
    }
    if (stopped) throw aborted()
    if (!r || r.ok !== true) {
      markFailed(row.id, r && READ_FAIL_CODES.includes(r.code) ? r.code : 'erro')
      return null
    }
    // The ledger refuses text it cannot store (a reader bug); mark and back
    // off instead of throwing out of the job and rescanning forever.
    try {
      return putFreshRead(row, r)
    } catch (err) {
      markFailed(row.id, 'erro')
      return null
    }
  }

  function putFreshRead (row, r) {
    return ledger.putRead(row.id, {
      at: iso(now()),
      target: row.target,
      seq: row.seq,
      contentHash: r.contentHash,
      text: r.text,
      hasMedia: r.hasMedia === true,
      hasQuote: r.hasQuote === true,
      textCp: r.textCp,
      truncated: r.truncated === true,
      embedding: null
    })
  }

  // Embeds the cached text once (the vector is stored quantized before any
  // judgement). A text the model cannot take whole is cached as truncated
  // with no vector. null means the job already marked the report.
  async function ensureEmbedding (row, read) {
    if (read.embedding !== null) return read
    let e
    try {
      e = await embed(read.text)
    } catch (err) {
      markFailed(row.id, codeOf(err))
      return null
    }
    if (stopped) throw aborted()
    const next = { ...read }
    if (!e || e.truncated === true || e.embedding === null || e.embedding === undefined) {
      next.truncated = true
      next.embedding = null
    } else {
      next.embedding = quantize(Array.from(e.embedding))
    }
    try {
      return ledger.putRead(row.id, next)
    } catch (err) {
      markFailed(row.id, 'erro')
      return null
    }
  }

  async function processReport (id) {
    const row = moderation.get(id)
    if (row === null || row.status !== 'aberta') {
      ledger.mark(id, { code: 'ja-decidida', retryAt: null, suggestion: null, nearest: null })
      return
    }
    if (isGroupRow(row)) return
    if (row.kind !== 'post') return markAbstain(id, 'conta')
    if (decidedPosts.has(postKey(row)) || decidedBefore(row)) return markAbstain(id, 'recurso')

    let read = await fetchRead(row)
    if (read === null) return
    // A successful read ends the failure streak.
    const base = { attempts: 0 }
    const policy = policyCode(row, read)
    if (policy !== null) return markAbstain(id, policy, base)
    if (disabled) return markAbstain(id, 'modelo', base)
    // Embed BEFORE the human checks: a case a human is handling may still
    // become a precedent once they decide it, and learning needs the vector
    // captured now (the seeder may purge the diary after a block).
    read = await ensureEmbedding(row, read)
    if (read === null) return
    const human = humanCode(row.target)
    if (human !== null) return markAbstain(id, human, base)

    let bank
    try {
      const suspended = pendingUnblocks()
      bank = exemplars.list({ reason: row.reason })
        .filter((r) => !(r.decision === 'bloquear' && suspended.has(r.target)))
        .map((r) => ({ ...r, embedding: dequantize(r.embedding) }))
    } catch (err) {
      if (err.code === 'modelo') {
        disabled = true
        emit('modelo')
        return markAbstain(id, 'modelo', base)
      }
      throw err
    }
    const verdict = judge({
      kind: row.kind,
      reason: row.reason,
      hasMedia: read.hasMedia,
      hasQuote: read.hasQuote,
      textCp: read.textCp,
      truncated: read.truncated,
      priorAi: false,
      target: row.target,
      contentHash: read.contentHash,
      embedding: read.embedding === null ? null : dequantize(read.embedding),
      exemplars: bank
    }, judgeOpts)
    const size = exemplars.size()
    if (verdict.action === 'aberta') {
      return markAbstain(id, verdict.code, { ...base, nearest: verdict.nearest, exemplars: size })
    }
    // The human checks ran before the (slow) embed: a moderator may have
    // cancelled, unblocked or queued a change on this target since. Check
    // again before recording a suggestion or writing a decision, so the AI
    // never overrides (or suggests against) that, in both modes.
    const humanNow = humanCode(row.target)
    if (humanNow !== null) return markAbstain(id, humanNow, { ...base, nearest: verdict.nearest, exemplars: size })
    // Same for the appeal test: a moderator may have decided another report
    // of this very post during the read or the embed.
    if (decidedPosts.has(postKey(row)) || decidedBefore(row)) return markAbstain(id, 'recurso', { ...base, nearest: verdict.nearest, exemplars: size })
    if (mode === 'sombra') {
      return ledger.mark(id, {
        code: 'sombra',
        retryAt: iso(now() + RETRY_ABSTAIN_MS),
        attempts: 0,
        exemplars: size,
        suggestion: verdict.action,
        nearest: verdict.nearest
      })
    }
    if (capped(verdict.action)) {
      return markAbstain(id, 'teto-' + verdict.action, { ...base, nearest: verdict.nearest, exemplars: size })
    }
    if (stopped) throw aborted()
    let committed = false
    try {
      await moderation.decide(id, { decision: verdict.action, by: AI_ACTOR, note: verdict.note })
      committed = true
    } catch (err) {
      if (err && err.code === 'nao-encontrado') {
        // A human decided first: nothing to count.
        return ledger.mark(id, { code: 'ja-decidida', retryAt: null, attempts: 0, suggestion: null, nearest: null })
      }
      if (err && err.code === 'lotado') return markAbstain(id, 'lotado', { ...base, nearest: verdict.nearest, exemplars: size })
      // The write may have committed before the error: the row decides.
      const after = moderation.get(id)
      if (after !== null && after.status === verdict.action && after.decidedBy === AI_ACTOR) committed = true
      else {
        markFailed(id, codeOf(err))
        return
      }
    }
    if (committed) {
      bump(verdict.action)
      decidedPosts.add(postKey(row))
      emit(verdict.action)
      ledger.mark(id, {
        code: verdict.action,
        retryAt: null,
        attempts: 0,
        exemplars: size,
        suggestion: verdict.action,
        nearest: verdict.nearest
      })
    }
  }

  // A job wrapper: an unexpected throw inside a report job still leaves a
  // backoff mark (when the ledger can be written) and only a token in logs.
  async function reportJob (id) {
    queued.delete(id)
    try {
      await processReport(id)
    } catch (err) {
      if (err && err.code === 'parado') return
      try {
        markFailed(id, codeOf(err))
      } catch {}
      throw err
    }
  }

  function enqueueReport (id) {
    if (typeof id !== 'string' || queued.has(id)) return
    queued.add(id)
    enqueue(() => reportJob(id))
  }

  // ---- learning -----------------------------------------------------

  // Adds one exemplar from the cached read of a report a human decided.
  // Returns true when an exemplar was written.
  function learn (row) {
    if (disabled || row === null || typeof row !== 'object') return false
    if (row.kind !== 'post' || isGroupRow(row) || row.status === 'aberta' || row.decidedBy === AI_ACTOR) return false
    if (!ACTIONABLE_REASONS.includes(row.reason)) return false
    const read = ledger.read(row.id)
    if (read === null) return false
    if (!(typeof row.decidedAt === 'string' && read.at < row.decidedAt)) return false
    if (read.hasMedia || read.hasQuote || read.truncated || read.textCp < MIN_TEXT_CP || read.embedding === null) return false
    if (read.target !== row.target || read.seq !== row.seq) return false
    // A block a human has since cancelled or undone must never become a
    // precedent (the reconcile would otherwise re-learn it after onCancel
    // removed it). The test is whether the block STANDS now, not the sticky
    // member-level humanReversed (which would also refuse a later, valid
    // human block of the same person).
    if (row.status === 'bloquear' && !blockStands(row.target)) {
      ledger.dropRead(row.id)
      return false
    }
    try {
      exemplars.add({
        reportId: row.id,
        target: row.target,
        seq: row.seq,
        reason: row.reason,
        decision: row.status,
        contentHash: read.contentHash,
        text: read.text,
        hasMedia: read.hasMedia,
        embedding: read.embedding
      })
    } catch (err) {
      if (err.code === 'modelo') {
        disabled = true
        emit('modelo')
        return false
      }
      throw err
    }
    ledger.dropRead(row.id)
    return true
  }

  function humanDecisionJob (report) {
    const id = report && typeof report.id === 'string' ? report.id : null
    if (id === null) return
    const row = moderation.get(id) || report
    settleDecided(row)
  }

  // A human-decided row: learn from its cached read, or drop the read when
  // it can never teach (ilegal, assedio, media, quote, short, text cached
  // after the decision...), so no verified text outlives the decision in
  // triage.json. Kept only while learning is disabled (model mismatch).
  function settleDecided (row) {
    if (learn(row)) return
    if (!disabled) ledger.dropRead(row.id)
  }

  // Walks a bounded window of the cached reads, wrapping around, and
  // settles each against the moderation store (amendment c).
  function reconcile () {
    const ids = ledger.readIds()
    if (ids.length === 0) {
      reconcileFrom = 0
      return
    }
    if (reconcileFrom >= ids.length) reconcileFrom = 0
    const n = Math.min(RECONCILE_LIMIT, ids.length)
    for (let k = 0; k < n; k++) {
      const id = ids[(reconcileFrom + k) % ids.length]
      const row = moderation.get(id)
      if (row === null) {
        ledger.dropRead(id)
        continue
      }
      if (row.status === 'aberta') continue
      if (row.decidedBy === AI_ACTOR || isGroupRow(row)) {
        ledger.dropRead(id)
        continue
      }
      settleDecided(row)
    }
    reconcileFrom = (reconcileFrom + n) % ids.length
  }

  // ---- scans --------------------------------------------------------

  // Is this open report due? Failed reads honour their backoff; rule
  // abstentions also rerun when the bank changed since they were marked.
  function due (id, size, nowIso) {
    const m = ledger.get(id)
    if (m === null || m.retryAt === null || m.retryAt <= nowIso) return true
    if (READ_FAIL_CODES.includes(m.code)) return false
    return m.exemplars !== size
  }

  // Removes block precedents whose block is gone for good: no pending change
  // for the member and the member is not in the published list. A cancel or
  // an unblock that happened while triage was off (or whose hook failed)
  // never reached onCancel/onUnblock, so this runs at start, on every scan
  // and after onUnblock. A member with a pending UNBLOCK is not pruned yet
  // (a moderator may still cancel that unblock); its precedents are only
  // left out of the bank meanwhile (pendingUnblocks).
  function pruneReversed () {
    if (disabled) return
    const p = moderation.pending()
    const hasPending = new Set(p.changes.map((c) => c.member))
    const published = blockedSet(p.published.snapshot)
    for (const e of exemplars.list()) {
      if (e.decision !== 'bloquear') continue
      if (!hasPending.has(e.target) && !published.has(e.target)) exemplars.remove(e.reportId)
    }
  }

  // Members whose last pending change is an unblock: their block precedents
  // are suspended from the bank until the unblock is applied or cancelled.
  function pendingUnblocks () {
    const last = new Map()
    for (const c of moderation.pending().changes) last.set(c.member, c.op)
    const out = new Set()
    for (const [member, op] of last) if (op === 'unblock') out.add(member)
    return out
  }

  function scan () {
    try {
      pruneReversed()
    } catch (err) {
      emit(codeOf(err))
    }
    try {
      reconcile()
    } catch (err) {
      emit(codeOf(err))
    }
    const open = moderation.list({ status: 'aberta', limit: MAX_REPORTS }).reports.slice().sort(order)
    if (open.length === 0) return
    let start = 0
    if (cursor !== null) {
      start = open.findIndex((r) => order(r, cursor) > 0)
      if (start === -1) start = 0
    }
    const size = safeSize()
    const nowIso = iso(now())
    let picked = 0
    let last = null
    for (let k = 0; k < open.length && picked < SCAN_LIMIT; k++) {
      const r = open[(start + k) % open.length]
      if (isGroupRow(r) || !due(r.id, size, nowIso)) continue
      enqueueReport(r.id)
      picked++
      last = { at: r.at, id: r.id }
    }
    if (last !== null) cursor = last
  }

  // Rebuilds the appeal set and today's counters from the store (once per
  // process; never per report).
  function seed () {
    const rows = moderation.exportRows()
    const day = today()
    counts.day = day
    counts.bloquear = 0
    counts.descartar = 0
    for (const r of rows) {
      if (r.decidedBy !== AI_ACTOR) continue
      if (r.kind === 'post' && r.seq !== null && !isGroupRow(r)) decidedPosts.add(postKey(r))
      if (dayOf(r.decidedAt) === day && (r.status === 'bloquear' || r.status === 'descartar')) counts[r.status]++
    }
  }

  // ---- public surface -------------------------------------------------

  function onReport (report) {
    try {
      if (report && typeof report.id === 'string' && !isGroupRow(report)) enqueueReport(report.id)
    } catch {}
  }

  function onHumanDecision (report) {
    try {
      if (!report || report.decidedBy === AI_ACTOR || isGroupRow(report)) return
      enqueue(() => humanDecisionJob(report))
    } catch {}
  }

  function onCancel (change) {
    try {
      const ids = change && Array.isArray(change.reportIds) ? change.reportIds.slice() : []
      if (ids.length === 0) return
      enqueue(() => {
        for (const id of ids) {
          try {
            exemplars.remove(id)
          } catch (err) {
            if (err.code !== 'pedido-invalido') throw err
          }
          // Drop its cached read too, so no later reconcile re-learns it.
          try {
            ledger.dropRead(id)
          } catch {}
        }
      })
    } catch {}
  }

  function onUnblock (member) {
    try {
      if (typeof member !== 'string') return
      // Not removed here: the unblock is only pending and a moderator may
      // still cancel it. Its precedents are suspended from the bank while it
      // is pending, and pruneReversed removes them once it is applied.
      enqueue(() => pruneReversed())
    } catch {}
  }

  function start () {
    try {
      if (started || stopped) return
      started = true
      enqueue(() => {
        seed()
        scan()
      })
      timer = setInterval(() => enqueue(scan), SCAN_EVERY_MS)
      if (timer && isFn(timer.unref)) timer.unref()
    } catch {}
  }

  // One scan now; resolves when the queue has drained.
  function runOnce () {
    enqueue(scan)
    return idle()
  }

  function stop () {
    stopped = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    // The bound timer stays ref'd on purpose: it is what lets a shutdown
    // give up on a read that never returns.
    const current = running === null ? Promise.resolve() : running.catch(() => {})
    let t
    const bound = new Promise((resolve) => {
      t = setTimeout(resolve, stopWaitMs)
    })
    return Promise.race([current, bound]).then(() => clearTimeout(t))
  }

  // For the panel's projection of one report (tokens and numbers only).
  function suggestionOf (id) {
    let m
    try {
      m = ledger.get(id)
    } catch {
      return null
    }
    if (m === null) return null
    return {
      sugestao: m.suggestion,
      semelhanca: m.nearest === null ? null : Math.round(m.nearest * 100) / 100,
      vizinhos: m.exemplars,
      motivo: m.code,
      modo: mode
    }
  }

  // The verified text the panel shows (cached at arrival), or null.
  function verifiedOf (id) {
    let r
    try {
      r = ledger.read(id)
    } catch {
      return null
    }
    if (r === null) return null
    return { texto: r.text, midia: r.hasMedia, citacao: r.hasQuote }
  }

  return { onReport, onHumanDecision, onCancel, onUnblock, suggestionOf, verifiedOf, start, runOnce, idle, stop }
}

module.exports = {
  SCAN_LIMIT,
  RECONCILE_LIMIT,
  SCAN_EVERY_MS,
  BACKOFF_MS,
  RETRY_ABSTAIN_MS,
  createWorker
}
