'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/replySend.js')
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const TO = B + ':4'
const T0 = 1700000000000
const media = { core: A, start: 1, blocks: 2, sha256: B }
const entry = (record = {}, seq = 8) => ({
  seq,
  record: { type: 'post', text: 'resposta', replyTo: { author: B, seq: 4 }, at: new Date(T0).toISOString(), ...record }
})

test('sentMatcher checks each field and includes the time boundary', async (t) => {
  const { sentMatcher } = await load()
  const match = sentMatcher({ text: 'resposta', replyTo: TO }, { startedAt: T0, slackMs: 2000, seqFloor: 7 })
  t.ok(match(entry()))
  t.ok(match(entry({ replyTo: { author: B.toUpperCase(), seq: 4 } })))
  t.ok(match(entry({ at: new Date(T0 - 2000).toISOString() })))
  t.ok(match(entry({ at: new Date(T0 + 2000).toISOString() })))
  t.ok(match(entry({ media: [] })))
  t.ok(match(entry({ quote: null })))
  for (const bad of [
    null, {}, { seq: 8 }, entry({ type: 'profile' }), entry({ text: 'outra' }),
    entry({ replyTo: null }), entry({ replyTo: { author: A, seq: 4 } }),
    entry({ replyTo: { author: B, seq: 5 } }), entry({ media: [media] }),
    entry({ quote: { author: B, seq: 4 } }), entry({ quote: {} }),
    entry({ at: new Date(T0 - 2001).toISOString() }), entry({ at: 'invalid' }),
    entry({}, 7), entry({}, 6), entry({}, '8'), entry({}, 8.5)
  ]) t.absent(match(bad), JSON.stringify(bad))
  const noFloor = sentMatcher({ text: 'resposta', replyTo: TO }, { startedAt: T0, seqFloor: null })
  t.ok(noFloor(entry({}, 1)))
  const noSlack = sentMatcher({ text: 'resposta', replyTo: TO }, { startedAt: T0, slackMs: 0 })
  t.absent(noSlack(entry({ at: new Date(T0 - 1).toISOString() })))
  t.ok(sentMatcher({ text: 'resposta' }, { startedAt: T0 })(entry({ replyTo: null })))
  t.absent(sentMatcher({ text: 'resposta' }, { startedAt: T0 })(entry()))
})

test('sentMatcher preserves quote and ordered media matching', async (t) => {
  const { sentMatcher } = await load()
  const match = sentMatcher({ text: 'resposta', quote: TO, media: [media] }, { startedAt: T0 })
  const quoted = { replyTo: null, quote: { author: B.toUpperCase(), seq: 4 }, media: [media] }
  t.ok(match(entry(quoted)))
  for (const patch of [
    { quote: null }, { quote: { author: A, seq: 4 } }, { quote: { author: B, seq: 5 } },
    { replyTo: { author: B, seq: 4 } }, { media: null }, { media: [] }, { media: [media, media] }
  ]) t.absent(match(entry({ ...quoted, ...patch })))
  for (const key of ['core', 'start', 'blocks', 'sha256']) {
    t.absent(match(entry({ ...quoted, media: [{ ...media, [key]: 'different' }] })), key)
  }
  t.ok(match(entry({ ...quoted, media: [{ ...media, width: 42 }] })), 'same descriptor identity as Publicar')
  const second = { ...media, start: 3 }
  const ordered = sentMatcher({ text: 'resposta', replyTo: TO, media: [media, second] }, { startedAt: T0 })
  t.ok(ordered(entry({ media: [media, second] })))
  t.absent(ordered(entry({ media: [second, media] })))
})

