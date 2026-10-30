'use strict'

// apps/cli/lib/account/ai/worker.js with fakes: a fake moderation store, the
// real exemplar store and ledger on a temp dir, a fake reader and the hashed
// bag-of-words embedder (helpers/fake-embed.js). No network, no model,
// injected clock, no gap between jobs.

const path = require('node:path')
const crypto = require('node:crypto')
const test = require('brittle')
const { createWorker, BACKOFF_MS, RETRY_ABSTAIN_MS } = require('../lib/account/ai/worker')
const { openExemplarStore } = require('../lib/account/ai/exemplar-store')
const { openLedger } = require('../lib/account/ai/ledger')
const { AI_ACTOR, NOTE_BLOCK, NOTE_DISCARD, MAX_AI_BLOCKS_PER_DAY, quantize } = require('../lib/account/ai/triage')
const { fakeEmbed, makeEmbed } = require('./helpers/fake-embed')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-24T12:00:00.000Z')
const MODEL = 'fake-bow-1'
const HUMAN = 'mod@example.org'
const QUOTE = 'trecho citado pelo denunciante'
const SPAM = 'compre agora bitcoin gratis clique aqui no link promocao imperdivel ganhe dinheiro rapido sem sair de casa hoje mesmo oferta'
const HAM = 'bom dia amigos hoje o cafe da manha estava otimo e o sol apareceu cedo na varanda com passarinhos cantando bem alto'

function hex () {
  return crypto.randomBytes(32).toString('hex')
}

function rid () {
  return crypto.randomBytes(16).toString('base64url')
}

function iso (ms) {
  return new Date(ms).toISOString()
}

function clock (start = T0) {
  const c = { t: start, now: () => c.t }
  return c
}

function hashOf (text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 64)
}

// A fake moderation store with the surface the worker uses. Rows are kept
// in insertion order; `at` ticks with the clock. decide() is async like the
// real one (it enqueues) and pushes a pending block for 'bloquear'.
function fakeModeration (c) {
  const rows = new Map()
  const changes = []
  const decideCalls = []
  const reversed = new Set()
  let snapshot = null
  let decideHook = null
  const api = {
    rows,
    changes,
    decideCalls,
    reversed,
    // Adds members to the published list (accumulates).
    setBlocked (members) {
      const before = snapshot === null ? [] : snapshot.blocked
      snapshot = { seq: 1, blocked: [...before, ...members], revokedIssuers: [] }
    },
    // Removes members from the published list (an applied unblock).
    unsetBlocked (members) {
      const before = snapshot === null ? [] : snapshot.blocked
      snapshot = { seq: 1, blocked: before.filter((m) => !members.includes(m)), revokedIssuers: [] }
    },
    setDecideHook (fn) {
      decideHook = fn
    },
    addReport (fields = {}) {
      c.t += 1
      const row = {
        id: rid(),
        at: iso(c.t),
        kind: 'post',
        target: hex(),
        seq: 1,
        quote: QUOTE,
        reporter: hex(),
        reason: 'spam',
        text: '',
        nonce: hex(),
        signature: hex(),
        status: 'aberta',
        decidedBy: null,
        decidedAt: null,
        note: '',
        ...fields
      }
      if (row.kind !== 'post') row.seq = null
      rows.set(row.id, row)
      return row
    },
    human (id, decision) {
      c.t += 1
      const row = rows.get(id)
      Object.assign(row, { status: decision, decidedBy: HUMAN, decidedAt: iso(c.t), note: '' })
      if (decision === 'bloquear') changes.push({ id: rid(), op: 'block', member: row.target, by: HUMAN, at: row.decidedAt, reportIds: [id], claimedAt: null })
      return { ...row }
    },
    list ({ status = 'aberta', limit } = {}) {
      const out = [...rows.values()].filter((r) => (status === 'aberta') === (r.status === 'aberta'))
      out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      return { reports: out.slice(0, limit).map((r) => ({ ...r })), truncated: out.length > limit }
    },
    get (id) {
      return rows.has(id) ? { ...rows.get(id) } : null
    },
    async decide (id, { decision, by, note = '' } = {}) {
      decideCalls.push({ id, decision, by, note })
      const row = rows.get(id)
      if (!row || row.status !== 'aberta') {
        const err = new Error('nao-encontrado')
        err.code = 'nao-encontrado'
        throw err
      }
      c.t += 1
      Object.assign(row, { status: decision, decidedBy: by, decidedAt: iso(c.t), note })
      if (decision === 'bloquear') changes.push({ id: rid(), op: 'block', member: row.target, by, at: row.decidedAt, reportIds: [id], claimedAt: null })
      if (decideHook) await decideHook(row)
      return { report: { ...row }, change: null }
    },
    pending () {
      return { changes: changes.map((ch) => ({ ...ch, reportIds: [...ch.reportIds] })), published: { snapshot, at: null } }
    },
    exportRows () {
      return [...rows.values()].map((r) => ({ ...r }))
    },
    humanReversed (member) {
      return reversed.has(member) || changes.some((ch) => ch.member === member && ch.op === 'unblock')
    }
  }
  return api
}

// A fake reader over a map 'target:seq' -> post. A post may be a failure
// { fail: code }; a missing key is 'ausente'. Calls are recorded.
function fakeReader (posts) {
  const calls = []
  const readPost = async ({ diaryKey, seq }) => {
    calls.push({ diaryKey, seq })
    const p = posts.get(diaryKey + ':' + seq)
    if (!p) return { ok: false, code: 'ausente' }
    if (p.fail) return { ok: false, code: p.fail }
    if (p.hang) return p.hang
    return {
      ok: true,
      text: p.text,
      hasMedia: p.hasMedia === true,
      hasQuote: p.hasQuote === true,
      textCp: Array.from(p.text).length,
      contentHash: p.contentHash || hashOf(p.text)
    }
  }
  readPost.calls = calls
  return readPost
}

