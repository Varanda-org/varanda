'use strict'

// Which records become Web Push notices, the actor name they carry and the
// event shape the seeder relays to the account service. No network.
const test = require('brittle')
const {
  PUSH_KINDS,
  PUSH_MAX_AGE_MS,
  pushCandidate,
  pushCandidates,
  pushName,
  validatePushEvent
} = require('../lib/push-events')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const AT = '2026-10-29T11:59:00.000Z'

const member = (key) => key === B
const notBlocked = () => false

function candidate (record, opts = {}) {
  return pushCandidate({ author: A, seq: 3, record, isMember: member, isBlocked: notBlocked, now: NOW, ...opts })
}

const follow = (on, key = B) => ({ type: 'follow', key, on, at: AT })
const engage = (type, on, author = B) => ({ type, to: { author, seq: 7 }, on, at: AT })
const post = (replyTo, quote) => {
  const r = { type: 'post', text: 'oi', at: AT, replyTo }
  if (quote !== undefined) r.quote = quote
  return r
}

function event (fields = {}) {
  return { v: 1, kind: 'like', actor: A, recipient: B, seq: 3, ref: B + ':7', name: 'Ana', ...fields }
}

test('push kinds', (t) => {
  t.alike(PUSH_KINDS, ['follow', 'reply', 'quote', 'mention', 'like', 'repost'])
  t.is(PUSH_MAX_AGE_MS, 24 * 3600 * 1000)
})

test('pushCandidate: follow, reply, like and repost reach the target', (t) => {
  t.alike(candidate(follow(true)), { kind: 'follow', actor: A, recipient: B, seq: 3, ref: null })
  t.alike(candidate(post({ author: B, seq: 7 })), { kind: 'reply', actor: A, recipient: B, seq: 3, ref: B + ':7' })
  t.alike(candidate(engage('like', true)), { kind: 'like', actor: A, recipient: B, seq: 3, ref: B + ':7' })
  t.alike(candidate(engage('repost', true)), { kind: 'repost', actor: A, recipient: B, seq: 3, ref: B + ':7' })
})

test('pushCandidate: retractions, quotes, self-targets and other types give null', (t) => {
  t.is(candidate(follow(false)), null, 'unfollow')
  t.is(candidate(engage('like', false)), null, 'like off')
  t.is(candidate(engage('repost', false)), null, 'repost off')
  t.is(candidate(post(null, { author: B, seq: 7 })), null, 'quote-only post')
  t.is(candidate(post(null)), null, 'plain post')
  t.is(candidate(follow(true, A), { isMember: () => true }), null, 'self-follow')
  t.is(candidate(post({ author: A, seq: 1 }), { isMember: () => true }), null, 'reply to self')
  t.is(candidate(engage('like', true, A), { isMember: () => true }), null, 'self-like')
  t.is(candidate({ type: 'profile', name: 'Ana', bio: '', at: AT }), null, 'profile')
  t.is(candidate({ type: 'media-core', key: B, at: AT }), null, 'media-core')
  t.is(candidate({ type: 'username', key: B }), null, 'username')
})

test('pushCandidate: membership and blocks', (t) => {
  t.is(candidate(follow(true, C)), null, 'non-member recipient')
  t.is(candidate(follow(true), { isBlocked: (k) => k === A }), null, 'blocked actor')
  t.is(candidate(follow(true), { isBlocked: (k) => k === B }), null, 'blocked recipient')
  t.is(candidate(follow(true), { isMember: () => { throw new Error('boom') } }), null, 'throwing isMember')
  t.is(candidate(follow(true), { isBlocked: () => { throw new Error('boom') } }), null, 'throwing isBlocked')
  t.is(candidate(follow(true), { isMember: undefined }), null, 'missing isMember')
  t.is(candidate(follow(true), { isMember: () => 1 }), null, 'truthy but not true')
})

