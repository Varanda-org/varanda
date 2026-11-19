'use strict'

const test = require('brittle')
const { CLOSE_MAX, validTag, tagOf, tagHash } = require('../lib/notice-tags')
const { PUSH_KINDS, pushCandidates } = require('../lib/push-events')
const vectors = require('../../../apps/app/test/notice-tag-vectors.json')

test('shared valid and invalid tag vectors', (t) => {
  t.is(CLOSE_MAX, 16)
  for (const tag of vectors.valid) t.is(validTag(tag), true, tag)
  for (const tag of vectors.invalid) t.is(validTag(tag), false, JSON.stringify(tag))
  for (const tag of [undefined, Symbol('tag'), Object('varanda-dm')]) t.is(validTag(tag), false)
})

test('shared payload vectors', (t) => {
  for (const { payload, tag } of vectors.payloads) t.is(tagOf(payload), tag, JSON.stringify(payload))
  t.is(tagOf(undefined), null)
})

test('social vectors come from pushCandidates', (t) => {
  const social = vectors.payloads.filter((vector) => vector.record)
  t.alike(social.map(({ payload }) => payload.kind), PUSH_KINDS)
  for (const { record, seq, payload, tag } of social) {
    const [event] = pushCandidates({
      author: payload.actor,
      seq,
      record,
      now: 1,
      isMember: (key) => key === payload.recipient,
      isBlocked: () => false,
      holders: (name) => name === 'bia' ? [payload.recipient] : []
    })
    t.ok(event, payload.kind)
    const sent = { v: 1, kind: event.kind, actor: event.actor, recipient: event.recipient, ref: event.ref, body: payload.body }
    t.alike(sent, payload)
    t.is(tagOf(sent), tag)
  }
})

test('shared SHA-256 vectors have 16 unpadded base64url characters', (t) => {
  for (const { tag, hash } of vectors.hashes) {
    const actual = tagHash(tag)
    t.is(actual, hash, tag)
    t.ok(/^[A-Za-z0-9_-]{16}$/.test(actual))
  }
})