function setup (t, { mode = 'sombra', exemplarModel = MODEL, ledger, minPerLabel } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const c = clock()
  const moderation = fakeModeration(c)
  const exemplars = openExemplarStore(dir, { now: c.now, model: exemplarModel })
  const led = ledger || openLedger(dir, { now: c.now })
  const posts = new Map()
  const readPost = fakeReader(posts)
  const embed = makeEmbed()
  const logs = []
  const worker = createWorker({
    mode,
    moderation,
    exemplars,
    ledger: led,
    readPost,
    embed,
    log: (line) => logs.push(line),
    now: c.now,
    modelId: MODEL,
    judgeOpts: minPerLabel ? { minPerLabel } : {},
    gapMs: 0,
    stopWaitMs: 200
  })
  t.teardown(() => worker.stop(), { force: true })
  const env = { dir, c, moderation, exemplars, ledger: led, posts, readPost, embed, logs, worker }
  // Files a report about a post, with the post visible to the reader.
  env.report = (fields = {}, post = {}) => {
    const row = moderation.addReport(fields)
    if (row.kind === 'post') posts.set(row.target + ':' + row.seq, { text: SPAM + ' extra', ...post })
    return row
  }
  // Seeds a warm bank: `n` block and `n` discard spam precedents, each from
  // a distinct diary, written straight into the exemplar store.
  // Every block precedent's target is published as blocked, as in
  // production (a human block stands), or the worker prunes it.
  env.warm = (n = 20, reason = 'spam') => {
    const blocked = []
    for (let i = 0; i < n; i++) {
      for (const [decision, base] of [['bloquear', SPAM], ['descartar', HAM]]) {
        const text = base + ' v' + i
        const target = hex()
        if (decision === 'bloquear') blocked.push(target)
        exemplars.add({
          reportId: rid(),
          target,
          seq: 1,
          reason,
          decision,
          contentHash: hashOf(text),
          text,
          hasMedia: false,
          embedding: quantize(fakeEmbed(text))
        })
      }
    }
    moderation.setBlocked(blocked)
  }
  return env
}

// Every log line is { event: 'triage', reason: token } and carries no post
// text, quote or 16+ hex run.
function cleanLogs (t, logs) {
  for (const line of logs) {
    t.alike(Object.keys(line), ['event', 'reason'], 'log keys')
    t.is(line.event, 'triage')
    t.ok(/^[a-z0-9-]{1,32}$/.test(line.reason), 'reason is a token: ' + line.reason)
    const s = JSON.stringify(line)
    t.absent(/[0-9a-f]{16,}/i.test(s), 'no hex run in log')
    t.absent(s.includes(QUOTE) || s.includes('bitcoin') || s.includes('cafe'), 'no text in log')
  }
}

test('cold bank keeps a spam report open with frio; the panel projection has the spec shape', async (t) => {
  const env = setup(t, { mode: 'auto' })
  const r = env.report()
  env.worker.onReport(r)
  await env.worker.idle()
  t.is(env.moderation.decideCalls.length, 0, 'no decision')
  t.is(env.moderation.get(r.id).status, 'aberta')
  const m = env.ledger.get(r.id)
  t.is(m.code, 'frio')
  t.is(m.retryAt, iso(env.c.t + RETRY_ABSTAIN_MS), 'retried after an hour')
  t.alike(env.worker.suggestionOf(r.id), { sugestao: null, semelhanca: null, vizinhos: 0, motivo: 'frio', modo: 'auto' })
  t.is(env.worker.suggestionOf(rid()), null)
  t.alike(env.embed.calls, [SPAM + ' extra'], 'embed received the reader text, never the quote')
  t.alike(env.worker.verifiedOf(r.id), { texto: SPAM + ' extra', midia: false, citacao: false })
  cleanLogs(t, env.logs)
})

test('auto mode: a near-duplicate of 20+20 human precedents is blocked by ia; a re-report is an appeal; AI decisions teach nothing', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm()
  const r = env.report({}, { text: SPAM + ' novo' })
  env.worker.start()
  env.worker.onReport(r)
  await env.worker.idle()
  t.is(env.moderation.decideCalls.length, 1)
  const call = env.moderation.decideCalls[0]
  t.is(call.by, AI_ACTOR)
  t.is(call.decision, 'bloquear')
  t.is(call.note, NOTE_BLOCK)
  t.absent(call.note.includes(QUOTE))
  t.is(env.moderation.get(r.id).decidedBy, AI_ACTOR)
  const m = env.ledger.get(r.id)
  t.is(m.code, 'bloquear')
  t.is(m.suggestion, 'bloquear')
  t.ok(m.nearest > 0.92 && m.nearest <= 1)
  t.is(env.worker.suggestionOf(r.id).semelhanca, Math.round(m.nearest * 100) / 100)
  t.ok(env.ledger.read(r.id) !== null, 'the read survives the decision')
  // An appeal: a second report about the same post goes to humans.
  const again = env.moderation.addReport({ target: r.target, seq: r.seq })
  env.worker.onReport(again)
  await env.worker.idle()
  t.is(env.ledger.get(again.id).code, 'recurso')
  t.is(env.moderation.decideCalls.length, 1, 'no second decision')
  // The AI's own decision never becomes an exemplar (hook or reconcile).
  const before = env.exemplars.size()
  env.worker.onHumanDecision(env.moderation.get(r.id))
  await env.worker.runOnce()
  t.is(env.exemplars.size(), before)
  t.is(env.ledger.read(r.id), null, 'the reconcile drops the read of an AI decision')
  cleanLogs(t, env.logs)
  t.ok(env.logs.some((l) => l.reason === 'bloquear'), 'decision logged as a token')
})