test('pushCandidate: malformed arguments give null and never throw', (t) => {
  const throwing = new Proxy({}, { get () { throw new Error('boom') }, getPrototypeOf () { throw new Error('boom') } })
  const throwingFields = new Proxy(follow(true), { get () { throw new Error('boom') } })
  t.is(candidate(throwing), null, 'throwing proxy record')
  t.is(candidate(throwingFields), null, 'throwing getters')
  t.is(pushCandidate(throwing), null, 'throwing proxy argument')
  t.is(pushCandidate(), null, 'no argument')
  t.is(pushCandidate(null), null, 'null argument')
  t.is(candidate(follow(true), { author: 'A'.repeat(64) }), null, 'uppercase author')
  t.is(candidate(follow(true), { author: 'a'.repeat(63) }), null, 'short author')
  t.is(candidate(follow(true), { seq: 0 }), null, 'seq 0')
  t.is(candidate(follow(true), { seq: 1.5 }), null, 'fractional seq')
  t.is(candidate(follow(true), { seq: '3' }), null, 'string seq')
  t.is(candidate(follow(true), { now: undefined }), null, 'missing now')
  t.is(candidate(null), null, 'null record')
  t.is(candidate([]), null, 'array record')
  t.is(candidate(follow('yes')), null, 'non-boolean on')
  t.is(candidate(follow(true, 'x')), null, 'bad follow key')
  t.is(candidate({ type: 'like', to: { author: B, seq: 0 }, on: true, at: AT }), null, 'like seq 0')
  t.is(candidate({ type: 'like', to: B + ':7', on: true, at: AT }), null, 'like target as string')
  t.is(candidate(post({ author: B, seq: -1 })), null, 'bad replyTo')
})

test('pushCandidate: stale records give null', (t) => {
  const old = new Date(NOW - PUSH_MAX_AGE_MS - 1000).toISOString()
  const recent = new Date(NOW - PUSH_MAX_AGE_MS + 1000).toISOString()
  t.is(candidate({ ...follow(true), at: old }), null, 'older than the max age')
  t.is(candidate({ ...engage('like', true), at: old }), null, 'old like')
  t.ok(candidate({ ...follow(true), at: recent }), 'within the max age')
  t.ok(candidate({ ...follow(true), at: new Date(NOW - PUSH_MAX_AGE_MS).toISOString() }), 'exactly 24 h old still pushes')
  t.is(candidate({ ...follow(true), at: new Date(NOW - PUSH_MAX_AGE_MS - 1).toISOString() }), null, '24 h and 1 ms is stale')
  t.ok(candidate({ ...follow(true), at: new Date(NOW - 23 * 3600 * 1000 - 59 * 60 * 1000).toISOString() }), '23 h 59 min pushes')
  t.ok(candidate({ ...follow(true), at: new Date(NOW + 60000).toISOString() }), 'future-dated is not suppressed')
})

const D = 'd'.repeat(64)
const NAMES = { bia: [B], cris: [C], dani: [D], ana: [A], duo: [C, D] }
const holders = (token) => NAMES[token] || []
const everyone = () => true

function candidates (record, opts = {}) {
  return pushCandidates({ author: A, seq: 3, record, isMember: everyone, isBlocked: notBlocked, now: NOW, holders, ...opts })
}

const say = (text, fields = {}) => ({ type: 'post', text, at: AT, replyTo: null, ...fields })
const own = A + ':3'

test('pushCandidates: follow, like and repost', (t) => {
  t.alike(candidates(follow(true)), [{ kind: 'follow', actor: A, recipient: B, seq: 3, ref: null, targetSeq: null, alternates: [] }])
  t.alike(candidates(engage('like', true)), [{ kind: 'like', actor: A, recipient: B, seq: 3, ref: B + ':7', targetSeq: 7, alternates: [] }])
  t.alike(candidates(engage('repost', true)), [{ kind: 'repost', actor: A, recipient: B, seq: 3, ref: B + ':7', targetSeq: 7, alternates: [] }])
  t.alike(candidates(follow(false)), [], 'unfollow')
  t.alike(candidates(engage('like', false)), [], 'like off')
  t.alike(candidates(follow(true, A)), [], 'self-follow')
  t.alike(candidates(engage('repost', true, A)), [], 'self-repost')
  t.alike(candidates({ type: 'profile', name: 'Ana', bio: '', at: AT }), [], 'profile')
})

