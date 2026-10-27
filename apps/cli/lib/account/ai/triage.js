'use strict'

// apps/cli/lib/account/ai/triage.js: the pure triage rule for reports. Given
// one open report (its post's embedding plus a few facts about it) and the
// bank of human decisions taken on earlier reports, it says whether the AI
// may act alone ('bloquear' or 'descartar') or must leave the report open
// ('aberta') for a human, with a short code explaining why. No I/O, no model,
// no network, no clock: the embedder, the exemplar store, the daily caps and
// the moderation store all live elsewhere; this file only decides.
//
// Why the thresholds are strict. A block covers the whole diary key, not just
// one post (docs/design.md, "blocklist" item 3), and `mod apply --yes` can
// publish it without anyone reading it again (apps/cli/lib/mod-apply.js), so
// 'bloquear' is the stricter threshold and is limited to spam. A dismissal
// takes effect at once (the moderation store closes the report as soon as it
// is decided), so 'descartar' is strict too. The abstention design is the
// sum of: a cold-start minimum of human precedents per label, the same report
// reason only, votes from K distinct diaries (a diary never supplies its own
// votes, and five near copies from one other diary count once), unanimity
// among close neighbours (no opposing precedent inside the threshold) and a
// margin between the best supporting and best opposing similarity. Every
// case not covered by those rules stays with a human.
//
// The reporter's quote and comment are never inputs (they are the reporter's
// words, not the post's; packages/core/lib/report.js keeps them apart). The
// result's `nearest` is a cosine similarity in [-1, 1], never a percentage or
// a probability, and it is meant for the operator's panel only.

// The actor recorded on decisions the AI takes. It passes the moderation
// store's `validBy` (clean text, 1..254 chars) and is never an e-mail, so it
// cannot be mistaken for a moderator.
const AI_ACTOR = 'ia'

// Embedding width of the MiniLM model (paraphrase-multilingual-MiniLM-L12-v2
// sentence vectors).
const DIM = 384
// Distinct other diaries that must agree before the AI acts.
const K = 5
// Cold start: precedents needed for EACH label, same reason, before acting.
const MIN_PER_LABEL = 20
// Posts shorter than this (in code points) carry too little text to compare.
const MIN_TEXT_CP = 8
// Cosine thresholds: a supporter must be at least this close.
const T_BLOCK = 0.92
const T_DISCARD = 0.90
// The best opposing precedent must be at least this much further away.
const MARGIN = 0.12
// Daily caps, enforced by the worker (not here); exported so both agree.
const MAX_AI_BLOCKS_PER_DAY = 20
const MAX_AI_DISMISSALS_PER_DAY = 50
// Reasons for which each automatic action is allowed at all.
const BLOCK_REASONS = Object.freeze(['spam'])
const DISCARD_REASONS = Object.freeze(['spam', 'outro'])
// Notes stored on the AI's decisions (<= 280 code points, clean text).
const NOTE_BLOCK = 'IA: parecido com publicações que moderadores já mandaram bloquear'
const NOTE_DISCARD = 'IA: parecido com publicações cujas denúncias moderadores já descartaram'

function invalid () {
  const err = new Error('pedido-invalido')
  err.code = 'pedido-invalido'
  return err
}

// A plain array or a typed array (the stores accept Int8Array) of `len`
// finite numbers.
function isFiniteVector (v, len) {
  const ok = Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView))
  if (!ok || v.length !== len) return false
  for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x)) return false
  return true
}

// L2-normalises a vector into a new array. A zero vector stays zero (it has
// no direction, so every cosine against it is 0 and it never supports
// anything).
function normalize (v) {
  let sum = 0
  for (const x of v) sum += x * x
  const n = Math.sqrt(sum)
  if (!(n > 0) || !Number.isFinite(n)) return v.map(() => 0)
  return v.map(x => x / n)
}