test('quickReplyPlan covers every branch and priority with code points', async (t) => {
  const { quickReplyPlan } = await load()
  const base = { text: 'oi', nodeReady: true, actingAsPage: false, hasLink: false, refusal: '' }
  const plan = (patch) => quickReplyPlan({ ...base, ...patch })
  for (const text of ['', ' \n ', null, undefined]) t.alike(plan({ text, refusal: 'recusa', actingAsPage: true }), { kind: 'empty' })
  t.alike(plan({ refusal: 'recusa', actingAsPage: true }), { kind: 'refuse' })
  t.alike(plan({ actingAsPage: true }), { kind: 'send-page' })
  t.alike(plan({ actingAsPage: true, nodeReady: false }), { kind: 'send-page' })
  t.alike(plan({ actingAsPage: true, hasLink: true }), { kind: 'expand' })
  t.alike(plan({ actingAsPage: true, hasLink: true, nodeReady: false }), { kind: 'expand' })
  t.alike(plan({ actingAsPage: true, text: 'x'.repeat(1001) }), { kind: 'expand' })
  t.alike(plan({ actingAsPage: true, text: '🌱'.repeat(1001) }), { kind: 'expand' })
  for (const patch of [{ nodeReady: false }, { hasLink: true }, { text: 'x'.repeat(1001) }, { text: '🌱'.repeat(1001) }]) {
    t.alike(plan(patch), { kind: 'expand' })
  }
  for (const text of ['oi', ' oi ', 'x'.repeat(1000), '🌱'.repeat(1000)]) t.alike(plan({ text }), { kind: 'send' })
  for (const text of ['oi', ' oi ', 'x'.repeat(1000), '🌱'.repeat(1000)]) {
    t.alike(plan({ text, actingAsPage: true, nodeReady: false }), { kind: 'send-page' })
  }
})

test('sendTextReply sends text verbatim once and returns the published reference', async (t) => {
  const { sendTextReply } = await load()
  const calls = []
  const result = await sendTextReply({
    text: ' resposta ',
    replyTo: TO,
    lastSeq: 7,
    request: async (...args) => { calls.push(args); return { seq: 8, ref: A + ':8' } }
  })
  t.alike(calls, [['post.reply', { to: TO, text: ' resposta ' }]])
  t.alike(result, { ok: true, ref: A + ':8', error: null })
})

test('uncertain reply reads the own diary exactly once and uses the matcher', async (t) => {
  const { sendTextReply } = await load()
  const error = Object.assign(new Error('incerto'), { uncertain: true })
  for (const matches of [true, false]) {
    const calls = []
    const result = await sendTextReply({
      text: 'resposta',
      replyTo: TO,
      lastSeq: 7,
      request: async (method, params) => {
        calls.push([method, params])
        if (method === 'post.reply') throw error
        const recent = { at: new Date().toISOString() }
        const entries = [entry(recent, 7), entry({ ...recent, text: 'outra' })]
        if (matches) entries.push(entry(recent))
        return { key: A, entries }
      }
    })
    t.alike(calls, [['post.reply', { to: TO, text: 'resposta' }], ['log.read', {}]])
    t.alike(result, matches ? { ok: true, ref: A + ':8', error: null } : { ok: false, ref: null, error })
  }
})

test('gate refusal is signalled only when definitely not written', async (t) => {
  const { sendTextReply } = await load()
  const { GATE_MESSAGE } = await import('../src/outbox.js')
  for (const uncertain of [false, true]) {
    const calls = []
    const error = Object.assign(new Error(GATE_MESSAGE), { uncertain })
    const result = await sendTextReply({
      text: 'resposta',
      replyTo: TO,
      lastSeq: 7,
      request: async (method) => {
        calls.push(method)
        if (method === 'post.reply') throw error
        return { key: A, entries: [] }
      }
    })
    t.is(result.ok, false)
    t.is(result.error, error)
    t.is(result.gated === true, !uncertain)
    t.alike(calls, uncertain ? ['post.reply', 'log.read'] : ['post.reply'])
  }
})