test('sombra mode only records the suggestion; a discard-alike is suggested descartar', async (t) => {
  const env = setup(t, { mode: 'sombra' })
  env.warm()
  const spam = env.report({}, { text: SPAM + ' novo' })
  const ham = env.report({}, { text: HAM + ' novo' })
  env.worker.onReport(spam)
  env.worker.onReport(ham)
  await env.worker.idle()
  t.is(env.moderation.decideCalls.length, 0)
  t.is(env.ledger.get(spam.id).code, 'sombra')
  t.is(env.ledger.get(spam.id).suggestion, 'bloquear')
  t.is(env.ledger.get(ham.id).suggestion, 'descartar')
  t.is(env.worker.suggestionOf(ham.id).modo, 'sombra')
  t.is(env.worker.suggestionOf(ham.id).vizinhos, 40)
  cleanLogs(t, env.logs)
})

test('auto mode dismisses a discard-alike with NOTE_DISCARD and counts it', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm()
  const ham = env.report({}, { text: HAM + ' novo' })
  env.worker.onReport(ham)
  await env.worker.idle()
  t.is(env.moderation.decideCalls.length, 1)
  t.is(env.moderation.decideCalls[0].decision, 'descartar')
  t.is(env.moderation.decideCalls[0].note, NOTE_DISCARD)
  t.is(env.ledger.get(ham.id).code, 'descartar')
  cleanLogs(t, env.logs)
})

test('assedio and ilegal posts are read and cached but never embedded nor learned; account reports are never read', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm()
  const il = env.report({ reason: 'ilegal' }, { text: SPAM + ' novo' })
  const as = env.report({ reason: 'assedio' }, { text: SPAM + ' novo' })
  const acct = env.report({ kind: 'conta' })
  for (const r of [il, as, acct]) env.worker.onReport(r)
  await env.worker.idle()
  t.is(env.embed.calls.length, 0, 'nothing embedded')
  t.is(env.readPost.calls.length, 2, 'two posts read')
  t.absent(env.readPost.calls.some((call) => call.diaryKey === acct.target), 'account never read')
  t.is(env.ledger.get(il.id).code, 'ilegal')
  t.is(env.ledger.get(as.id).code, 'contexto')
  t.is(env.ledger.get(acct.id).code, 'conta')
  t.alike(env.worker.verifiedOf(il.id), { texto: SPAM + ' novo', midia: false, citacao: false })
  t.is(env.ledger.read(il.id).embedding, null)
  t.is(env.worker.verifiedOf(acct.id), null)
  t.is(env.moderation.decideCalls.length, 0)
  // A human decision on the ilegal report writes no exemplar (reason) and
  // on the account report nothing either.
  const size = env.exemplars.size()
  env.worker.onHumanDecision(env.moderation.human(il.id, 'bloquear'))
  env.worker.onHumanDecision(env.moderation.human(acct.id, 'bloquear'))
  await env.worker.runOnce()
  t.is(env.exemplars.size(), size)
  t.is(env.ledger.read(il.id), null, 'the ilegal post text is not kept after the decision')
  cleanLogs(t, env.logs)
})

test('a quote-post and a post with media stay aberta, are not embedded and are not learned', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm()
  const q = env.report({}, { text: SPAM + ' novo', hasQuote: true })
  const m = env.report({}, { text: SPAM + ' novo', hasMedia: true })
  env.worker.onReport(q)
  env.worker.onReport(m)
  await env.worker.idle()
  t.is(env.embed.calls.length, 0)
  t.is(env.ledger.get(q.id).code, 'citacao')
  t.is(env.ledger.get(m.id).code, 'midia')
  t.alike(env.worker.verifiedOf(q.id), { texto: SPAM + ' novo', midia: false, citacao: true })
  t.is(env.moderation.decideCalls.length, 0)
  const size = env.exemplars.size()
  env.worker.onHumanDecision(env.moderation.human(q.id, 'bloquear'))
  env.worker.onHumanDecision(env.moderation.human(m.id, 'descartar'))
  await env.worker.runOnce()
  t.is(env.exemplars.size(), size, 'nothing learned')
  cleanLogs(t, env.logs)
})

test('outro can never block: a block-alike outro report stays open with motivo', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm(20, 'outro')
  const r = env.report({ reason: 'outro' }, { text: SPAM + ' novo' })
  env.worker.onReport(r)
  await env.worker.idle()
  t.is(env.moderation.decideCalls.length, 0)
  t.is(env.ledger.get(r.id).code, 'motivo')
  cleanLogs(t, env.logs)
})

test('a short, a truncated and a long-text post go to humans', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm()
  const short = env.report({}, { text: 'oi' })
  const long = env.report({}, { text: new Array(150).fill('p').map((w, i) => w + i).join(' ') })
  env.worker.onReport(short)
  env.worker.onReport(long)
  await env.worker.idle()
  t.is(env.ledger.get(short.id).code, 'curto')
  t.is(env.ledger.get(long.id).code, 'truncado')
  t.is(env.ledger.read(long.id).truncated, true)
  t.is(env.embed.calls.length, 1, 'the short post is not embedded')
  t.is(env.moderation.decideCalls.length, 0)
  cleanLogs(t, env.logs)
})

