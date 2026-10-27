'use strict'

// apps/cli/lib/account/ai/triage.js: the pure triage rule. Every vector here
// is an injected 384-d one-hot or two-axis mixture, so cosines are exact and
// no model, socket or server is ever opened.

const test = require('brittle')
const {
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
} = require('../lib/account/ai/triage')

const SELF = 'self-diary'

// One-hot on axis i.
function e (i) {
  const v = new Array(DIM).fill(0)
  v[i] = 1
  return v
}

// Unit vector whose cosine with e(0) is exactly `c` (second axis j >= 1).
function near (c, j) {
  const v = new Array(DIM).fill(0)
  v[0] = c
  v[j] = Math.sqrt(1 - c * c)
  return v
}

function cos (a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// Far filler: n rows of one decision, each from its own diary, orthogonal to
// e(0) (axes 200.. for bloquear, 300.. for descartar, cycling).
function filler (decision, n, reason = 'spam') {
  const base = decision === 'bloquear' ? 200 : 300
  const rows = []
  for (let i = 0; i < n; i++) {
    rows.push({
      decision,
      reason,
      target: decision + '-far-' + i,
      contentHash: decision + '-far-hash-' + i,
      embedding: e(base + (i % 80))
    })
  }
  return rows
}

// A warm bank (MIN_PER_LABEL of each label, all far away).
function warm (reason = 'spam') {
  return filler('bloquear', MIN_PER_LABEL, reason).concat(filler('descartar', MIN_PER_LABEL, reason))
}

// n near rows of one decision at cosine c, from n distinct diaries (or one
// diary when `oneTarget` is given).
function nearRows (decision, n, c, opts = {}) {
  const rows = []
  for (let i = 0; i < n; i++) {
    rows.push({
      decision,
      reason: opts.reason || 'spam',
      target: opts.oneTarget || (decision + '-near-' + i + (opts.tag || '')),
      contentHash: opts.hash || (decision + '-near-hash-' + i + (opts.tag || '')),
      embedding: near(c, 10 + i + (opts.axis || 0))
    })
  }
  return rows
}

function input (over = {}) {
  return {
    kind: 'post',
    reason: 'spam',
    hasMedia: false,
    hasQuote: false,
    textCp: 40,
    truncated: false,
    priorAi: false,
    target: SELF,
    contentHash: 'query-hash',
    embedding: e(0),
    exemplars: warm(),
    ...over
  }
}

function cp (s) {
  return [...s].length
}

test('constants match the approved plan', (t) => {
  t.is(AI_ACTOR, 'ia')
  t.ok(!AI_ACTOR.includes('@'))
  t.is(DIM, 384)
  t.is(K, 5)
  t.is(MIN_PER_LABEL, 20)
  t.is(MIN_TEXT_CP, 8)
  t.is(T_BLOCK, 0.92)
  t.is(T_DISCARD, 0.90)
  t.is(MARGIN, 0.12)
  t.is(MAX_AI_BLOCKS_PER_DAY, 20)
  t.is(MAX_AI_DISMISSALS_PER_DAY, 50)
  t.alike([...BLOCK_REASONS], ['spam'])
  t.alike([...DISCARD_REASONS], ['spam', 'outro'])
})

test('notes are well-formed', (t) => {
  for (const note of [NOTE_BLOCK, NOTE_DISCARD]) {
    t.ok(typeof note === 'string' && note.length > 0)
    t.ok(cp(note) <= 280)
    t.ok(!note.includes('<') && !note.includes('>'))
    for (const ch of note) {
      const c = ch.codePointAt(0)
      t.ok(c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c < 0xa0), 'no control characters')
    }
  }
  t.is(NOTE_BLOCK, 'IA: parecido com publicações que moderadores já mandaram bloquear')
  t.is(NOTE_DISCARD, 'IA: parecido com publicações cujas denúncias moderadores já descartaram')
})

test('normalize, quantize, dequantize', (t) => {
  const v = normalize([3, 4].concat(new Array(DIM - 2).fill(0)))
  t.ok(Math.abs(v[0] - 0.6) < 1e-12 && Math.abs(v[1] - 0.8) < 1e-12)
  const z = normalize(new Array(DIM).fill(0))
  t.ok(z.every(x => x === 0), 'zero vector stays zero')

  const u = normalize(Array.from({ length: DIM }, (_, i) => Math.sin(i + 1)))
  const q = quantize(u)
  t.is(q.length, DIM)
  t.ok(q.every(x => Number.isInteger(x) && x >= -127 && x <= 127))
  const back = normalize(dequantize(q))
  t.ok(cos(u, back) > 0.999, 'round trip keeps cos > 0.999')

  const big = quantize([2, -2].concat(new Array(DIM - 2).fill(0)))
  t.is(big[0], 127)
  t.is(big[1], -127)

  t.exception(() => quantize([1, 2, 3]), 'wrong length throws')
  try { quantize(new Array(DIM).fill(NaN)) } catch (err) { t.is(err.code, 'pedido-invalido') }
})