test('definite errors and failed or malformed reads keep the draft uncertain', async (t) => {
  const { sendTextReply } = await load()
  const definite = new Error('recusa')
  let calls = 0
  t.alike(await sendTextReply({ text: 'resposta', replyTo: TO, lastSeq: 7, request: async () => { calls++; throw definite } }), { ok: false, ref: null, error: definite })
  t.is(calls, 1)
  const uncertain = Object.assign(new Error('incerto'), { uncertain: true })
  for (const read of [null, {}, { entries: {} }, { entries: [entry({ at: new Date().toISOString() })] }, new Error('falha de leitura')]) {
    const calls = []
    const result = await sendTextReply({
      text: 'resposta',
      replyTo: TO,
      lastSeq: 7,
      request: async (method) => {
        calls.push(method)
        if (method === 'post.reply') throw uncertain
        if (read instanceof Error) throw read
        return read
      }
    })
    t.alike(result, { ok: false, ref: null, error: uncertain })
    t.alike(calls, ['post.reply', 'log.read'])
  }
  const malformed = await sendTextReply({ text: 'resposta', replyTo: TO, lastSeq: 7, request: async () => null })
  t.is(malformed.ok, false)
  t.is(malformed.error.uncertain, true)
})

test('Publicar shares the matcher and resolves both draft choices before the editor', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Publicar.js'), 'utf8')
  t.ok(src.includes("import { sentMatcher } from '../replySend'"))
  t.ok(src.includes('const matches = sentMatcher({'))
  t.ok(src.includes('(res.entries || []).find((entry) => matches(entry) &&'))
  t.ok(src.includes('seqFloor: lastSeqRef.current'))
  for (const label of ['Você tem um rascunho não publicado.', 'Usar a resposta', 'Manter o rascunho']) t.ok(src.includes(label))
  t.ok(src.includes("typeof reply.draft === 'string'"))
  t.ok(src.includes("text !== '' && text !== reply.draft"))
  t.ok(src.includes('settleReplyDraft(false)'))
  t.ok(src.includes('settleReplyDraft(true)'))
  t.ok(src.indexOf('if (replyDraftConflict) {') < src.indexOf('  if (momentMode) {\n    return ('))
})

test('bad success shapes remain uncertain and reconcile without repeating the mutation', async (t) => {
  const { sendTextReply } = await load()
  for (const value of [
    null, {}, { ref: 'anything', seq: 8 }, { ref: A.toUpperCase() + ':8', seq: 8 },
    { ref: A + ':8', seq: 9 }, { ref: A + ':0', seq: 0 }, { ref: A + ':-1', seq: -1 },
    { ref: A + ':08', seq: 8 }, { ref: A + ':8', seq: '8' },
    { ref: A + ':9007199254740992', seq: 9007199254740992 }
  ]) {
    const calls = []
    const result = await sendTextReply({
      text: 'resposta',
      replyTo: TO,
      lastSeq: 7,
      request: async (method) => {
        calls.push(method)
        return method === 'post.reply' ? value : { key: A, entries: [] }
      }
    })
    t.is(result.ok, false, JSON.stringify(value))
    t.is(result.ref, null)
    t.is(result.error && result.error.uncertain, true)
    t.alike(calls, ['post.reply', 'log.read'])
  }
  const calls = []
  const result = await sendTextReply({
    text: 'resposta',
    replyTo: TO,
    lastSeq: 7,
    request: async (method) => {
      calls.push(method)
      return method === 'post.reply' ? {} : { key: A, entries: [entry({ at: new Date().toISOString() })] }
    }
  })
  t.alike(result, { ok: true, ref: A + ':8', error: null })
  t.alike(calls, ['post.reply', 'log.read'])
})