test('never override a human: published block, pending unblock, pending block and humanReversed abstain in both modes', async (t) => {
  for (const mode of ['auto', 'sombra']) {
    const env = setup(t, { mode })
    env.warm()
    const pub = env.report({}, { text: SPAM + ' novo' })
    env.moderation.setBlocked([pub.target])
    const unb = env.report({}, { text: SPAM + ' novo' })
    env.moderation.changes.push({ id: rid(), op: 'unblock', member: unb.target, by: HUMAN, at: iso(env.c.t), reportIds: [], claimedAt: null })
    const pend = env.report({}, { text: SPAM + ' novo' })
    env.moderation.changes.push({ id: rid(), op: 'block', member: pend.target, by: HUMAN, at: iso(env.c.t), reportIds: [], claimedAt: null })
    const rev = env.report({}, { text: SPAM + ' novo' })
    env.moderation.reversed.add(rev.target)
    for (const r of [pub, unb, pend, rev]) env.worker.onReport(r)
    await env.worker.idle()
    t.is(env.moderation.decideCalls.length, 0, mode + ': no decision')
    t.is(env.ledger.get(pub.id).code, 'ja-bloqueado', mode)
    t.is(env.ledger.get(unb.id).code, 'humano-revisou', mode + ': pending unblock')
    t.is(env.ledger.get(pend.id).code, 'humano-revisou', mode + ': pending block')
    t.is(env.ledger.get(rev.id).code, 'humano-revisou', mode + ': humanReversed')
    t.is(env.ledger.get(rev.id).suggestion, null, mode + ': suggestion cleared')
    // The vector is captured first (so the case can still teach once a human
    // decides it); the human checks then stop any suggestion or decision.
    t.is(env.embed.calls.length, 4, mode + ': embedded before the human checks')
    t.ok(env.ledger.read(rev.id).embedding !== null, mode + ': vector cached')
    cleanLogs(t, env.logs)
  }
})

test('daily cap: the 21st block of the UTC day is not decided; nao-encontrado does not count; a decide that throws after committing counts', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm()
  // 19 AI blocks earlier today and one yesterday, seen through exportRows.
  for (let i = 0; i < MAX_AI_BLOCKS_PER_DAY - 1; i++) {
    env.moderation.addReport({ status: 'bloquear', decidedBy: AI_ACTOR, decidedAt: iso(T0 - 3600 * 1000), note: NOTE_BLOCK })
  }
  env.moderation.addReport({ status: 'bloquear', decidedBy: AI_ACTOR, decidedAt: iso(T0 - 36 * 3600 * 1000), note: NOTE_BLOCK })
  env.worker.start()
  await env.worker.idle()
  // A human decides first: the AI's decide meets nao-encontrado.
  const raced = env.report({}, { text: SPAM + ' novo' })
  env.moderation.setDecideHook(null)
  const realDecide = env.moderation.decide
  env.moderation.decide = async (id, opts) => {
    env.moderation.human(id, 'descartar')
    return realDecide(id, opts)
  }
  env.worker.onReport(raced)
  await env.worker.idle()
  t.is(env.ledger.get(raced.id).code, 'ja-decidida')
  env.moderation.decide = realDecide
  // The 20th block commits, then the store throws: it still counts.
  const flaky = env.report({}, { text: SPAM + ' novo' })
  env.moderation.setDecideHook(async () => {
    const err = new Error('disco')
    err.code = 'disco'
    throw err
  })
  env.worker.onReport(flaky)
  await env.worker.idle()
  env.moderation.setDecideHook(null)
  t.is(env.moderation.get(flaky.id).decidedBy, AI_ACTOR)
  t.is(env.ledger.get(flaky.id).code, 'bloquear', 'counted as a block')
  // The 21st is capped.
  const capped = env.report({}, { text: SPAM + ' novo' })
  env.worker.onReport(capped)
  await env.worker.idle()
  t.is(env.ledger.get(capped.id).code, 'teto-bloquear')
  t.is(env.moderation.get(capped.id).status, 'aberta')
  t.is(env.ledger.get(capped.id).suggestion, null)
  // A second report on the flaky post is an appeal (the set was updated).
  const appeal = env.moderation.addReport({ target: flaky.target, seq: flaky.seq })
  env.worker.onReport(appeal)
  await env.worker.idle()
  t.is(env.ledger.get(appeal.id).code, 'recurso')
  // Next UTC day the counter resets.
  env.c.t = Date.parse('2026-10-25T00:00:01.000Z')
  const fresh = env.report({}, { text: SPAM + ' novo' })
  env.worker.onReport(fresh)
  await env.worker.idle()
  t.is(env.ledger.get(fresh.id).code, 'bloquear')
  cleanLogs(t, env.logs)
})

test('learning: a human decision writes one exemplar from the cached read even when the post is gone; AI rows and stale reads do not', async (t) => {
  const env = setup(t, { mode: 'sombra' })
  const r = env.report({}, { text: SPAM + ' aprendido' })
  env.worker.onReport(r)
  await env.worker.idle()
  t.is(env.ledger.get(r.id).code, 'frio')
  // The seeder purged the diary: the reader fails now.
  env.posts.set(r.target + ':' + r.seq, { fail: 'ausente' })
  const reads = env.readPost.calls.length
  const embeds = env.embed.calls.length
  env.worker.onHumanDecision(env.moderation.human(r.id, 'bloquear'))
  await env.worker.idle()
  t.is(env.exemplars.size(), 1)
  const ex = env.exemplars.list()[0]
  t.is(ex.reportId, r.id)
  t.is(ex.text, SPAM + ' aprendido')
  t.is(ex.decision, 'bloquear')
  t.is(ex.reason, 'spam')
  t.alike(ex.embedding, quantize(fakeEmbed(SPAM + ' aprendido')))
  t.is(env.ledger.read(r.id), null, 'read dropped after the add')
  t.is(env.readPost.calls.length, reads, 'readPost never called at decision time')
  t.is(env.embed.calls.length, embeds, 'embed never called at decision time')
  // Again (the hook may fire twice): no duplicate, no throw.
  env.worker.onHumanDecision(env.moderation.get(r.id))
  await env.worker.idle()
  t.is(env.exemplars.size(), 1)
  // A read captured at or after the decision is not what the human saw.
  const late = env.report({}, { text: SPAM + ' tarde' })
  const decided = env.moderation.human(late.id, 'descartar')
  env.c.t = Date.parse(decided.decidedAt)
  env.ledger.putRead(late.id, {
    target: late.target,
    seq: late.seq,
    contentHash: hashOf('x'),
    text: SPAM + ' tarde',
    hasMedia: false,
    hasQuote: false,
    textCp: 20,
    truncated: false,
    embedding: quantize(fakeEmbed(SPAM + ' tarde'))
  })
  env.worker.onHumanDecision(decided)
  await env.worker.idle()
  t.is(env.exemplars.size(), 1, 'read.at >= decidedAt is skipped')
  t.is(env.ledger.read(late.id), null, 'and a read that can never teach is dropped (no text outlives the decision)')
  cleanLogs(t, env.logs)
})