// Stores a (normalised) vector as DIM small integers in [-127, 127].
function quantize (v) {
  if (!isFiniteVector(v, DIM)) throw invalid()
  return v.map(x => Math.max(-127, Math.min(127, Math.round(x * 127))))
}

// Exactly DIM integers in [-127, 127] (plain or typed array) -> plain floats.
// Anything else throws: a hole or a stray value must never become a component.
function dequantize (ints) {
  if (!isFiniteVector(ints, DIM)) throw invalid()
  const out = new Array(DIM)
  for (let i = 0; i < DIM; i++) {
    const x = ints[i]
    if (!Number.isInteger(x) || x < -127 || x > 127) throw invalid()
    out[i] = x / 127
  }
  return out
}

// Cosine of two unit vectors. Float rounding can push identical vectors to
// 1.0000000000000002; the ledger only accepts [-1, 1], so clamp.
function dot (a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return Math.max(-1, Math.min(1, s))
}

function open (code, nearest) {
  return { action: 'aberta', code, note: '', nearest: nearest === undefined ? null : nearest }
}

function decided (action, code, reason, nearest) {
  if (action === 'bloquear' && !BLOCK_REASONS.includes(reason)) return open('motivo', nearest)
  if (action === 'descartar' && !DISCARD_REASONS.includes(reason)) return open('motivo', nearest)
  return {
    action,
    code,
    note: action === 'bloquear' ? NOTE_BLOCK : NOTE_DISCARD,
    nearest: nearest === undefined ? null : nearest
  }
}

function distinctTargets (rows) {
  return new Set(rows.map(r => r.target)).size
}

// Per side: the best cosine per target among rows at or above `t` (one vote
// per diary), the best cosine overall and whether any row reaches `t`.
function side (scored, t) {
  const perTarget = new Map()
  let best = null
  for (const { row, cos } of scored) {
    if (best === null || cos > best) best = cos
    if (cos >= t) {
      const prev = perTarget.get(row.target)
      if (prev === undefined || cos > prev) perTarget.set(row.target, cos)
    }
  }
  return { votes: perTarget.size, best, any: perTarget.size > 0 }
}