test('missing floor is learned before sending and failed pre-reads never reconcile', async (t) => {
  const { sendTextReply } = await load()
  const error = Object.assign(new Error('incerto'), { uncertain: true })
  const recent = () => entry({ at: new Date().toISOString() })
  for (const [page, canReconcile, expected] of [
    [{ key: A, entries: [entry({}, 7)], entriesTruncated: 7 }, true, true],
    [{ key: A, entries: [], entriesTruncated: 0 }, true, true],
    [{ key: A, entries: [entry({}, 7)], invalid: [{ seq: 8 }], entriesTruncated: 7 }, true, false],
    [new Error('sem conexão'), false, false], [null, false, false], [{}, false, false],
    [{ key: A, entries: [], invalid: {}, entriesTruncated: 0 }, false, false],
    [{ key: A, entries: [entry({}, 7)] }, false, false]
  ]) {
    const calls = []
    const result = await sendTextReply({
      text: 'resposta',
      replyTo: TO,
      request: async (method) => {
        calls.push(method)
        if (method === 'post.reply') throw error
        if (calls.length > 1) return { key: A, entries: [recent()] }
        if (page instanceof Error) throw page
        return page
      }
    })
    t.alike(calls, canReconcile ? ['log.read', 'post.reply', 'log.read'] : ['log.read', 'post.reply'])
    t.alike(result, expected ? { ok: true, ref: A + ':8', error: null } : { ok: false, ref: null, error })
    t.is(calls.filter((method) => method === 'post.reply').length, 1)
  }
})

test('only one match inside both attempt bounds can reconcile', async (t) => {
  const { sendTextReply } = await load()
  const { MATCH_SLACK_MS, ATTEMPT_WINDOW_MS } = await import('../src/outbox.js')
  const now = Date.now
  Date.now = () => T0
  t.teardown(() => { Date.now = now })
  const error = Object.assign(new Error('incerto'), { uncertain: true })
  for (const [entries, expected] of [
    [[entry()], true], [[entry(), entry({}, 9)], false],
    [[entry({ at: new Date(T0 - MATCH_SLACK_MS).toISOString() })], true],
    [[entry({ at: new Date(T0 - MATCH_SLACK_MS - 1).toISOString() })], false],
    [[entry({ at: new Date(T0 + ATTEMPT_WINDOW_MS).toISOString() })], true],
    [[entry({ at: new Date(T0 + ATTEMPT_WINDOW_MS + 1).toISOString() })], false],
    [[entry({}, 7)], false]
  ]) {
    const calls = []
    const result = await sendTextReply({
      text: 'resposta',
      replyTo: TO,
      lastSeq: 7,
      request: async (method) => {
        calls.push(method)
        if (method === 'post.reply') throw error
        return { key: A, entries }
      }
    })
    t.alike(result, expected ? { ok: true, ref: A + ':8', error: null } : { ok: false, ref: null, error })
    t.alike(calls, ['post.reply', 'log.read'])
  }
})

test('public word refusal prevents every request including the floor read', async (t) => {
  const { sendTextReply } = await load()
  const { BLOCKED_TERMS } = require('@varanda/rpc')
  const { refusalOf } = await import('../src/wordCheck.js')
  const text = 'texto ' + BLOCKED_TERMS[0]
  const refused = refusalOf(text)
  t.ok(refused)
  for (const lastSeq of [undefined, 7]) {
    let calls = 0
    const result = await sendTextReply({ text, replyTo: TO, lastSeq, request: async () => { calls++; return { seq: 8, ref: A + ':8' } } })
    t.alike(result, { ok: false, ref: null, error: null, refused })
    t.is(calls, 0)
  }
})

test('sendPageTextReply returns page:seq and calls act once with the text', async (t) => {
  const { sendPageTextReply } = await load()
  const calls = []
  const result = await sendPageTextReply({
    page: A,
    text: ' resposta ',
    replyTo: TO,
    act: async (op) => { calls.push(op); return { seq: 8, pushed: true } }
  })
  t.alike(calls, [{ to: TO, text: ' resposta ' }])
  t.alike(result, { ok: true, ref: A + ':8', error: null })
  const zero = await sendPageTextReply({
    page: A.toUpperCase(),
    text: 'oi',
    replyTo: TO,
    act: async () => ({ seq: 0 })
  })
  t.alike(zero, { ok: true, ref: A.toUpperCase() + ':0', error: null })
})