test('reconcile learns a human decision whose hook never ran and drops reads of vanished rows', async (t) => {
  const env = setup(t, { mode: 'sombra' })
  const r = env.report({}, { text: SPAM + ' sem gancho' })
  const gone = env.report({}, { text: SPAM + ' sumiu' })
  env.worker.onReport(r)
  env.worker.onReport(gone)
  await env.worker.idle()
  env.moderation.human(r.id, 'descartar')
  env.moderation.rows.delete(gone.id)
  await env.worker.runOnce()
  t.is(env.exemplars.size(), 1)
  t.is(env.exemplars.list()[0].reportId, r.id)
  t.is(env.exemplars.list()[0].decision, 'descartar')
  t.is(env.ledger.read(gone.id), null)
  // A restart runs the same reconcile from start().
  const r2 = env.report({}, { text: SPAM + ' reinicio' })
  env.worker.onReport(r2)
  await env.worker.idle()
  env.moderation.human(r2.id, 'bloquear')
  await env.worker.stop()
  const w2 = createWorker({
    mode: 'sombra',
    moderation: env.moderation,
    exemplars: env.exemplars,
    ledger: env.ledger,
    readPost: env.readPost,
    embed: env.embed,
    log: (l) => env.logs.push(l),
    now: env.c.now,
    gapMs: 0
  })
  t.teardown(() => w2.stop(), { force: true })
  w2.start()
  await w2.idle()
  t.is(env.exemplars.size(), 2)
  cleanLogs(t, env.logs)
})

test('a group message report is never read, triaged or learned while a diary report still is', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm()
  const diary = env.report({}, { text: SPAM + ' diario' })
  // Its diary holds a post at the same seq: reading it would triage the
  // wrong block.
  const group = env.report({ writer: hex(), group: hex() }, { text: SPAM + ' grupo' })
  env.worker.onReport(diary)
  env.worker.onReport(group)
  await env.worker.idle()
  await env.worker.runOnce()
  await env.worker.idle()
  const read = (row) => env.readPost.calls.some((c) => c.diaryKey === row.target)
  t.ok(read(diary), 'the diary report is read')
  t.absent(read(group), 'the group report is never read')
  t.is(env.ledger.get(group.id), null, 'nor marked')
  t.is(env.moderation.decideCalls.some((d) => d.id === group.id), false, 'nor decided')
  t.is(env.moderation.get(group.id).status, 'aberta')
  t.is(env.moderation.decideCalls.some((d) => d.id === diary.id), true, 'the diary report is triaged')

  // A human decides it. Even a cached read of the group row (planted
  // here) never becomes an exemplar, through the hook or the reconcile.
  env.ledger.putRead(group.id, {
    target: group.target,
    seq: group.seq,
    contentHash: hashOf(SPAM + ' grupo'),
    text: SPAM + ' grupo',
    hasMedia: false,
    hasQuote: false,
    textCp: Array.from(SPAM + ' grupo').length,
    truncated: false,
    embedding: quantize(fakeEmbed(SPAM + ' grupo'))
  })
  const before = env.exemplars.size()
  env.worker.onHumanDecision(env.moderation.human(group.id, 'bloquear'))
  await env.worker.idle()
  t.is(env.exemplars.size(), before, 'the hook learns nothing from a group row')
  await env.worker.runOnce()
  await env.worker.idle()
  t.absent(env.exemplars.list().some((e) => e.reportId === group.id), 'the reconcile learns nothing from it')
  t.is(env.ledger.read(group.id), null, 'and drops its read')
  t.absent(read(group), 'still never read')
  cleanLogs(t, env.logs)
})

test('the appeal set is rebuilt after a restart from exportRows, and ja-decidida stops a report decided meanwhile', async (t) => {
  const env = setup(t, { mode: 'auto' })
  const old = env.moderation.addReport({ status: 'bloquear', decidedBy: AI_ACTOR, decidedAt: iso(T0 - 48 * 3600 * 1000), note: NOTE_BLOCK })
  env.worker.start()
  await env.worker.idle()
  const appeal = env.report({ target: old.target, seq: old.seq })
  env.worker.onReport(appeal)
  const done = env.report()
  env.moderation.human(done.id, 'descartar')
  env.worker.onReport(done)
  await env.worker.idle()
  t.is(env.ledger.get(appeal.id).code, 'recurso')
  t.is(env.readPost.calls.length, 0, 'neither was read')
  t.is(env.ledger.get(done.id).code, 'ja-decidida')
  cleanLogs(t, env.logs)
})

test('fair scan: 250 always-failing reports do not starve report 251; backoff follows 5 min, 1 h, 6 h, 24 h', async (t) => {
  const env = setup(t, { mode: 'sombra' })
  const failing = []
  for (let i = 0; i < 250; i++) failing.push(env.report({}, { fail: 'timeout' }))
  const last = env.report({}, { text: SPAM + ' chegou' })
  await env.worker.runOnce()
  t.is(env.ledger.get(last.id), null, 'not reached in the first scan of 200')
  t.is(env.readPost.calls.length, 200)
  await env.worker.runOnce()
  t.is(env.ledger.get(last.id).code, 'frio', 'reached in the second scan')
  t.is(env.readPost.calls.length, 251)
  const first = env.ledger.get(failing[0].id)
  t.is(first.code, 'timeout')
  t.is(first.attempts, 1)
  t.is(first.retryAt, iso(T0 + 251 + BACKOFF_MS[0]))
  // The third scan finds nothing due.
  await env.worker.runOnce()
  t.is(env.readPost.calls.length, 251)
  // Backoff schedule of one report.
  const r = failing[0]
  const expect = [BACKOFF_MS[1], BACKOFF_MS[2], BACKOFF_MS[3], BACKOFF_MS[3]]
  for (let k = 0; k < expect.length; k++) {
    env.c.t = Date.parse(env.ledger.get(r.id).retryAt)
    env.worker.onReport(r)
    await env.worker.idle()
    const m = env.ledger.get(r.id)
    t.is(m.attempts, k + 2)
    t.is(m.retryAt, iso(env.c.t + expect[k]))
  }
  // A read that succeeds resets the streak.
  env.posts.set(r.target + ':' + r.seq, { text: SPAM + ' voltou' })
  env.c.t = Date.parse(env.ledger.get(r.id).retryAt)
  env.worker.onReport(r)
  await env.worker.idle()
  t.is(env.ledger.get(r.id).attempts, 0)
  t.is(env.ledger.get(r.id).code, 'frio')
  cleanLogs(t, env.logs)
})