// judge(input, opts) -> { action, code, note, nearest }. Rules run in order
// and the first match wins; see the header for the reasoning.
// `opts.minPerLabel` is a test-only override of the cold-start minimum
// (integer >= 1); production callers never pass it and nothing reads it from
// the environment.
function judge (input, opts = {}) {
  if (input === null || typeof input !== 'object') throw invalid()
  if (opts === null || typeof opts !== 'object') throw invalid()
  let minPerLabel = MIN_PER_LABEL
  if (opts.minPerLabel !== undefined) {
    if (!Number.isInteger(opts.minPerLabel) || opts.minPerLabel < 1) throw invalid()
    minPerLabel = opts.minPerLabel
  }

  // Cases the AI never decides alone, whatever the bank says.
  if (input.kind !== 'post') return open('conta')
  if (input.reason === 'ilegal') return open('ilegal')
  if (input.reason === 'assedio') return open('contexto')
  // These flags fail closed: anything but an explicit false abstains.
  if (input.hasMedia !== false) return open('midia')
  if (input.hasQuote !== false) return open('citacao')
  if (input.priorAi !== false) return open('recurso')
  if (input.truncated !== false) return open('truncado')
  if (!(typeof input.textCp === 'number' && input.textCp >= MIN_TEXT_CP)) return open('curto')

  // The bank: human decisions on the same reason, from other diaries only.
  // A precedent with photos never counts: the decision may have been about
  // the images, which the model never saw, so its caption alone must not
  // block or clear a text-only post. Quote-posts are kept out of the bank by
  // the caller: the worker (ai/worker.js) never turns one into an exemplar,
  // since the human may have judged the quoted post, which is not in the
  // vector. A row whose vector cannot be scored is dropped here, before the
  // cold-start count, so an unreadable opposing side can never look "warm".
  const exemplars = Array.isArray(input.exemplars) ? input.exemplars : []
  const bank = exemplars.filter(r => r !== null && typeof r === 'object' &&
    (r.decision === 'bloquear' || r.decision === 'descartar') &&
    r.reason === input.reason && r.target !== input.target && r.hasMedia !== true &&
    isFiniteVector(r.embedding, DIM))
  const blk = bank.filter(r => r.decision === 'bloquear')
  const dsc = bank.filter(r => r.decision === 'descartar')
  if (blk.length < minPerLabel || dsc.length < minPerLabel) return open('frio')

  const vec = isFiniteVector(input.embedding, DIM) ? normalize(Array.from(input.embedding)) : null
  const scoreOf = rows => rows
    .map(row => ({ row, cos: dot(vec, normalize(Array.from(row.embedding))) }))

  // Exact text needs a vector too: it must pass the same opposing-evidence
  // checks as the neighbour rule below (no fail-open shortcut).
  if (vec === null) return open('sem-vetor')

  const b = side(scoreOf(blk), T_BLOCK)
  const d = side(scoreOf(dsc), T_DISCARD)
  // Opposing rows inside the acting side's threshold break unanimity.
  const dAtBlock = side(scoreOf(dsc), T_BLOCK).any
  const bAtDiscard = side(scoreOf(blk), T_DISCARD).any

  // Exact text: rows with the same content hash. Disagreement goes to a
  // human. A block still needs K distinct other diaries (otherwise fall
  // through to the k-NN step, which has the same rule); a dismissal needs
  // one other diary. Either way the opposing side must stay clear: no
  // opposing row inside the acting threshold and the margin respected, as
  // in the k-NN step. Otherwise one dismissed copy could clear every
  // byte-identical copy even next to many blocked near-copies (and the
  // reverse for blocks).
  if (typeof input.contentHash === 'string' && input.contentHash.length > 0) {
    const same = bank.filter(r => r.contentHash === input.contentHash)
    if (same.length > 0) {
      const label = same[0].decision
      if (!same.every(r => r.decision === label)) return open('divergente')
      const near = side(scoreOf(same), Infinity).best
      if (label === 'descartar') {
        if (bAtDiscard) return open('divergente', near)
        if (b.best !== null && near !== null && b.best > near - MARGIN) return open('margem', near)
        return decided('descartar', 'exato', input.reason, near)
      }
      if (distinctTargets(same) >= K) {
        if (dAtBlock) return open('divergente', near)
        if (d.best !== null && near !== null && d.best > near - MARGIN) return open('margem', near)
        return decided('bloquear', 'exato', input.reason, near)
      }
    }
  }

  const blkK = b.votes >= K
  const dscK = d.votes >= K
  const blkOk = blkK && !dAtBlock && (d.best === null || d.best <= b.best - MARGIN)
  const dscOk = dscK && !bAtDiscard && (b.best === null || b.best <= d.best - MARGIN)

  if (blkOk && dscOk) return open('divergente')
  if (blkOk) return decided('bloquear', 'vizinhos', input.reason, b.best)
  if (dscOk) return decided('descartar', 'vizinhos', input.reason, d.best)
  const overall = b.best === null ? d.best : (d.best === null ? b.best : Math.max(b.best, d.best))
  if (blkK && dscK) return open('divergente', overall)
  if (blkK || dscK) return open('margem', overall)
  return open('sem-exemplo', overall)
}

module.exports = {
  AI_ACTOR,
  DIM,
  K,
  MIN_PER_LABEL,
  MIN_TEXT_CP,
  T_BLOCK,
  T_DISCARD,
  MARGIN,
  MAX_AI_BLOCKS_PER_DAY,
  MAX_AI_DISMISSALS_PER_DAY,
  BLOCK_REASONS,
  DISCARD_REASONS,
  NOTE_BLOCK,
  NOTE_DISCARD,
  normalize,
  quantize,
  dequantize,
  judge
}