test('never-rules come first, each with its code', (t) => {
  // Even with an overwhelming bloquear bank, these never act.
  const strong = warm().concat(nearRows('bloquear', 10, 0.99))
  const cases = [
    [{ kind: 'conta' }, 'conta'],
    [{ reason: 'ilegal' }, 'ilegal'],
    [{ reason: 'assedio' }, 'contexto'],
    [{ hasMedia: true }, 'midia'],
    [{ hasQuote: true }, 'citacao'],
    [{ priorAi: true }, 'recurso'],
    [{ truncated: true }, 'truncado'],
    [{ textCp: MIN_TEXT_CP - 1 }, 'curto']
  ]
  for (const [over, code] of cases) {
    const r = judge(input({ exemplars: strong, ...over }))
    t.is(r.action, 'aberta', code)
    t.is(r.code, code)
    t.is(r.note, '')
    t.is(r.nearest, null)
  }
  // Exactly MIN_TEXT_CP is long enough.
  t.is(judge(input({ exemplars: strong, textCp: MIN_TEXT_CP })).action, 'bloquear')
})

test('assedio and ilegal never auto, even with matching banks', (t) => {
  for (const reason of ['assedio', 'ilegal']) {
    const bank = warm(reason).concat(nearRows('bloquear', 10, 0.99, { reason }))
    t.is(judge(input({ reason, exemplars: bank })).action, 'aberta')
    const bank2 = warm(reason).concat(nearRows('descartar', 10, 0.99, { reason }))
    t.is(judge(input({ reason, exemplars: bank2 })).action, 'aberta')
  }
})

test('media never auto', (t) => {
  const bank = warm().concat(nearRows('descartar', 10, 0.99))
  const r = judge(input({ hasMedia: true, exemplars: bank }))
  t.is(r.action, 'aberta')
  t.is(r.code, 'midia')
})

test('cold start: 19 of one label is frio', (t) => {
  const near5 = nearRows('bloquear', K, 0.99)
  const short = filler('bloquear', MIN_PER_LABEL - 1 - K).concat(near5, filler('descartar', MIN_PER_LABEL))
  t.is(short.filter(r => r.decision === 'bloquear').length, MIN_PER_LABEL - 1)
  t.is(judge(input({ exemplars: short })).code, 'frio')

  const shortD = filler('bloquear', MIN_PER_LABEL).concat(filler('descartar', MIN_PER_LABEL - 1), near5)
  t.is(judge(input({ exemplars: shortD })).code, 'frio')

  // Other reasons and the query's own diary do not count toward warmth.
  const mixed = filler('bloquear', MIN_PER_LABEL, 'outro').concat(filler('descartar', MIN_PER_LABEL), near5)
  t.is(judge(input({ exemplars: mixed })).code, 'frio')
  const own = filler('bloquear', MIN_PER_LABEL).map(r => ({ ...r, target: SELF }))
    .concat(filler('descartar', MIN_PER_LABEL), near5)
  t.is(judge(input({ exemplars: own })).code, 'frio')

  t.is(judge(input({ exemplars: [] })).code, 'frio')
})

test('K boundary: K distinct diaries block, K - 1 do not', (t) => {
  const yes = judge(input({ exemplars: warm().concat(nearRows('bloquear', K, 0.95)) }))
  t.is(yes.action, 'bloquear')
  t.is(yes.code, 'vizinhos')
  t.is(yes.note, NOTE_BLOCK)
  t.ok(Math.abs(yes.nearest - 0.95) < 1e-9)

  const no = judge(input({ exemplars: warm().concat(nearRows('bloquear', K - 1, 0.95)) }))
  t.is(no.action, 'aberta')
  t.is(no.code, 'sem-exemplo')
  t.is(no.note, '')

  // Exactly at the threshold counts; just under does not.
  const at = judge(input({ exemplars: warm().concat(nearRows('bloquear', K, T_BLOCK)) }))
  t.is(at.action, 'bloquear')
  const under = judge(input({ exemplars: warm().concat(nearRows('bloquear', K, T_BLOCK - 0.001)) }))
  t.is(under.code, 'sem-exemplo')
})