test('sendPageTextReply calls act once on failure and keeps the uncertain flag', async (t) => {
  const { sendPageTextReply } = await load()
  let calls = 0
  let retried = 0
  const definite = Object.assign(new Error('recusa'), { retry: () => { retried++ } })
  const failed = await sendPageTextReply({
    page: A,
    text: 'resposta',
    replyTo: TO,
    act: async () => { calls++; throw definite }
  })
  t.is(calls, 1)
  t.is(retried, 0)
  t.alike(failed, { ok: false, ref: null, error: definite })
  const uncertain = Object.assign(new Error('sem resposta'), { uncertain: true, retry: () => { retried++ } })
  const lost = await sendPageTextReply({
    page: A,
    text: 'resposta',
    replyTo: TO,
    act: async () => { calls++; throw uncertain }
  })
  t.is(calls, 2)
  t.is(retried, 0)
  t.alike(lost, { ok: false, ref: null, error: uncertain, retry: uncertain.retry })
  t.is(lost.error.uncertain, true)
  const sure = Object.assign(new Error('nao'), { uncertain: false, retry: () => { retried++ } })
  const kept = await sendPageTextReply({
    page: A,
    text: 'resposta',
    replyTo: TO,
    act: async () => { calls++; throw sure }
  })
  t.is(calls, 3)
  t.is(retried, 0)
  t.is(kept.error, sure)
  t.is(kept.error.uncertain, false)
})

test('sendPageTextReply treats an answer without a seq as uncertain and does not retry', async (t) => {
  const { sendPageTextReply } = await load()
  for (const value of [
    null, undefined, 8, '8', {}, { seq: -1 }, { seq: 1.5 }, { seq: '8' },
    { seq: NaN }, { seq: Infinity }, { seq: 9007199254740992 }, []
  ]) {
    let calls = 0
    let retried = 0
    const result = await sendPageTextReply({
      page: A,
      text: 'resposta',
      replyTo: TO,
      act: async () => {
        calls++
        if (value !== null && typeof value === 'object') value.retry = () => { retried++ }
        return value
      }
    })
    t.is(calls, 1, JSON.stringify(value))
    t.is(retried, 0)
    t.is(result.ok, false)
    t.is(result.ref, null)
    t.is(result.error && result.error.message, 'resposta inesperada')
    t.is(result.error.uncertain, true)
  }
})

test('sendPageTextReply word refusal never calls act', async (t) => {
  const { sendPageTextReply } = await load()
  const { BLOCKED_TERMS } = require('@varanda/rpc')
  const { refusalOf } = await import('../src/wordCheck.js')
  const text = 'texto ' + BLOCKED_TERMS[0]
  const refused = refusalOf(text)
  t.ok(refused)
  let calls = 0
  const result = await sendPageTextReply({
    page: A,
    text,
    replyTo: TO,
    act: () => { calls++; return { seq: 8 } }
  })
  t.alike(result, { ok: false, ref: null, error: null, refused })
  t.is(calls, 0)
})

test('sendPageTextReply resends through retry: no act, no new signature', async (t) => {
  const { sendPageTextReply } = await load()
  let acts = 0
  let retries = 0
  const act = async () => { acts++; return { seq: 9 } }
  const ok = await sendPageTextReply({ act, retry: async () => { retries++; return { seq: 7 } }, page: A, text: 'resposta', replyTo: TO })
  t.is(acts, 0, 'the retry replaces act')
  t.is(retries, 1)
  t.alike(ok, { ok: true, ref: A + ':7', error: null }, 'settles from the seq like a first answer')

  const next = async () => ({ seq: 3 })
  const again = Object.assign(new Error('sem resposta'), { uncertain: true, retry: next })
  const lost = await sendPageTextReply({ act, retry: async () => { retries++; throw again }, page: A, text: 'resposta', replyTo: TO })
  t.is(acts, 0)
  t.is(retries, 2)
  t.is(lost.retry, next, 'a retry lost again hands back the newer retry')

  const definite = new Error('recusa')
  const refused = await sendPageTextReply({ act, retry: async () => { retries++; throw definite }, page: A, text: 'resposta', replyTo: TO })
  t.alike(refused, { ok: false, ref: null, error: definite }, 'a definite refusal leaves nothing to resend')

  const odd = async () => { retries++; return {} }
  const unexpected = await sendPageTextReply({ act, retry: odd, page: A, text: 'resposta', replyTo: TO })
  t.is(unexpected.error.uncertain, true)
  t.is(unexpected.retry, odd, 'an answer without a seq keeps the same bytes to resend')
  t.is(acts, 0)
})