test('pushCandidates: reply, quote and mention', (t) => {
  t.alike(candidates(post({ author: B, seq: 7 })), [{ kind: 'reply', actor: A, recipient: B, seq: 3, ref: B + ':7', targetSeq: 7, alternates: [] }])
  t.alike(candidates(post(null, { author: B, seq: 7 })), [{ kind: 'quote', actor: A, recipient: B, seq: 3, ref: own, targetSeq: 7, alternates: [] }], 'quote ref is the actor post')
  t.alike(candidates(say('oi @bia')), [{ kind: 'mention', actor: A, recipient: B, seq: 3, ref: own, targetSeq: null, alternates: [] }])
  t.alike(candidates(say('@cris e @bia')), [
    { kind: 'mention', actor: A, recipient: B, seq: 3, ref: own, targetSeq: null, alternates: [] },
    { kind: 'mention', actor: A, recipient: C, seq: 3, ref: own, targetSeq: null, alternates: [] }
  ], 'sorted by recipient')
  t.alike(candidates(say('@duo')).map((c) => c.recipient), [C, D], 'every holder of a name')
  t.alike(candidates(say('@bia @bia @BIA')).length, 1, 'repeated name once')
  t.alike(candidates(say('@duo @cris')).map((c) => c.recipient), [C, D], 'one recipient behind two names')
  t.alike(candidates(say('@nobody')), [], 'unheld name')
  t.alike(candidates(say('sem nome')), [], 'plain post')
  t.alike(candidates(say(42)), [], 'non-string text')
})

test('pushCandidates: one notice per recipient, strongest kind', (t) => {
  t.alike(candidates(post({ author: B, seq: 7 }, undefined)).map((c) => c.kind), ['reply'])
  const replyMention = { ...post({ author: B, seq: 7 }), text: 'oi @bia' }
  t.alike(candidates(replyMention), [{ kind: 'reply', actor: A, recipient: B, seq: 3, ref: B + ':7', targetSeq: 7, alternates: [{ kind: 'mention', ref: own, targetSeq: null }] }], 'reply beats mention')
  t.alike(candidates(say('oi @bia', { quote: { author: B, seq: 7 } })), [{ kind: 'quote', actor: A, recipient: B, seq: 3, ref: own, targetSeq: 7, alternates: [{ kind: 'mention', ref: own, targetSeq: null }] }], 'quote beats mention')
  t.alike(candidates(say('oi @cris', { quote: { author: B, seq: 7 } })), [
    { kind: 'quote', actor: A, recipient: B, seq: 3, ref: own, targetSeq: 7, alternates: [] },
    { kind: 'mention', actor: A, recipient: C, seq: 3, ref: own, targetSeq: null, alternates: [] }
  ], 'quote and mention of different members')
  const both = { type: 'post', text: '@cris @bia', at: AT, replyTo: { author: B, seq: 7 }, quote: { author: C, seq: 9 } }
  t.alike(candidates(both), [
    { kind: 'reply', actor: A, recipient: B, seq: 3, ref: B + ':7', targetSeq: 7, alternates: [{ kind: 'mention', ref: own, targetSeq: null }] },
    { kind: 'quote', actor: A, recipient: C, seq: 3, ref: own, targetSeq: 9, alternates: [{ kind: 'mention', ref: own, targetSeq: null }] }
  ], 'reply and quote outrank their mentions, priority order')
  const order = { type: 'post', text: '@bia', at: AT, replyTo: { author: D, seq: 1 }, quote: { author: C, seq: 2 } }
  t.alike(candidates(order).map((c) => c.kind), ['reply', 'quote', 'mention'], 'priority first, then recipient')
})

test('pushCandidates: weaker hits on the same recipient travel as alternates, in priority order', (t) => {
  const replyMention = say('oi @bia', { replyTo: { author: B, seq: 7 } })
  const [only] = candidates(replyMention)
  t.is(only.kind, 'reply')
  t.alike(only.alternates, [{ kind: 'mention', ref: own, targetSeq: null }], 'reply and mention of B: mention is the alternate')
  const all = say('@bia', { replyTo: { author: B, seq: 7 }, quote: { author: B, seq: 5 } })
  t.alike(candidates(all), [{
    kind: 'reply',
    actor: A,
    recipient: B,
    seq: 3,
    ref: B + ':7',
    targetSeq: 7,
    alternates: [{ kind: 'quote', ref: own, targetSeq: 5 }, { kind: 'mention', ref: own, targetSeq: null }]
  }], 'reply to B, quote of another B post, mention of B: reply, then quote, then mention')
  const twice = say('@bia @bea', { replyTo: { author: B, seq: 7 } })
  t.alike(candidates(twice, { holders: () => [B] })[0].alternates, [{ kind: 'mention', ref: own, targetSeq: null }], 'two names held by B: one mention alternate')
  const quoteMention = say('@bia', { quote: { author: B, seq: 5 } })
  t.alike(candidates(quoteMention)[0].alternates, [{ kind: 'mention', ref: own, targetSeq: null }], 'quote and mention of B')
  t.alike(candidates(say('@bia @cris', { replyTo: { author: D, seq: 1 } })).map((c) => c.alternates), [[], [], []], 'distinct recipients: no alternates')
  t.alike(candidates(follow(true))[0].alternates, [], 'follow: no alternates')
  t.alike(candidates(all, { isMember: (k) => k !== B }), [], 'a non-member recipient drops every hit, alternates included')
  t.alike(candidates(all, { isBlocked: (k) => k === B }), [], 'a blocked recipient drops every hit, alternates included')
})

