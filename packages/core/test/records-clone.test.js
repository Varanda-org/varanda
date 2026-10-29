'use strict'

// validRecordCopy without structuredClone (the plain-data fallback) must give
// the same verdict and the same copy as with it.
const test = require('brittle')
const { validRecordCopy, postRecord, profileRecord, deleteRecord } = require('../lib/records')

function withoutStructuredClone (t) {
  const original = globalThis.structuredClone
  globalThis.structuredClone = undefined
  t.teardown(() => { globalThis.structuredClone = original })
}

function cases () {
  const post = postRecord({ text: 'olá', at: '2026-10-22T10:00:00.000Z' })
  const reply = postRecord({ text: 'oi', replyTo: { author: 'a'.repeat(64), seq: 3 }, at: '2026-10-22T10:00:00.000Z' })
  const profile = profileRecord({ name: 'Ana', bio: 'b', at: '2026-10-22T10:00:00.000Z' })
  const protoKey = JSON.parse(JSON.stringify(post).slice(0, -1) + ',"__proto__":null}')
  const extra = { ...post, extra: 1 }
  const shared = { author: 'b'.repeat(64), seq: 1 }
  const sharedRefs = { ...reply, replyTo: shared }
  return { post, reply, profile, protoKey, extra, sharedRefs }
}

test('fallback and structuredClone agree on valid and invalid records', (t) => {
  const native = {}
  for (const [name, record] of Object.entries(cases())) native[name] = validRecordCopy(record, 1)
  withoutStructuredClone(t)
  t.is(typeof structuredClone, 'undefined', 'fallback in use')
  for (const [name, record] of Object.entries(cases())) {
    const copy = validRecordCopy(record, 1)
    t.alike(copy, native[name], name)
    if (copy !== null) t.not(copy, record, name + ' is a copy')
  }
  t.is(native.protoKey, null, 'an own __proto__ key is an extra key (native)')
  t.ok(native.post !== null && native.reply !== null && native.profile !== null)
})

test('fallback refuses what is not plain data, never throws', (t) => {
  withoutStructuredClone(t)
  const post = postRecord({ text: 'olá', at: '2026-10-22T10:00:00.000Z' })
  const cyclic = { ...post }
  cyclic.self = cyclic
  const getter = { ...post }
  Object.defineProperty(getter, 'text', { enumerable: true, get () { throw new Error('boom') } })
  const fn = { ...post, text: () => 'x' }
  const big = { ...post, text: 1n }
  const undef = { ...post, replyTo: undefined }
  for (const record of [cyclic, getter, fn, big, undef]) t.is(validRecordCopy(record, 1), null)
  const copy = validRecordCopy(post, 1)
  t.ok(copy !== null && Object.getPrototypeOf(copy) === Object.prototype, 'a plain object copy')
})

test('fallback and structuredClone agree on delete records', (t) => {
  const at = '2026-10-22T10:00:00.000Z'
  const range = { core: 'a'.repeat(64), start: 1, blocks: 2 }
  const make = () => {
    const plain = deleteRecord({ seq: 2, at })
    const withMedia = deleteRecord({ seq: 2, at, media: [range] })
    const extraRange = { ...withMedia, media: [{ ...range, extra: 1 }] }
    const getter = { ...plain }
    Object.defineProperty(getter, 'seq', { enumerable: true, get () { throw new Error('boom') } })
    return { plain, withMedia, extraRange, getter }
  }
  const native = {}
  for (const [name, record] of Object.entries(make())) native[name] = validRecordCopy(record, 5)
  withoutStructuredClone(t)
  for (const [name, record] of Object.entries(make())) {
    const copy = validRecordCopy(record, 5)
    t.alike(copy, native[name], name)
    if (copy !== null) t.not(copy, record, name + ' is a copy')
    if (copy !== null && copy.media) t.not(copy.media[0], record.media[0], name + ' ranges are copies')
  }
  t.ok(native.plain !== null && native.withMedia !== null)
  t.is(native.extraRange, null)
  t.is(native.getter, null)
})