test('precedents with photos never count', (t) => {
  // Five near bloquear rows whose decision may have been about the images:
  // excluded from the bank, so a text-only post with the same caption stays
  // open instead of being blocked on the caption alone.
  const media = nearRows('bloquear', K, 0.99).map(r => ({ ...r, hasMedia: true }))
  const r = judge(input({ exemplars: warm().concat(media) }))
  t.is(r.action, 'aberta')
  t.is(r.code, 'sem-exemplo')

  // They do not even count toward the cold-start minimum.
  const cold = filler('bloquear', MIN_PER_LABEL).map(x => ({ ...x, hasMedia: true }))
    .concat(filler('descartar', MIN_PER_LABEL))
  t.is(judge(input({ exemplars: cold })).code, 'frio')
})

test('safety flags fail closed', (t) => {
  const bank = warm().concat(nearRows('bloquear', K, 0.99))
  for (const [flag, code] of [['hasMedia', 'midia'], ['hasQuote', 'citacao'], ['priorAi', 'recurso'], ['truncated', 'truncado']]) {
    for (const v of [undefined, null, 1, 'false']) {
      const inp = input({ exemplars: bank })
      if (v === undefined) delete inp[flag]
      else inp[flag] = v
      t.is(judge(inp).code, code, flag + '=' + String(v))
    }
  }
})

test('unscoreable precedents never warm the bank or hide the other side', (t) => {
  // 20 descartar rows with broken vectors: they must not count toward the
  // cold-start minimum (otherwise the opposing side would be "warm" but
  // invisible to the margin check).
  const broken = filler('descartar', MIN_PER_LABEL).map(r => ({ ...r, embedding: [1, 2, 3] }))
  const bank = filler('bloquear', MIN_PER_LABEL).concat(broken, nearRows('bloquear', K, 0.99))
  t.is(judge(input({ exemplars: bank })).code, 'frio')

  // Typed arrays (the stores accept Int8Array) are scored, not dropped.
  const typed = warm().concat(nearRows('bloquear', K, 0.99).map(r => ({ ...r, embedding: Float32Array.from(r.embedding) })))
  t.is(judge(input({ exemplars: typed })).action, 'bloquear')
})

test('dequantize validates length, integers and range', (t) => {
  const ok = new Array(DIM).fill(0)
  ok[0] = 127
  t.is(dequantize(ok)[0], 1)
  t.is(dequantize(Int8Array.from(ok))[0], 1)
  for (const bad of [ok.slice(1), ok.map((x, i) => (i === 3 ? null : x)), ok.map((x, i) => (i === 3 ? 0.5 : x)), ok.map((x, i) => (i === 3 ? 128 : x)), null]) {
    try {
      dequantize(bad)
      t.fail('should throw')
    } catch (err) {
      t.is(err.code, 'pedido-invalido')
    }
  }
})

test('exact match reports the similarity of the matching rows only', (t) => {
  // One far descartar row shares the query hash; a much nearer descartar row
  // from another post must not become the reported similarity.
  const match = { decision: 'descartar', reason: 'spam', target: 'match-diary', contentHash: 'query-hash', embedding: near(0.5, 50) }
  const other = { decision: 'descartar', reason: 'spam', target: 'other-diary', contentHash: 'other-hash', embedding: near(0.99, 51) }
  const r = judge(input({ exemplars: warm().concat([match, other]) }))
  t.is(r.code, 'exato')
  t.ok(Math.abs(r.nearest - 0.5) < 1e-9)
})

test('cosine is clamped to [-1, 1]', (t) => {
  // Identical non-axis vectors: float rounding can exceed 1 without the clamp.
  const v = Array.from({ length: DIM }, (_, i) => (i % 4) - 4)
  const rows = []
  for (let i = 0; i < K; i++) {
    rows.push({ decision: 'bloquear', reason: 'spam', target: 'same-' + i, contentHash: 'h-' + i, embedding: v })
  }
  const r = judge(input({ embedding: v, exemplars: warm().concat(rows) }))
  t.is(r.action, 'bloquear')
  t.ok(r.nearest <= 1 && r.nearest >= -1)
})