test('replyFloor uses the highest valid diary sequence', async (t) => {
  const { replyFloor } = await load()
  t.is(replyFloor(9, null), 8)
  t.is(replyFloor(1, null), 0)
  for (const length of [0, null, '9', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    t.is(replyFloor(length, null), null)
  }
  t.is(replyFloor(null, 12), 12)
  t.is(replyFloor(null, 0), 0)
  t.is(replyFloor(9, 12), 12)
  t.is(replyFloor(20, 12), 19)
  for (const confirmed of ['12', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    t.is(replyFloor(9, confirmed), 8)
  }
})

test('sendTextReply skips the pre-read with a diary floor and reconciles only above it', async (t) => {
  const { replyFloor, sendTextReply } = await load()
  const lastSeq = replyFloor(9, null)
  const error = Object.assign(new Error('incerto'), { uncertain: true })
  const success = { ok: true, ref: A + ':9', error: null }
  const calls = []
  const sent = await sendTextReply({
    text: 'resposta',
    replyTo: TO,
    lastSeq,
    request: async (method) => {
      calls.push(method)
      return { seq: 9, ref: A + ':9' }
    }
  })
  t.alike(sent, success)
  t.alike(calls, ['post.reply'])

  for (const appended of [true, false]) {
    const calls = []
    const result = await sendTextReply({
      text: 'resposta',
      replyTo: TO,
      lastSeq,
      request: async (method) => {
        calls.push(method)
        if (method === 'post.reply') throw error
        const recent = { at: new Date().toISOString() }
        const entries = [entry(recent, 8)]
        if (appended) entries.push(entry(recent, 9))
        return { key: A, entries }
      }
    })
    t.alike(result, appended ? success : { ok: false, ref: null, error })
    t.alike(calls, ['post.reply', 'log.read'])
  }
})

test('sendTextReply requires a record from the attempt when the floor may be stale', async (t) => {
  const { sendTextReply } = await load()
  const now = Date.now
  Date.now = () => T0
  t.teardown(() => { Date.now = now })
  const error = Object.assign(new Error('incerto'), { uncertain: true })
  for (const [lastSeqStale, offset, expected] of [
    [true, -1000, false], [true, 1000, true], [false, -1000, true]
  ]) {
    const calls = []
    const result = await sendTextReply({
      text: 'resposta',
      replyTo: TO,
      lastSeq: 8,
      lastSeqStale,
      request: async (method) => {
        calls.push(method)
        if (method === 'post.reply') throw error
        return { key: A, entries: [entry({ at: new Date(T0 + offset).toISOString() }, 9)] }
      }
    })
    t.alike(result, expected ? { ok: true, ref: A + ':9', error: null } : { ok: false, ref: null, error })
    t.alike(calls, ['post.reply', 'log.read'])
  }
})

test('sendTextReply keeps the usual slack when it read the floor itself', async (t) => {
  const { sendTextReply } = await load()
  const now = Date.now
  Date.now = () => T0
  t.teardown(() => { Date.now = now })
  const error = Object.assign(new Error('incerto'), { uncertain: true })
  const calls = []
  const result = await sendTextReply({
    text: 'resposta',
    replyTo: TO,
    lastSeq: null,
    lastSeqStale: true,
    request: async (method) => {
      calls.push(method)
      if (method === 'post.reply') throw error
      return calls.length === 1
        ? { key: A, entries: [entry({ text: 'antes' }, 8)], entriesTruncated: 0 }
        : { key: A, entries: [entry({ text: 'antes' }, 8), entry({ at: new Date(T0 - 1000).toISOString() }, 9)] }
    }
  })
  t.alike(result, { ok: true, ref: A + ':9', error: null })
  t.alike(calls, ['log.read', 'post.reply', 'log.read'])
})
