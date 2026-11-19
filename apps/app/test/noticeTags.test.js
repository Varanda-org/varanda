'use strict'

const test = require('brittle')
const fs = require('node:fs')
const vm = require('node:vm')
const { PUSH_KINDS, pushCandidates } = require('../../../packages/core/lib/push-events')
const core = require('../../../packages/core/lib/notice-tags')
const vectors = require('./notice-tag-vectors.json')
const load = () => import('../src/noticeTags.js')
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

test('shared valid and invalid tag vectors', async (t) => {
  const api = await load()
  t.is(api.CLOSE_MAX, 16)
  for (const tag of vectors.valid) t.is(api.validTag(tag), true, tag)
  for (const tag of vectors.invalid) t.is(api.validTag(tag), false, JSON.stringify(tag))
  for (const tag of [undefined, Symbol('tag'), Object('varanda-dm')]) t.is(api.validTag(tag), false)
})

test('shared payload vectors', async (t) => {
  const api = await load()
  for (const { payload, tag } of vectors.payloads) t.is(api.tagOf(payload), tag, JSON.stringify(payload))
  t.is(api.tagOf(undefined), null)
})

test('social vectors come from pushCandidates', async (t) => {
  const api = await load()
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
    t.is(api.tagOf(sent), tag)
  }
})

test('shared SHA-256 vectors have 16 unpadded base64url characters', async (t) => {
  const api = await load()
  for (const { tag, hash } of vectors.hashes) {
    const actual = await api.tagHash(tag)
    t.is(actual, hash, tag)
    t.ok(/^[A-Za-z0-9_-]{16}$/.test(actual))
  }
})