test('five near rows from ONE other diary do not fire', (t) => {
  const r = judge(input({ exemplars: warm().concat(nearRows('bloquear', 10, 0.99, { oneTarget: 'spammer' })) }))
  t.is(r.action, 'aberta')
  t.is(r.code, 'sem-exemplo')

  // The query's own diary never votes.
  const own = judge(input({ exemplars: warm().concat(nearRows('bloquear', 10, 0.99, { oneTarget: SELF })) }))
  t.is(own.code, 'sem-exemplo')
})

test('descartar via neighbours', (t) => {
  const r = judge(input({ exemplars: warm().concat(nearRows('descartar', K, 0.91)) }))
  t.is(r.action, 'descartar')
  t.is(r.code, 'vizinhos')
  t.is(r.note, NOTE_DISCARD)
  t.ok(Math.abs(r.nearest - 0.91) < 1e-9)

  const outro = warm('outro').concat(nearRows('descartar', K, 0.95, { reason: 'outro' }))
  t.is(judge(input({ reason: 'outro', exemplars: outro })).action, 'descartar')
})

test('margin and unanimity', (t) => {
  // Opposing row inside the block threshold breaks unanimity.
  const inside = warm().concat(nearRows('bloquear', K, 0.99), nearRows('descartar', 1, 0.93, { axis: 50 }))
  t.is(judge(input({ exemplars: inside })).code, 'margem')

  // Opposing row below threshold but within MARGIN of the best supporter.
  const close = warm().concat(nearRows('bloquear', K, 0.95), nearRows('descartar', 1, 0.85, { axis: 50 }))
  t.is(judge(input({ exemplars: close })).code, 'margem')

  // Far enough away: blocks.
  const far = warm().concat(nearRows('bloquear', K, 0.95), nearRows('descartar', 1, 0.80, { axis: 50 }))
  t.is(judge(input({ exemplars: far })).action, 'bloquear')

  // K on both sides: divergente.
  const both = warm().concat(nearRows('bloquear', K, 0.97), nearRows('descartar', K, 0.97, { axis: 50 }))
  t.is(judge(input({ exemplars: both })).code, 'divergente')
})

test('outro cannot block', (t) => {
  const bank = warm('outro').concat(nearRows('bloquear', K, 0.99, { reason: 'outro' }))
  const r = judge(input({ reason: 'outro', exemplars: bank }))
  t.is(r.action, 'aberta')
  t.is(r.code, 'motivo')
  t.is(r.note, '')
  t.ok(r.nearest > 0.98)
})

test('embedding problems: sem-vetor; zero vector never acts', (t) => {
  const bank = warm().concat(nearRows('bloquear', K, 0.99))
  t.is(judge(input({ exemplars: bank, embedding: null })).code, 'sem-vetor')
  t.is(judge(input({ exemplars: bank, embedding: [1, 0, 0] })).code, 'sem-vetor')
  const nan = e(0)
  nan[5] = NaN
  t.is(judge(input({ exemplars: bank, embedding: nan })).code, 'sem-vetor')
  const inf = e(0)
  inf[5] = Infinity
  t.is(judge(input({ exemplars: bank, embedding: inf })).code, 'sem-vetor')

  const zero = judge(input({ exemplars: bank, embedding: new Array(DIM).fill(0) }))
  t.is(zero.action, 'aberta')
  t.is(zero.code, 'sem-exemplo')

  // Unnormalised query vectors are normalised first.
  const scaled = e(0).map(x => x * 7)
  t.is(judge(input({ exemplars: bank, embedding: scaled })).action, 'bloquear')
})