test('pushCandidates: the author is never a recipient', (t) => {
  t.alike(candidates(post({ author: A, seq: 1 })), [], 'reply to self')
  t.alike(candidates(post(null, { author: A, seq: 1 })), [], 'quote of self')
  t.alike(candidates(say('@ana')), [], 'self-mention')
  t.alike(candidates(say('@ana @bia')).map((c) => c.recipient), [B], 'self dropped, other kept')
  t.alike(candidates(say('@bia'), { holders: () => [A, B] }).map((c) => c.recipient), [B], 'author among holders')
})

test('pushCandidates: holders that throw or return garbage count as nobody', (t) => {
  t.alike(candidates(say('@bia'), { holders: () => { throw new Error('boom') } }), [], 'throwing holders')
  t.alike(candidates(say('@bia'), { holders: undefined }), [], 'missing holders')
  t.alike(candidates(say('@bia'), { holders: () => B }), [], 'string, not an array')
  t.alike(candidates(say('@bia'), { holders: () => null }), [], 'null')
  t.alike(candidates(say('@bia'), { holders: () => ({ 0: B, length: 1 }) }), [], 'array-like')
  t.alike(candidates(say('@bia'), { holders: () => ['B'.repeat(64), 'x', 7, null, { key: B }, B] }).map((c) => c.recipient), [B], 'bad entries skipped')
  t.alike(candidates(say('@bia @cris'), { holders: (tk) => { if (tk === 'bia') throw new Error('boom'); return [C] } }).map((c) => c.recipient), [C], 'one bad lookup does not stop the others')
  const throwingArray = new Proxy([B], { get (o, k) { if (k === Symbol.iterator) throw new Error('boom'); return o[k] } })
  t.alike(candidates(say('@bia'), { holders: () => throwingArray }), [], 'throwing iterator')
  t.alike(candidates(say('@bia', { quote: { author: C, seq: 2 } }), { holders: () => { throw new Error('boom') } }).map((c) => c.kind), ['quote'], 'quote survives a failed lookup')
  const seen = []
  candidates(say(Array.from({ length: 10 }, (_, i) => '@nome' + i).join(' ')), { holders: (tk) => { seen.push(tk); return [] } })
  t.is(seen.length, 8, 'at most MENTION_MAX lookups')
})

test('pushCandidates: membership and blocks per recipient', (t) => {
  const rec = say('@cris @dani', { quote: { author: B, seq: 7 } })
  t.alike(candidates(rec, { isMember: (k) => k !== C }).map((c) => c.recipient), [B, D], 'non-member dropped')
  t.alike(candidates(rec, { isMember: (k) => { if (k === D) throw new Error('boom'); return true } }).map((c) => c.recipient), [B, C], 'throwing isMember counts false')
  t.alike(candidates(rec, { isMember: (k) => k === B ? 1 : true }).map((c) => c.recipient), [C, D], 'truthy but not true')
  t.alike(candidates(rec, { isMember: undefined }), [], 'missing isMember')
  t.alike(candidates(rec, { isBlocked: (k) => k === C }).map((c) => c.recipient), [B, D], 'blocked recipient dropped')
  t.alike(candidates(rec, { isBlocked: (k) => { if (k === D) throw new Error('boom'); return false } }).map((c) => c.recipient), [B, C], 'throwing isBlocked counts true')
  t.alike(candidates(rec, { isBlocked: (k) => k === A }), [], 'blocked actor')
  t.alike(candidates(rec, { isBlocked: () => { throw new Error('boom') } }), [], 'throwing isBlocked for everyone')
  const replyMention = { ...post({ author: B, seq: 7 }), text: '@bia' }
  t.alike(candidates(replyMention, { isMember: (k) => k !== B }), [], 'a dropped reply does not fall back to a mention')
})