test('a frio report is retried when the bank changes, not before the hour otherwise', async (t) => {
  const env = setup(t, { mode: 'sombra' })
  const r = env.report({}, { text: SPAM + ' novo' })
  await env.worker.runOnce()
  t.is(env.ledger.get(r.id).code, 'frio')
  const reads = env.readPost.calls.length
  const embeds = env.embed.calls.length
  await env.worker.runOnce()
  t.is(env.embed.calls.length, embeds, 'not rerun while the bank is unchanged')
  env.warm()
  await env.worker.runOnce()
  t.is(env.ledger.get(r.id).suggestion, 'bloquear', 'rerun after the bank changed')
  t.is(env.readPost.calls.length, reads, 'the cached read is reused: no second network read')
  t.is(env.embed.calls.length, embeds, 'and the cached vector too')
  cleanLogs(t, env.logs)
})

// A second worker over the same env with a custom embed function.
function workerWith (t, env, mode, embed) {
  const w = createWorker({
    mode,
    moderation: env.moderation,
    exemplars: env.exemplars,
    ledger: env.ledger,
    readPost: env.readPost,
    embed,
    log: (l) => env.logs.push(l),
    now: env.c.now,
    gapMs: 0,
    stopWaitMs: 200
  })
  t.teardown(() => w.stop(), { force: true })
  return w
}

test('a human change that lands during the embed stops the AI before it writes', async (t) => {
  const env = setup(t, { mode: 'auto' })
  await env.worker.stop()
  env.warm()
  const r = env.report({}, { text: SPAM + ' v3' })
  const w = workerWith(t, env, 'auto', async (text) => {
    env.moderation.reversed.add(r.target) // a moderator acts meanwhile
    return { embedding: fakeEmbed(text), truncated: false }
  })
  w.onReport(r)
  await w.idle()
  t.is(env.moderation.decideCalls.length, 0, 'no decision')
  t.is(env.ledger.get(r.id).code, 'humano-revisou')
  cleanLogs(t, env.logs)
})

test('a cancelled block whose hook never ran is never relearned by the reconcile', async (t) => {
  const env = setup(t, { mode: 'sombra' })
  const r = env.report({}, { text: SPAM + ' cancelado' })
  const kept = env.report({}, { text: SPAM + ' mantido' })
  env.worker.onReport(r)
  env.worker.onReport(kept)
  await env.worker.idle()
  env.moderation.human(r.id, 'bloquear') // the learning hook never runs
  env.moderation.human(kept.id, 'bloquear')
  // Then a human cancels it: the pending block is gone (an unclaimed cancel
  // deletes it), and the member is marked reversed.
  const i = env.moderation.changes.findIndex((ch) => ch.member === r.target)
  env.moderation.changes.splice(i, 1)
  env.moderation.reversed.add(r.target)
  env.worker.onCancel({ id: rid(), op: 'block', member: r.target, reportIds: [r.id] })
  await env.worker.runOnce()
  t.absent(env.exemplars.list().some((e) => e.reportId === r.id), 'the reversed block is not a precedent')
  t.is(env.ledger.read(r.id), null, 'its cached read is gone')
  t.ok(env.exemplars.list().some((e) => e.reportId === kept.id), 'an untouched block still teaches')
  cleanLogs(t, env.logs)
})

test('a later human block of a member a human once reversed still teaches', async (t) => {
  const env = setup(t, { mode: 'sombra' })
  const r = env.report({}, { text: SPAM + ' de novo' })
  env.moderation.reversed.add(r.target) // sticky: an old cancel or unblock
  env.worker.onReport(r)
  await env.worker.idle()
  env.worker.onHumanDecision(env.moderation.human(r.id, 'bloquear')) // stands: pending block
  await env.worker.idle()
  t.ok(env.exemplars.list().some((e) => e.reportId === r.id), 'learned')
})

test('sombra records no suggestion when a human acts during the embed', async (t) => {
  const env = setup(t, { mode: 'sombra' })
  await env.worker.stop()
  env.warm()
  const r = env.report({}, { text: SPAM + ' v4' })
  const w = workerWith(t, env, 'sombra', async (text) => {
    env.moderation.reversed.add(r.target)
    return { embedding: fakeEmbed(text), truncated: false }
  })
  w.onReport(r)
  await w.idle()
  const m = env.ledger.get(r.id)
  t.is(m.code, 'humano-revisou')
  t.is(m.suggestion, null)
})

test('an embedder failure follows its backoff even when the bank changes', async (t) => {
  const env = setup(t, { mode: 'auto' })
  await env.worker.stop()
  env.warm()
  let calls = 0
  const w = workerWith(t, env, 'auto', async () => {
    calls++
    const err = new Error('falha-ia')
    err.code = 'falha-ia'
    throw err
  })
  const r = env.report({}, { text: SPAM + ' falha' })
  w.onReport(r)
  await w.idle()
  t.is(env.ledger.get(r.id).code, 'falha-ia')
  t.is(env.ledger.get(r.id).retryAt, iso(env.c.t + BACKOFF_MS[0]))
  env.warm(1) // the bank changes
  await w.runOnce()
  t.is(calls, 1, 'not retried before its backoff')
})