test('exact hash: agree, disagree, same target excluded', (t) => {
  // Descartar from one other diary is enough (identical text, identical
  // vector), as long as the opposing side stays clear.
  const d1 = warm().concat([{ decision: 'descartar', reason: 'spam', target: 'other', contentHash: 'query-hash', embedding: e(0) }])
  const r = judge(input({ exemplars: d1 }))
  t.is(r.action, 'descartar')
  t.is(r.code, 'exato')
  t.is(r.note, NOTE_DISCARD)
  t.ok(Math.abs(r.nearest - 1) < 1e-9)
  // Without a vector the exact path does not act either (fail closed).
  t.is(judge(input({ exemplars: d1, embedding: null })).code, 'sem-vetor')
  // Near-copies that humans blocked veto an exact dismissal.
  const vetoD = d1.concat(nearRows('bloquear', 1, 0.95, { axis: 70 }))
  t.is(judge(input({ exemplars: vetoD })).code, 'divergente', 'a blocked near-copy inside the threshold')
  const marginD = d1.concat(nearRows('bloquear', 1, 0.89, { axis: 71 }))
  t.is(judge(input({ exemplars: marginD })).code, 'margem', 'a blocked near-copy inside the margin')

  // Disagreeing hash rows: divergente.
  const dis = d1.concat([{ decision: 'bloquear', reason: 'spam', target: 'other2', contentHash: 'query-hash', embedding: e(151) }])
  t.is(judge(input({ exemplars: dis })).code, 'divergente')

  // The query's own diary is excluded from the hash match.
  const own = warm().concat([{ decision: 'descartar', reason: 'spam', target: SELF, contentHash: 'query-hash', embedding: e(150) }])
  t.is(judge(input({ exemplars: own })).code, 'sem-exemplo')

  // Other reasons do not match either.
  const other = warm().concat([{ decision: 'descartar', reason: 'outro', target: 'x', contentHash: 'query-hash', embedding: e(150) }])
  t.is(judge(input({ exemplars: other })).code, 'sem-exemplo')
})

test('exact hash bloquear needs K distinct diaries', (t) => {
  // One other diary: falls through to k-NN and ends sem-exemplo.
  const one = warm().concat(nearRows('bloquear', K, 0.5, { oneTarget: 'spammer', hash: 'query-hash' }))
  const r1 = judge(input({ exemplars: one }))
  t.is(r1.action, 'aberta')
  t.is(r1.code, 'sem-exemplo')

  // K - 1 distinct diaries with the hash: still not exato.
  const few = warm().concat(nearRows('bloquear', K - 1, 0.5, { hash: 'query-hash' }))
  t.is(judge(input({ exemplars: few })).code, 'sem-exemplo')

  // Falling through, the k-NN can still end in margem.
  const fall = warm().concat(
    nearRows('bloquear', 1, 0.5, { hash: 'query-hash', tag: 'h' }),
    nearRows('bloquear', K, 0.95, { axis: 20 }),
    nearRows('descartar', 1, 0.9, { axis: 60 }))
  t.is(judge(input({ exemplars: fall })).code, 'margem')

  // K distinct diaries with the hash (identical text, identical vector):
  // exato, when the opposing side stays clear.
  const same = (n) => {
    const rows = []
    for (let i = 0; i < n; i++) rows.push({ decision: 'bloquear', reason: 'spam', target: 'copy-' + i, contentHash: 'query-hash', embedding: e(0) })
    return rows
  }
  const k = warm().concat(same(K))
  const rk = judge(input({ exemplars: k }))
  t.is(rk.action, 'bloquear')
  t.is(rk.code, 'exato')
  t.is(rk.note, NOTE_BLOCK)
  t.is(judge(input({ exemplars: k, embedding: null })).code, 'sem-vetor', 'no vector, no exact block')
  // A dismissed near-copy inside the block threshold vetoes the exact block.
  t.is(judge(input({ exemplars: k.concat(nearRows('descartar', 1, 0.93, { axis: 72 })) })).code, 'divergente')
  // A dismissed near-copy inside the margin (1 - 0.12) vetoes it too.
  t.is(judge(input({ exemplars: k.concat(nearRows('descartar', 1, 0.9, { axis: 73 })) })).code, 'margem')

  // Policy still applies to exato: outro cannot block.
  const ko = warm('outro').concat(same(K).map(r => ({ ...r, reason: 'outro' })))
  t.is(judge(input({ reason: 'outro', exemplars: ko })).code, 'motivo')
})

test('minPerLabel override (test-only)', (t) => {
  const small = filler('bloquear', 2).concat(filler('descartar', 2), nearRows('bloquear', K, 0.95))
  t.is(judge(input({ exemplars: small })).code, 'frio')
  t.is(judge(input({ exemplars: small }), { minPerLabel: 2 }).action, 'bloquear')
  t.is(judge(input({ exemplars: small }), { minPerLabel: 3 }).code, 'frio')

  for (const bad of [0, -1, 1.5, '2', NaN, null]) {
    try {
      judge(input(), { minPerLabel: bad })
      t.fail('should throw for ' + String(bad))
    } catch (err) {
      t.is(err.code, 'pedido-invalido')
    }
  }
})

test('invalid input throws pedido-invalido', (t) => {
  for (const bad of [null, undefined, 'x', 3]) {
    try {
      judge(bad)
      t.fail('should throw')
    } catch (err) {
      t.is(err.code, 'pedido-invalido')
    }
  }
})