test('pushCandidates: stale records and malformed arguments', (t) => {
  const old = new Date(NOW - PUSH_MAX_AGE_MS - 1000).toISOString()
  let looked = false
  t.alike(candidates(say('@bia', { at: old, quote: { author: C, seq: 2 } }), { holders: () => { looked = true; return [B] } }), [], 'old post')
  t.absent(looked, 'no lookup for an old post')
  t.alike(candidates({ ...follow(true), at: old }), [], 'old follow')
  t.is(candidates(say('@bia', { at: new Date(NOW + 60000).toISOString() })).length, 1, 'future-dated is not suppressed')
  const throwing = new Proxy({}, { get () { throw new Error('boom') }, getPrototypeOf () { throw new Error('boom') } })
  t.alike(candidates(throwing), [], 'throwing proxy record')
  t.alike(candidates(new Proxy(say('@bia'), { get () { throw new Error('boom') } })), [], 'throwing getters')
  t.alike(pushCandidates(throwing), [], 'throwing proxy argument')
  t.alike(pushCandidates(), [], 'no argument')
  t.alike(pushCandidates(null), [], 'null argument')
  t.alike(candidates(say('@bia'), { author: 'A'.repeat(64) }), [], 'uppercase author')
  t.alike(candidates(say('@bia'), { seq: 0 }), [], 'seq 0')
  t.alike(candidates(say('@bia'), { seq: '3' }), [], 'string seq')
  t.alike(candidates(say('@bia'), { now: undefined }), [], 'missing now')
  t.alike(candidates(null), [], 'null record')
  t.alike(candidates(say('', { quote: { author: B, seq: 0 } })), [], 'quote seq 0')
  t.alike(candidates(say('', { quote: B + ':7' })), [], 'quote as string')
  t.alike(candidates(say('', { quote: { author: 'B'.repeat(64), seq: 7 } })), [], 'quote uppercase author')
})

test('pushCandidates: every result passes validatePushEvent', (t) => {
  const recs = [follow(true), engage('like', true), engage('repost', true), post({ author: B, seq: 7 }),
    say('@cris @dani', { quote: { author: B, seq: 7 } })]
  for (const rec of recs) {
    for (const c of candidates(rec)) {
      const { targetSeq, alternates, ...rest } = c
      t.ok(validatePushEvent({ v: 1, ...rest, name: 'Ana' }), c.kind + ' to ' + c.recipient.slice(0, 1))
    }
  }
})

test('pushCandidate: never a quote or a mention', (t) => {
  t.is(candidate(say('@bia', { quote: { author: B, seq: 7 } }), { isMember: everyone }), null, 'quote with mention')
  t.is(candidate(say('@bia'), { isMember: everyone, holders }), null, 'mention')
  t.alike(candidate({ ...post({ author: B, seq: 7 }), text: '@cris' }, { isMember: everyone, holders }),
    { kind: 'reply', actor: A, recipient: B, seq: 3, ref: B + ':7' }, 'reply keeps its old shape, no targetSeq')
})

test('pushName', (t) => {
  t.is(pushName('Ana'), 'Ana')
  t.is(pushName('@ana'), 'ana', 'leading at-sign')
  t.is(pushName('@\uff20\ufe6b ana'), 'ana', 'look-alike at-signs and spaces')
  t.is(pushName('\u200b\u2060@Ana'), 'Ana', 'leading invisibles')
  t.is(pushName('Ana\u0007B'), 'Ana\ufffdB', 'control char becomes U+FFFD')
  t.is(pushName('a@b'), 'a@b', 'inner at-sign kept')
  t.is(pushName(''), null)
  t.is(pushName('@@'), null)
  t.is(pushName('@ \u200b'), null, 'nothing visible')
  t.is(pushName('\ufe0f'), null, 'only a variation selector')
  t.is(pushName(null), null)
  t.is(pushName(undefined), null)
  t.is(pushName(42), null)
  const long = '\u{1f600}'.repeat(70)
  t.is(Array.from(pushName(long)).length, 64, 'clipped at 64 code points')
  t.is(pushName('x'.repeat(64)), 'x'.repeat(64))
  t.ok(validatePushEvent(event({ name: pushName('@' + 'y'.repeat(100)) })), 'output passes the validator')
})