test('hashes agree across core, app and a browser context', async (t) => {
  const { tagHash } = await load()
  const source = fs.readFileSync(require.resolve('../src/noticeTags.js'), 'utf8')
  t.absent(/\b(?:import|require)\s*(?:[({*'"]|[\w])/m.test(source), 'the app module has no imports')
  const browser = vm.runInNewContext(source.replace(/^export /gm, '') + '\n;({ tagHash })', {
    crypto: globalThis.crypto,
    TextEncoder,
    btoa
  })
  for (const { tag, hash } of vectors.hashes) {
    t.is(await tagHash(tag), core.tagHash(tag))
    t.is(await browser.tagHash(tag), hash, 'no Node or React globals')
  }
})

test('tagOf agrees with the actual worker for the shared payloads', async (t) => {
  const { tagOf, validTag } = await load()
  const source = fs.readFileSync(require.resolve('../scripts/sw.js'), 'utf8')
  const helpers = source.slice(source.indexOf('const PUSH_KINDS ='), source.indexOf('function isAppWindow ('))
  const show = source.slice(source.indexOf('async function showPush ('), source.indexOf('// Opens the Avisos screen'))
  let shown
  const worker = vm.runInNewContext(helpers + '\n' + show + '\n;({ showPush })', {
    self: { registration: { showNotification: async (title, options) => { shown = options.tag } } },
    wakeFocusedWindow: async () => false,
    dmWakesMuted: async () => false,
    actorBlocked: async () => false
  })
  for (const { payload } of vectors.payloads) {
    shown = null
    await worker.showPush({ json: () => payload })
    t.ok(shown, 'worker showed its notice')
    t.is(tagOf(payload), validTag(shown) ? shown : null, JSON.stringify(payload))
  }
})

test('inboxes require zero unread and no pending request, independently', async (t) => {
  const { readTags } = await load()
  const read = { unread: 0, requests: 0 }
  t.alike(readTags({ dm: read, pageDm: read }), ['varanda-dm', 'varanda-dm-page'])
  t.alike(readTags({ dm: { unread: 0, requests: false } }), ['varanda-dm'])
  for (const inbox of [
    { unread: 1, requests: 0 }, { unread: 0, requests: 1 },
    { unread: 0, requests: true }, { unread: 2, requests: 3 },
    { unread: 0 }, { requests: 0 }, {}, null,
    { unread: '0', requests: 0 }, { unread: -1, requests: 0 },
    { unread: 0, requests: [] }, { unread: 0, requests: -1 }
  ]) {
    t.alike(readTags({ dm: inbox, pageDm: read }), ['varanda-dm-page'])
    t.alike(readTags({ dm: read, pageDm: inbox }), ['varanda-dm'])
  }
  t.alike(readTags(), [], 'unloaded state cannot clear notices')
})

test('public groups close individually; private groups need a zero total', async (t) => {
  const { readTags } = await load()
  const groups = [{ group: A, unread: 0 }, { group: B, unread: 1 }]
  t.alike(readTags({ groups, privateUnread: 0 }), ['varanda-group-' + A, 'varanda-group-private'])
  for (const privateUnread of [1, 2, undefined, null, false, -1, '0']) {
    t.alike(readTags({ groups, privateUnread }), ['varanda-group-' + A])
  }
  t.alike(readTags({ groups: [{ group: A.toUpperCase(), unread: 0 }, { group: A }, null] }), [])
})

test('read social rows close the tags produced by the service, including replies', async (t) => {
  const { readTags } = await load()
  const { noticeRef } = await import('../src/notices.js')
  for (const { record, seq, payload } of vectors.payloads.filter((vector) => vector.record)) {
    const [event] = pushCandidates({
      author: payload.actor,
      seq,
      record,
      now: 1,
      isMember: () => true,
      isBlocked: () => false,
      holders: () => [payload.recipient]
    })
    const serviceTag = core.tagOf({
      v: 1, kind: event.kind, actor: event.actor, recipient: event.recipient, ref: event.ref, body: payload.body
    })
    const row = { kind: event.kind, key: event.actor, seq, post: B + ':7', read: true }
    t.alike(readTags({ avisos: [row] }), [serviceTag], event.kind)
    t.alike(readTags({ avisos: [{ ...row, read: false }] }), [])
    t.alike(readTags({ avisos: [{ ...row, read: undefined }] }), [])
    if (event.kind === 'reply') {
      t.not(event.ref, noticeRef(row), 'the push names the parent, not the reply')
      t.alike(readTags({ avisos: [{ ...row, post: undefined }] }), [], 'no fallback to the reply')
    }
  }
  t.alike(readTags({ avisos: [{ key: A, read: true }] }), ['varanda-follow-' + A], 'legacy follow row')
  t.alike(readTags({ avisos: [{ kind: 'unknown', key: A, read: true }, null] }), [])
})

test('read tags are newest first, unique, capped and deterministic without mutating input', async (t) => {
  const { CLOSE_MAX, readTags } = await load()
  const avisos = Array.from({ length: 24 }, (_, i) => Object.freeze({
    kind: 'reply', key: A, seq: i + 1, post: B + ':' + (i + 1), read: true, at: i + 1
  }))
  const expected = avisos.slice(-CLOSE_MAX).reverse().map((row) => 'varanda-reply-' + row.post)
  t.alike(readTags({ avisos: Object.freeze(avisos) }), expected)
  t.alike(readTags({ avisos: [...avisos].reverse() }), expected)
  t.alike(readTags({ avisos: [avisos[23], ...avisos] }), expected)
  const tied = [
    { kind: 'follow', key: B, read: true, at: '2026-11-18T00:00:00.000Z' },
    { kind: 'follow', key: A, read: true, at: Date.parse('2026-11-18T00:00:00.000Z') }
  ]
  t.alike(readTags({ avisos: tied }), ['varanda-follow-' + A, 'varanda-follow-' + B])
  t.alike(readTags({ avisos: tied.reverse() }), ['varanda-follow-' + A, 'varanda-follow-' + B])
  t.alike(readTags({
    dm: { unread: 0, requests: false, at: 30 },
    pageDm: { unread: 0, requests: 0, at: 10 },
    groups: [{ group: A, unread: 0, at: 20 }],
    privateUnread: 0,
    avisos: [{ kind: 'follow', key: A, read: true, at: 40 }, { kind: 'follow', key: B, read: true, at: 'bad' }]
  }), ['varanda-follow-' + A, 'varanda-dm', 'varanda-group-' + A, 'varanda-dm-page', 'varanda-follow-' + B, 'varanda-group-private'])
})

test('a still-unread row prevents closing a coalesced tag', async (t) => {
  const { readTags } = await load()
  const row = { kind: 'reply', key: A, seq: 3, post: B + ':7', read: true, at: 1 }
  for (const avisos of [[row, { ...row, seq: 4, read: false }], [{ ...row, seq: 4, read: false }, row]]) {
    t.alike(readTags({ avisos }), [])
  }
  t.alike(readTags({ groups: [{ group: A, unread: 0 }, { group: A, unread: 1 }] }), [])
})