test('a read the ledger refuses is marked erro instead of throwing out of the job', async (t) => {
  const env = setup(t, { mode: 'auto' })
  const r = env.report({}, { text: 'oi \uD800 texto mal formado' })
  env.worker.onReport(r)
  await env.worker.idle()
  t.is(env.ledger.get(r.id).code, 'erro')
  t.is(env.ledger.read(r.id), null)
  t.is(env.moderation.decideCalls.length, 0)
})

test('a post a moderator already dismissed is never auto-blocked by a later report', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm()
  const first = env.report({}, { text: SPAM + ' v6' })
  env.moderation.human(first.id, 'descartar') // a human dismissed it
  // A second reporter files on the same post (same target and seq).
  const again = env.moderation.addReport({ target: first.target, seq: first.seq })
  env.worker.onReport(again)
  await env.worker.idle()
  t.is(env.moderation.decideCalls.length, 0, 'no automatic decision')
  t.is(env.ledger.get(again.id).code, 'recurso', 'the new report is an appeal for a human')
})

test('a sibling report of the same post decided during the embed makes this one an appeal', async (t) => {
  const env = setup(t, { mode: 'auto' })
  await env.worker.stop()
  env.warm()
  const a = env.report({}, { text: SPAM + ' v7' })
  const b = env.moderation.addReport({ target: a.target, seq: a.seq })
  const w = workerWith(t, env, 'auto', async (text) => {
    env.moderation.human(b.id, 'descartar') // a moderator dismisses the sibling meanwhile
    return { embedding: fakeEmbed(text), truncated: false }
  })
  w.onReport(a)
  await w.idle()
  t.absent(env.moderation.decideCalls.some((c) => c.id === a.id), 'no automatic decision on the cleared post')
  t.is(env.ledger.get(a.id).code, 'recurso')
})

test('a block precedent whose block no longer stands is pruned on the next scan', async (t) => {
  // A cancel or unblock that happened while triage was off never reached
  // onCancel/onUnblock: the scan removes the precedent anyway.
  const env = setup(t, { mode: 'sombra' })
  const add = (decision, target) => env.exemplars.add({
    reportId: rid(), target, seq: 1, reason: 'spam', decision, contentHash: hashOf(decision + target), text: SPAM, hasMedia: false, embedding: quantize(fakeEmbed(SPAM))
  })
  const gone = hex()
  const kept = hex()
  const pend = hex()
  const unb = hex()
  add('bloquear', gone) // neither published nor pending: reversed
  add('bloquear', kept)
  env.moderation.setBlocked([kept]) // published
  add('bloquear', pend)
  env.moderation.changes.push({ id: rid(), op: 'block', member: pend, by: HUMAN, at: iso(env.c.t), reportIds: [], claimedAt: null })
  add('bloquear', unb)
  env.moderation.setBlocked([unb])
  env.moderation.changes.push({ id: rid(), op: 'unblock', member: unb, by: HUMAN, at: iso(env.c.t), reportIds: [], claimedAt: null })
  add('descartar', hex()) // dismissals are never pruned
  await env.worker.runOnce()
  const targets = env.exemplars.list().map((e) => e.target)
  t.absent(targets.includes(gone), 'reversed block pruned')
  t.ok(targets.includes(unb), 'a pending unblock is not final: kept (suspended from the bank)')
  t.ok(targets.includes(kept) && targets.includes(pend), 'standing blocks kept')
  // The unblock is applied: no pending change, not published -> pruned.
  env.moderation.changes.splice(env.moderation.changes.findIndex((ch) => ch.member === unb), 1)
  env.moderation.unsetBlocked([unb])
  await env.worker.runOnce()
  t.absent(env.exemplars.list().some((e) => e.target === unb), 'pruned once the unblock is applied')
  t.is(env.exemplars.list().filter((e) => e.decision === 'descartar').length, 1)
})

test('block precedents of members with a pending unblock are left out of the bank', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm()
  // Every block precedent's member now has a pending unblock.
  for (const e of env.exemplars.list({ reason: 'spam' })) {
    if (e.decision === 'bloquear') env.moderation.changes.push({ id: rid(), op: 'unblock', member: e.target, by: HUMAN, at: iso(env.c.t), reportIds: [], claimedAt: null })
  }
  const r = env.report({}, { text: SPAM + ' v5' })
  env.worker.onReport(r)
  await env.worker.idle()
  t.is(env.moderation.decideCalls.length, 0, 'no block from suspended precedents')
  t.is(env.ledger.get(r.id).code, 'frio', 'the block side is empty while suspended')
  t.is(env.exemplars.list().filter((e) => e.decision === 'bloquear').length, 20, 'kept, not deleted')
})