test('pushName: direction marks are stripped before displayText', (t) => {
  t.is(pushName('\u200e@alice'), 'alice', 'LRM before the at-sign')
  t.is(pushName('@\u200ealice'), 'alice', 'LRM after the at-sign')
  t.is(pushName('\u200e'), null, 'only an LRM')
  t.is(pushName('\u061c\u200f\u2066@ana'), 'ana', 'ALM, RLM and an isolate')
  t.is(pushName('\u202e\u200e'), null, 'only marks')
  t.is(pushName('Ana\u2067'), 'Ana\ufffd', 'trailing isolate shown as U+FFFD')
  t.is(pushName('Ana\u200e'), 'Ana\ufffd', 'trailing LRM shown as U+FFFD')
  t.is(pushName('\u0007'), null, 'nothing but a replaced control char')
  t.is(pushName('Ana Souza'), 'Ana Souza')
  for (const raw of ['Ana\u2067', 'Ana\u200e', '\ud800Ana', 'Ana\u0007B']) {
    t.ok(validatePushEvent(event({ name: pushName(raw) })), 'output passes the validator: ' + JSON.stringify(raw))
  }
})

test('pushName: nothing visible within the first 64 code points gives null', (t) => {
  t.is(pushName('\ufffd'.repeat(64) + 'Ana'), null, '64 replacement characters, then a name')
  t.is(pushName('\ud800'.repeat(64) + 'Ana'), null, '64 lone surrogates, then a name')
  t.is(pushName('\ufffd'.repeat(63) + 'Ana'), '\ufffd'.repeat(63) + 'A', 'one visible char inside the clip')
})

test('validatePushEvent: accepts every kind', (t) => {
  t.ok(validatePushEvent(event()))
  t.ok(validatePushEvent(event({ kind: 'repost', name: null })))
  t.ok(validatePushEvent(event({ kind: 'reply' })))
  t.ok(validatePushEvent(event({ kind: 'follow', ref: null })))
  t.ok(validatePushEvent(event({ name: 'x'.repeat(64) })))
  t.ok(validatePushEvent(event({ kind: 'quote', ref: A + ':3' })), 'quote names the actor post')
  t.ok(validatePushEvent(event({ kind: 'mention', ref: A + ':3', name: null })), 'mention names the actor post')
})

test('validatePushEvent: quote and mention refs must be the actor post', (t) => {
  for (const kind of ['quote', 'mention']) {
    t.absent(validatePushEvent(event({ kind, ref: B + ':7' })), kind + ': ref authored by the recipient')
    t.absent(validatePushEvent(event({ kind, ref: C + ':3' })), kind + ': ref authored by a third key')
    t.absent(validatePushEvent(event({ kind, ref: A + ':4' })), kind + ': another actor seq')
    t.absent(validatePushEvent(event({ kind, ref: A + ':03' })), kind + ': leading zero')
    t.absent(validatePushEvent(event({ kind, ref: 'A'.repeat(64) + ':3' })), kind + ': uppercase')
    t.absent(validatePushEvent(event({ kind, ref: null })), kind + ': no ref')
    t.absent(validatePushEvent(event({ kind, seq: 4, ref: A + ':3' })), kind + ': seq mismatch')
  }
  t.absent(validatePushEvent(event({ kind: 'reply', ref: A + ':3' })), 'reply still needs a recipient ref')
  t.absent(validatePushEvent(event({ kind: 'like', ref: A + ':3' })), 'like still needs a recipient ref')
})

