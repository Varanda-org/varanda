'use strict'

// Which records become Web Push notices, the actor name they carry and the
// event shape the seeder relays to the account service. No network.
const test = require('brittle')
const {
  PUSH_KINDS,
  PUSH_MAX_AGE_MS,
  pushCandidate,
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
  t.alike(PUSH_KINDS, ['follow', 'reply', 'like', 'repost'])
  t.is(PUSH_MAX_AGE_MS, 6 * 3600 * 1000)
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
  t.ok(candidate({ ...follow(true), at: new Date(NOW + 60000).toISOString() }), 'future-dated is not suppressed')
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

test('validatePushEvent: accepts every kind', (t) => {
  t.ok(validatePushEvent(event()))
  t.ok(validatePushEvent(event({ kind: 'repost', name: null })))
  t.ok(validatePushEvent(event({ kind: 'reply' })))
  t.ok(validatePushEvent(event({ kind: 'follow', ref: null })))
  t.ok(validatePushEvent(event({ name: 'x'.repeat(64) })))
})

test('validatePushEvent: refuses bad events', (t) => {
  t.absent(validatePushEvent(null))
  t.absent(validatePushEvent([]))
  t.absent(validatePushEvent({ ...event(), extra: 1 }), 'extra key')
  const missing = event()
  delete missing.name
  t.absent(validatePushEvent(missing), 'missing key')
  t.absent(validatePushEvent(event({ v: 2 })), 'version')
  t.absent(validatePushEvent(event({ kind: 'quote' })), 'kind')
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