test('onCancel and onUnblock withdraw precedents', async (t) => {
  const env = setup(t, { mode: 'sombra' })
  const a = env.report({}, { text: SPAM + ' a' })
  const b = env.report({}, { text: SPAM + ' b' })
  const d = env.report({}, { text: HAM + ' d' })
  for (const r of [a, b, d]) env.worker.onReport(r)
  await env.worker.idle()
  env.worker.onHumanDecision(env.moderation.human(a.id, 'bloquear'))
  env.worker.onHumanDecision(env.moderation.human(b.id, 'bloquear'))
  env.worker.onHumanDecision(env.moderation.human(d.id, 'descartar'))
  await env.worker.idle()
  t.is(env.exemplars.size(), 3)
  env.worker.onCancel({ id: rid(), op: 'block', member: a.target, reportIds: [a.id, rid()] })
  await env.worker.idle()
  t.is(env.exemplars.size(), 2)
  t.absent(env.exemplars.list().some((e) => e.reportId === a.id))
  // A panel unblock of b only queues an unblock: b's precedent is kept
  // (suspended from the bank) in case a moderator cancels that unblock.
  env.moderation.changes.push({ id: rid(), op: 'unblock', member: b.target, by: HUMAN, at: iso(env.c.t), reportIds: [], claimedAt: null })
  env.worker.onUnblock(b.target)
  env.worker.onUnblock(d.target)
  await env.worker.idle()
  t.is(env.exemplars.size(), 2, 'a pending unblock withdraws nothing yet')
  // The unblock is cancelled: b's block stands again and its precedent stays.
  env.moderation.changes.pop()
  await env.worker.runOnce()
  t.ok(env.exemplars.list().some((e) => e.reportId === b.id), 'kept after the unblock is cancelled')
  // Now the block and an unblock are both applied: b is gone for good.
  env.moderation.changes.splice(0, env.moderation.changes.length, ...env.moderation.changes.filter((ch) => ch.member !== b.target))
  env.worker.onUnblock(b.target)
  await env.worker.idle()
  t.is(env.exemplars.size(), 1, 'only bloquear rows of the member are withdrawn')
  t.is(env.exemplars.list()[0].reportId, d.id)
  env.worker.onCancel(null)
  env.worker.onUnblock('not-a-key')
  await env.worker.idle()
  cleanLogs(t, env.logs)
})

test('a ledger that is indisponivel never throws out of onReport and never decides', async (t) => {
  const broken = {}
  for (const m of ['get', 'mark', 'read', 'putRead', 'dropRead', 'readIds', 'prune']) {
    broken[m] = () => {
      const err = new Error('indisponivel')
      err.code = 'indisponivel'
      throw err
    }
  }
  const env = setup(t, { mode: 'auto', ledger: broken })
  env.warm()
  const r = env.report({}, { text: SPAM + ' novo' })
  env.worker.onReport(r)
  env.worker.start()
  await env.worker.runOnce()
  t.is(env.moderation.decideCalls.length, 0)
  t.is(env.moderation.get(r.id).status, 'aberta')
  t.is(env.worker.suggestionOf(r.id), null)
  t.is(env.worker.verifiedOf(r.id), null)
  t.ok(env.logs.some((l) => l.reason === 'indisponivel'))
  cleanLogs(t, env.logs)
})

test('an exemplar file from another model disables scoring and learning for the process', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm()
  await env.worker.stop()
  const other = openExemplarStore(env.dir, { now: env.c.now, model: 'outro-modelo' })
  const w = createWorker({
    mode: 'auto',
    moderation: env.moderation,
    exemplars: other,
    ledger: env.ledger,
    readPost: env.readPost,
    embed: env.embed,
    log: (l) => env.logs.push(l),
    now: env.c.now,
    gapMs: 0
  })
  t.teardown(() => w.stop(), { force: true })
  const r = env.report({}, { text: SPAM + ' novo' })
  w.onReport(r)
  await w.idle()
  t.is(env.ledger.get(r.id).code, 'modelo')
  t.is(env.moderation.decideCalls.length, 0)
  t.ok(env.logs.some((l) => l.reason === 'modelo'))
  t.alike(w.verifiedOf(r.id), { texto: SPAM + ' novo', midia: false, citacao: false }, 'the text is still cached')
  const r2 = env.report({}, { text: SPAM + ' depois' })
  w.onReport(r2)
  await w.idle()
  t.is(env.embed.calls.length, 1, 'no further embedding once disabled')
  t.is(env.ledger.get(r2.id).code, 'modelo')
  w.onHumanDecision(env.moderation.human(r.id, 'bloquear'))
  await w.idle()
  cleanLogs(t, env.logs)
})

test('stop() during an in-flight read resolves, and nothing is marked or decided afterwards', async (t) => {
  const env = setup(t, { mode: 'auto' })
  env.warm()
  let release
  const hang = new Promise((resolve) => { release = resolve })
  const r = env.report({}, { hang })
  env.worker.onReport(r)
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.is(env.readPost.calls.length, 1, 'read in flight')
  const stopped = env.worker.stop()
  release({ ok: true, text: SPAM + ' novo', hasMedia: false, hasQuote: false, textCp: 30, contentHash: hashOf('h') })
  await stopped
  t.is(env.moderation.decideCalls.length, 0)
  t.is(env.ledger.get(r.id), null, 'no mark after stop')
  t.is(env.ledger.read(r.id), null, 'no cached read after stop')
  env.worker.onReport(env.report())
  env.worker.start()
  await env.worker.runOnce()
  t.is(env.readPost.calls.length, 1, 'nothing runs after stop')
  // A read that never returns: stop() is bounded.
  const env2 = setup(t, { mode: 'auto' })
  env2.worker.onReport(env2.report({}, { hang: new Promise(() => {}) }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const t0 = Date.now()
  await env2.worker.stop()
  t.ok(Date.now() - t0 < 2000, 'bounded wait')
  cleanLogs(t, env.logs)
  cleanLogs(t, env2.logs)
})

test('createWorker validates its options; start, onReport and onHumanDecision never throw on junk', async (t) => {
  const env = setup(t)
  const typeErr = (fn, re, msg) => {
    try {
      fn()
      t.fail(msg + ': returned')
    } catch (err) {
      t.ok(err instanceof TypeError && re.test(err.message), msg)
    }
  }
  typeErr(() => createWorker({ ...env, mode: 'livre' }), /mode/, 'bad mode')
  typeErr(() => createWorker({ mode: 'auto' }), /moderation/, 'missing store')
  env.worker.onReport(null)
  env.worker.onReport({ id: 42 })
  env.worker.onHumanDecision(undefined)
  env.worker.onHumanDecision({ id: rid() })
  env.worker.start()
  env.worker.start()
  await env.worker.idle()
  t.is(env.logs.length, 0)
})