test('validatePushEvent: refuses bad events', (t) => {
  t.absent(validatePushEvent(null))
  t.absent(validatePushEvent([]))
  t.absent(validatePushEvent({ ...event(), extra: 1 }), 'extra key')
  const missing = event()
  delete missing.name
  t.absent(validatePushEvent(missing), 'missing key')
  t.absent(validatePushEvent(event({ v: 2 })), 'version')
  t.absent(validatePushEvent(event({ kind: 'boost' })), 'kind')
  t.absent(validatePushEvent(event({ actor: 'A'.repeat(64) })), 'uppercase actor')
  t.absent(validatePushEvent(event({ recipient: 'zz' })), 'bad hex recipient')
  t.absent(validatePushEvent(event({ actor: B })), 'actor equals recipient')
  t.absent(validatePushEvent(event({ seq: 0 })), 'seq 0')
  t.absent(validatePushEvent(event({ seq: Number.MAX_SAFE_INTEGER + 1 })), 'unsafe seq')
  t.absent(validatePushEvent(event({ ref: C + ':7' })), 'ref author is not the recipient')
  t.absent(validatePushEvent(event({ ref: B + ':0' })), 'ref seq 0')
  t.absent(validatePushEvent(event({ ref: B + ':07' })), 'ref leading zero')
  t.absent(validatePushEvent(event({ ref: 'B'.repeat(64) + ':7' })), 'ref uppercase')
  t.absent(validatePushEvent(event({ ref: null })), 'like without ref')
  t.absent(validatePushEvent(event({ kind: 'follow', ref: B + ':7' })), 'follow with ref')
  t.absent(validatePushEvent(event({ name: '' })), 'empty name')
  t.absent(validatePushEvent(event({ name: 'x'.repeat(65) })), '65-code-point name')
  t.absent(validatePushEvent(event({ name: 'Ana\u202e' })), 'bidi override')
  t.absent(validatePushEvent(event({ name: 'Ana\n' })), 'newline')
  t.absent(validatePushEvent(event({ name: 'Ana\u007f' })), 'DEL')
  t.absent(validatePushEvent(event({ name: 'Ana\u0085' })), 'C1')
  t.absent(validatePushEvent(event({ name: 'Ana\u2028' })), 'line separator')
  t.absent(validatePushEvent(event({ name: 5 })), 'non-string name')
  t.absent(validatePushEvent(event({ name: 'Ana\u2067' })), 'isolate')
  t.absent(validatePushEvent(event({ name: 'Ana\u200e' })), 'LRM')
  t.absent(validatePushEvent(event({ name: 'Ana\u200f' })), 'RLM')
  t.absent(validatePushEvent(event({ name: 'Ana\u061c' })), 'ALM')
  t.absent(validatePushEvent(event({ name: 'Ana\ud800' })), 'lone surrogate')
  t.ok(validatePushEvent(event({ name: 'Jos\u00e9 \u{1f600}' })), 'normal non-ASCII name')
  t.absent(validatePushEvent(new Proxy(event(), { ownKeys () { throw new Error('boom') } })), 'throwing proxy')
})

test('module loads without node built-ins', (t) => {
  const fs = require('fs')
  const src = fs.readFileSync(require.resolve('../lib/push-events'), 'utf8')
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
  t.alike(requires.sort(), ['./records', '@varanda/rpc'])
  t.absent(/process\.|#fs|#path|#process|node:/.test(src))
})

test('validatePushCancel: exact shape, follow/like/repost only, ref into the recipient\'s log', (t) => {
  const { validatePushCancel } = require('../lib/push-events')
  const ok = { v: 1, op: 'cancel', kind: 'like', actor: B, recipient: A, ref: A + ':7' }
  t.ok(validatePushCancel(ok))
  t.ok(validatePushCancel({ ...ok, kind: 'repost' }))
  t.ok(validatePushCancel({ ...ok, kind: 'follow', ref: null }))
  t.absent(validatePushCancel({ ...ok, kind: 'follow' }), 'a follow has no ref')
  t.absent(validatePushCancel({ ...ok, ref: null }), 'a like needs a ref')
  t.absent(validatePushCancel({ ...ok, ref: B + ':7' }), 'a ref outside the recipient\'s log')
  t.absent(validatePushCancel({ ...ok, ref: A + ':0' }), 'seq 0')
  for (const kind of ['reply', 'quote', 'mention', 'dm-wake']) t.absent(validatePushCancel({ ...ok, kind }), kind + ' cannot be recalled')
  t.absent(validatePushCancel({ ...ok, op: 'push' }), 'op')
  t.absent(validatePushCancel({ ...ok, v: 2 }), 'v')
  t.absent(validatePushCancel({ ...ok, recipient: B }), 'self')
  t.absent(validatePushCancel({ ...ok, actor: B.toUpperCase() }), 'uppercase key')
  t.absent(validatePushCancel({ ...ok, seq: 3 }), 'extra key')
  const { op, ...missing } = ok
  t.absent(validatePushCancel(missing), 'missing op')
  t.absent(validatePushCancel(null))
  t.absent(validatePushCancel([]))
})

test('pushCancel: an off follow, like or repost recalls what its on record would push', (t) => {
  const { pushCancel, validatePushCancel } = require('../lib/push-events')
  const cancel = (record, opts = {}) => pushCancel({ author: A, seq: 3, record, now: NOW, ...opts })
  const follows = cancel(follow(false))
  const likes = cancel(engage('like', false))
  const reposts = cancel(engage('repost', false))
  t.alike(follows, { v: 1, op: 'cancel', kind: 'follow', actor: A, recipient: B, ref: null })
  t.alike(likes, { v: 1, op: 'cancel', kind: 'like', actor: A, recipient: B, ref: B + ':7' })
  t.alike(reposts, { v: 1, op: 'cancel', kind: 'repost', actor: A, recipient: B, ref: B + ':7' })
  t.ok([follows, likes, reposts].every(validatePushCancel), 'every cancel passes validatePushCancel')
  t.ok(cancel({ ...follow(false), at: undefined }), 'no at is not stale')
  t.ok(cancel({ ...follow(false), at: new Date(NOW - PUSH_MAX_AGE_MS).toISOString() }), 'exactly 24 h old still recalls')
})

test('pushCancel: the shape only, whatever membership or blocks (the seeder gates on what it pushed)', (t) => {
  const { pushCancel } = require('../lib/push-events')
  const want = { v: 1, op: 'cancel', kind: 'follow', actor: A, recipient: B, ref: null }
  t.alike(pushCancel({ author: A, seq: 3, record: follow(false), now: NOW }), want, 'no predicates needed')
  t.alike(pushCancel({ author: A, seq: 3, record: follow(false), isMember: () => false, now: NOW }), want, 'a non-member recipient')
  t.alike(pushCancel({ author: A, seq: 3, record: follow(false), isBlocked: () => true, now: NOW }), want, 'a block since the push')
  t.alike(pushCancel({ author: A, seq: 3, record: follow(false), isBlocked: () => { throw new Error('x') }, now: NOW }), want, 'a throwing predicate is not asked')
})

test('pushCancel: on records, self-targets, stale and garbage give null', (t) => {
  const { pushCancel } = require('../lib/push-events')
  const cancel = (record, opts = {}) => pushCancel({ author: A, seq: 3, record, now: NOW, ...opts })
  t.is(cancel(follow(true)), null, 'follow on')
  t.is(cancel(engage('like', true)), null, 'like on')
  t.is(cancel(engage('repost', true)), null, 'repost on')
  t.is(cancel({ ...follow(true), on: undefined }), null, 'on missing')
  t.is(cancel({ ...follow(false), on: 0 }), null, 'on falsy but not false')
  t.is(cancel({ ...post({ author: B, seq: 7 }), on: false }), null, 'a post is never recalled')
  t.is(cancel(follow(false, A)), null, 'self-unfollow')
  t.is(cancel(engage('like', false, A)), null, 'self-like off')
  t.is(cancel(engage('repost', false, A)), null, 'self-repost off')
  t.is(cancel({ ...engage('like', false), at: new Date(NOW - PUSH_MAX_AGE_MS - 1).toISOString() }), null, 'stale')
  t.is(cancel({ ...follow(false), key: 'B' }), null, 'bad follow key')
  t.is(cancel({ type: 'like', to: { author: B, seq: 0 }, on: false, at: AT }), null, 'seq 0 target')
  t.is(cancel({ type: 'like', to: null, on: false, at: AT }), null, 'null target')
  t.is(cancel(follow(false), { author: 'x' }), null, 'bad author')
  t.is(cancel(follow(false), { seq: 0 }), null, 'bad seq')
  t.is(cancel(follow(false), { now: NaN }), null, 'bad now')
  t.is(pushCancel(null), null)
  t.is(pushCancel([]), null)
  t.is(pushCancel({ author: A, seq: 3, record: null, now: NOW }), null)
  const trap = { type: 'follow', on: false }
  Object.defineProperty(trap, 'key', { enumerable: true, get () { throw new Error('x') } })
  t.is(cancel(trap), null, 'a throwing record never throws')
})
