'use strict'

const test = require('brittle')
const { validateParams, METHODS, MUTATING, isMutating, MAX_NAME, MAX_BIO, MAX_TEXT, LOG_LIMIT_MAX, FEED_LIMIT_MAX, PROFILE_LIMIT_MAX } = require('..')

const KEY = 'ab'.repeat(32)
const ok = (t, method, params, expected) => {
  const r = validateParams(method, params)
  t.ok(r.ok, method + ' ' + JSON.stringify(params))
  if (expected !== undefined) t.alike(r.value, expected)
}
const bad = (t, method, params, label) => {
  const r = validateParams(method, params)
  t.absent(r.ok, method + ' ' + (label || JSON.stringify(params)))
  t.is(r.code, 'USAGE')
}

test('method list and mutating set', (t) => {
  t.alike([...METHODS].sort(), [
    'account.sign', 'cert.add', 'feed.read', 'follow.add', 'follow.list', 'follow.remove', 'identity.create',
    'identity.show', 'log.read', 'node.close', 'node.info', 'post.create', 'post.reply', 'profile.read',
    'profile.set', 'report.sign', 'session.open', 'sync.start', 'sync.status', 'sync.stop', 'username.add'
  ])
  t.alike([...MUTATING].sort(), [
    'cert.add', 'follow.add', 'follow.remove', 'identity.create', 'node.close', 'post.create', 'post.reply',
    'profile.set', 'sync.start', 'sync.stop', 'username.add'
  ])
})

test('no-param methods reject any key', (t) => {
  for (const m of ['node.info', 'identity.create', 'identity.show', 'sync.stop', 'sync.status', 'node.close']) {
    ok(t, m, {}, {})
    bad(t, m, { x: 1 })
    // No method takes node configuration.
    for (const k of ['dataDir', 'path', 'association', 'bootstrap', 'host', 'secretKey', 'maxLogBlocks']) bad(t, m, { [k]: 'x' })
  }
})

test('session.open', (t) => {
  ok(t, 'session.open', {}, {})
  ok(t, 'session.open', { token: 'a' })
  ok(t, 'session.open', { token: 'a'.repeat(256) })
  bad(t, 'session.open', { token: '' })
  bad(t, 'session.open', { token: 'a'.repeat(257) })
  bad(t, 'session.open', { token: 1 })
  bad(t, 'session.open', { token: 'a', x: 1 })
})

test('cert.add', (t) => {
  ok(t, 'cert.add', { cert: { v: 1 } })
  bad(t, 'cert.add', {})
  bad(t, 'cert.add', { cert: [] })
  bad(t, 'cert.add', { cert: 'x' })
  bad(t, 'cert.add', { cert: null })
  bad(t, 'cert.add', { cert: { pad: 'x'.repeat(4096) } }, 'oversized cert')
  bad(t, 'cert.add', { cert: {}, file: 'x' })
})

test('account.sign', (t) => {
  const nonce = 'n'.repeat(43)
  const base = { phase: 'reserve', nonce, username: 'ana_1', sub: '' }
  t.absent(isMutating('account.sign'))
  ok(t, 'account.sign', base, base)
  ok(t, 'account.sign', { ...base, phase: 'rename' })
  ok(t, 'account.sign', { ...base, phase: 'finish', sub: '1234567890' })
  ok(t, 'account.sign', { ...base, phase: 'finish', sub: '!'.repeat(255) })
  ok(t, 'account.sign', { ...base, nonce: 'A-_9'.repeat(32) })
  ok(t, 'account.sign', { ...base, username: 'a' + 'b'.repeat(19) })
  bad(t, 'account.sign', {})
  for (const k of Object.keys(base)) {
    const p = { ...base }
    delete p[k]
    bad(t, 'account.sign', p, 'missing ' + k)
  }
  // The caller never chooses the member, the association or the bytes.
  for (const k of ['member', 'association', 'payload', 'bytes', 'message', 'key']) {
    bad(t, 'account.sign', { ...base, [k]: 'ab'.repeat(32) }, 'extra ' + k)
  }
  for (const phase of ['', 'Reserve', 'cert', 1, null]) bad(t, 'account.sign', { ...base, phase }, 'phase ' + phase)
  for (const n of ['n'.repeat(42), 'n'.repeat(129), 'n'.repeat(42) + '=', 'n'.repeat(42) + '+', 1]) {
    bad(t, 'account.sign', { ...base, nonce: n }, 'nonce ' + n)
  }
  for (const u of ['ab', 'Ana', '1ana', 'a'.repeat(21), 'ana-b', 'ana b', 'abc123', 'deadbe', '', 7]) {
    bad(t, 'account.sign', { ...base, username: u }, 'username ' + u)
  }
  for (const sub of ['1 2', '1\n2', 'é', '!'.repeat(256), null, 5]) {
    bad(t, 'account.sign', { ...base, phase: 'finish', sub }, 'sub ' + JSON.stringify(sub))
  }
  // A subject only at finish, and always there.
  bad(t, 'account.sign', { ...base, phase: 'finish', sub: '' }, 'finish without sub')
  bad(t, 'account.sign', { ...base, sub: '123' }, 'reserve with sub')
  bad(t, 'account.sign', { ...base, phase: 'rename', sub: '123' }, 'rename with sub')
})

test('report.sign', (t) => {
  const nonce = 'n'.repeat(43)
  const account = { nonce, target: KEY, reason: 'spam' }
  const post = { nonce, target: KEY, seq: 7, reason: 'assedio', text: 'ofensivo', quote: 'linha 1\nlinha 2' }
  t.absent(isMutating('report.sign'))
  ok(t, 'report.sign', account, { ...account, text: '', quote: '' })
  ok(t, 'report.sign', post, post)
  ok(t, 'report.sign', { ...account, text: '😀'.repeat(280) })
  ok(t, 'report.sign', { ...post, quote: 'x'.repeat(MAX_TEXT) })
  ok(t, 'report.sign', { ...post, seq: 1 })
  ok(t, 'report.sign', { ...post, seq: 99999 })
  for (const reason of ['spam', 'assedio', 'ilegal', 'outro']) ok(t, 'report.sign', { ...account, reason })
  bad(t, 'report.sign', {})
  for (const k of ['nonce', 'target', 'reason']) {
    const p = { ...account }
    delete p[k]
    bad(t, 'report.sign', p, 'missing ' + k)
  }
  // The caller never chooses the member, the association, digests or bytes.
  for (const k of ['member', 'association', 'payload', 'bytes', 'digest', 'textDigest', 'key']) {
    bad(t, 'report.sign', { ...account, [k]: 'ab'.repeat(32) }, 'extra ' + k)
  }
  for (const n of ['n'.repeat(42), 'n'.repeat(129), 'n'.repeat(42) + '=', 1]) bad(t, 'report.sign', { ...account, nonce: n }, 'nonce ' + n)
  for (const target of [KEY.toUpperCase(), KEY.slice(1), KEY + '0', 1, null]) bad(t, 'report.sign', { ...account, target }, 'target ' + target)
  for (const seq of [0, 100000, 1.5, '7', null, -1]) bad(t, 'report.sign', { ...post, seq }, 'seq ' + seq)
  for (const reason of ['spam ', 'Spam', 'assédio', 'other', '', null]) bad(t, 'report.sign', { ...account, reason }, 'reason ' + reason)
  bad(t, 'report.sign', { ...account, text: '😀'.repeat(281) }, 'text of 281 code points')
  bad(t, 'report.sign', { ...account, text: null }, 'text null')
  bad(t, 'report.sign', { ...post, quote: 'x'.repeat(MAX_TEXT + 1) }, 'quote too long')
  // Cross-field: a quote only with a seq; a seq with an empty quote is a
  // photo-only post.
  const noSeq = validateParams('report.sign', { ...account, quote: 'x' })
  t.alike(noSeq, { ok: false, code: 'USAGE', message: 'quote só com seq' })
  ok(t, 'report.sign', { ...post, quote: '' }, { ...post, quote: '' })
  const absentQuote = { ...post }
  delete absentQuote.quote
  ok(t, 'report.sign', absentQuote, { ...post, quote: '' })
})

test('username.add', (t) => {
  t.ok(isMutating('username.add'))
  const record = { type: 'username', username: 'ana' }
  ok(t, 'username.add', { record }, { record })
  ok(t, 'username.add', { record: { pad: 'x'.repeat(2048 - 10) } }, undefined)
  bad(t, 'username.add', {})
  bad(t, 'username.add', { record: [] })
  bad(t, 'username.add', { record: 'x' })
  bad(t, 'username.add', { record: null })
  bad(t, 'username.add', { record: 1 })
  bad(t, 'username.add', { record, cert: {} }, 'extra param')
  bad(t, 'username.add', { record, username: 'ana' }, 'extra username')
  bad(t, 'username.add', { record: { pad: 'x'.repeat(2048 - 9) } }, 'oversized record')
})

test('profile.set', (t) => {
  ok(t, 'profile.set', { name: 'Ana' }, { name: 'Ana', bio: '' })
  ok(t, 'profile.set', { name: 'Ana', bio: 'oi' }, { name: 'Ana', bio: 'oi' })
  ok(t, 'profile.set', { name: '😀'.repeat(MAX_NAME) }, undefined)
  ok(t, 'profile.set', { name: 'a', bio: 'b'.repeat(MAX_BIO) })
  bad(t, 'profile.set', {})
  bad(t, 'profile.set', { name: '' })
  bad(t, 'profile.set', { name: 'a'.repeat(MAX_NAME + 1) })
  bad(t, 'profile.set', { name: '😀'.repeat(MAX_NAME + 1) })
  bad(t, 'profile.set', { name: 'a', bio: 'b'.repeat(MAX_BIO + 1) })
  bad(t, 'profile.set', { name: 1 })
  bad(t, 'profile.set', { name: 'a', bio: null })
  bad(t, 'profile.set', { name: 'a', at: 'x' })
})

test('post.create and post.reply', (t) => {
  ok(t, 'post.create', { text: 'olá' }, { text: 'olá' })
  ok(t, 'post.create', { text: 'x'.repeat(MAX_TEXT) })
  bad(t, 'post.create', {})
  bad(t, 'post.create', { text: '' })
  bad(t, 'post.create', { text: 'x'.repeat(MAX_TEXT + 1) })
  bad(t, 'post.create', { text: 'x', replyTo: null })
  ok(t, 'post.reply', { to: KEY + ':1', text: 'x' })
  ok(t, 'post.reply', { to: KEY + ':9007199254740991', text: 'x' })
  bad(t, 'post.reply', { to: KEY + ':0', text: 'x' }, 'seq 0')
  bad(t, 'post.reply', { to: KEY + ':01', text: 'x' }, 'leading zero')
  bad(t, 'post.reply', { to: KEY + ':9007199254740992', text: 'x' }, 'unsafe seq')
  bad(t, 'post.reply', { to: KEY.toUpperCase() + ':1', text: 'x' }, 'uppercase')
  bad(t, 'post.reply', { to: KEY, text: 'x' })
  bad(t, 'post.reply', { to: KEY + ':1' })
  bad(t, 'post.reply', { text: 'x' })
  bad(t, 'post.reply', { to: { author: KEY, seq: 1 }, text: 'x' })
})

test('post.create and post.reply with media', (t) => {
  const d = { core: KEY, mime: 'image/jpeg', start: 1, blocks: 2, bytes: 32769, sha256: 'cd'.repeat(32), width: 640, height: 480 }
  const msg = (method, params) => validateParams(method, params).message
  ok(t, 'post.create', { text: '', media: [d] }, { text: '', media: [d] })
  ok(t, 'post.create', { text: 'legenda', media: [d, d, d, d] })
  ok(t, 'post.reply', { to: KEY + ':1', text: '', media: [d] })
  ok(t, 'post.create', { text: 'x', media: [{ ...d, mime: 'image/gif', start: 8192 - 256, blocks: 256, bytes: 256 * 32768, width: 16384, height: 16384 }] })
  ok(t, 'post.create', { text: 'x', media: [{ ...d, blocks: 1, bytes: 1 }] })
  // Without media the text stays 1..MAX_TEXT.
  t.is(msg('post.create', { text: '' }), 'parâmetro inválido: text')
  t.is(msg('post.reply', { to: KEY + ':1', text: '' }), 'parâmetro inválido: text')
  t.is(msg('post.create', { text: 'x'.repeat(MAX_TEXT + 1), media: [d] }), 'parâmetro inválido: text')
  bad(t, 'post.create', { media: [d] }, 'text is required')
  const badMedia = [
    [], [d, d, d, d, d], null, d, 'x',
    [{ ...d, extra: 1 }],
    [{ ...d, core: KEY.toUpperCase() }],
    [{ ...d, sha256: 'x' }],
    [{ ...d, mime: 'video/mp4' }],
    [{ ...d, mime: 'image/svg+xml' }],
    [{ ...d, start: 0 }],
    [{ ...d, start: 8192 }],
    [{ ...d, start: 8191, blocks: 2 }],
    [{ ...d, blocks: 0 }],
    [{ ...d, blocks: 257, bytes: 257 * 32768 }],
    [{ ...d, bytes: 32768 }],
    [{ ...d, bytes: 2 * 32768 + 1 }],
    [{ ...d, width: 0 }],
    [{ ...d, height: 16385 }],
    [{ ...d, width: 1.5 }]
  ]
  for (const media of badMedia) {
    t.is(msg('post.create', { text: 'x', media }), 'parâmetro inválido: media', JSON.stringify(media))
    t.is(msg('post.reply', { to: KEY + ':1', text: 'x', media }), 'parâmetro inválido: media')
  }
  // Sparse arrays: a hole is never a descriptor.
  const between = [d, d, d]
  delete between[1]
  for (const media of [new Array(1), new Array(4), between]) {
    t.is(msg('post.create', { text: '', media }), 'parâmetro inválido: media', 'sparse media of length ' + media.length)
    t.is(msg('post.reply', { to: KEY + ':1', text: 'x', media }), 'parâmetro inválido: media')
  }
  const missing = { ...d }
  delete missing.height
  t.is(msg('post.create', { text: 'x', media: [missing] }), 'parâmetro inválido: media', 'missing key')
})

test('follow.*', (t) => {
  for (const m of ['follow.add', 'follow.remove']) {
    ok(t, m, { key: KEY }, { key: KEY })
    bad(t, m, {})
    bad(t, m, { key: KEY.toUpperCase() })
    bad(t, m, { key: KEY.slice(1) })
    bad(t, m, { key: KEY + '0' })
    bad(t, m, { key: KEY, author: KEY })
  }
})

test('follow.list', (t) => {
  ok(t, 'follow.list', {}, { offset: 0, limit: 100 })
  ok(t, 'follow.list', { offset: 4000, limit: 500 }, { offset: 4000, limit: 500 })
  ok(t, 'follow.list', { limit: 1 }, { offset: 0, limit: 1 })
  bad(t, 'follow.list', { offset: -1 })
  bad(t, 'follow.list', { offset: 1.5 })
  bad(t, 'follow.list', { limit: 0 })
  bad(t, 'follow.list', { limit: 501 })
  bad(t, 'follow.list', { key: KEY })
})

test('isMutating and a frozen MUTATING', (t) => {
  t.ok(isMutating('follow.add'))
  t.absent(isMutating('follow.list'))
  t.absent(isMutating('nope'))
  t.ok(Array.isArray(MUTATING))
  t.ok(Object.isFrozen(MUTATING))
  try { MUTATING.push('follow.list') } catch {}
  t.absent(isMutating('follow.list'), 'consumers cannot add a method')
})

test('log.read', (t) => {
  ok(t, 'log.read', {}, { limit: 20 })
  ok(t, 'log.read', { author: KEY, limit: LOG_LIMIT_MAX }, { author: KEY, limit: LOG_LIMIT_MAX })
  ok(t, 'log.read', { limit: 1 }, { limit: 1 })
  bad(t, 'log.read', { limit: 0 })
  bad(t, 'log.read', { limit: LOG_LIMIT_MAX + 1 })
  bad(t, 'log.read', { limit: 1.5 })
  bad(t, 'log.read', { limit: '5' })
  bad(t, 'log.read', { author: 'x' })
  bad(t, 'log.read', { author: KEY, offset: 1 })
  ok(t, 'log.read', { before: 1 }, { limit: 20, before: 1 })
  ok(t, 'log.read', { author: KEY, limit: 5, before: Number.MAX_SAFE_INTEGER }, { author: KEY, limit: 5, before: Number.MAX_SAFE_INTEGER })
  for (const before of [0, -1, 1.5, '5']) bad(t, 'log.read', { before }, 'before ' + JSON.stringify(before))
})

test('feed.read', (t) => {
  ok(t, 'feed.read', {}, { limit: 30 })
  ok(t, 'feed.read', { limit: FEED_LIMIT_MAX }, { limit: FEED_LIMIT_MAX })
  bad(t, 'feed.read', { limit: FEED_LIMIT_MAX + 1 })
  bad(t, 'feed.read', { limit: 0 })
  bad(t, 'feed.read', { limit: null })
  bad(t, 'feed.read', { limit: 5, author: KEY })
})

test('feed.read before', (t) => {
  const before = { at: '2026-10-24T12:00:00.000Z', author: KEY, seq: 1 }
  ok(t, 'feed.read', { limit: 5, before }, { limit: 5, before })
  ok(t, 'feed.read', { before }, { limit: 30, before })
  bad(t, 'feed.read', { before: { ...before, seq: 0 } }, 'seq 0')
  bad(t, 'feed.read', { before: { ...before, seq: 1.5 } }, 'seq 1.5')
  for (const at of ['2026-10-24T12:00:00Z', '2026-10-24', 1, '']) {
    bad(t, 'feed.read', { before: { ...before, at } }, 'at ' + JSON.stringify(at))
  }
  bad(t, 'feed.read', { before: { ...before, author: KEY.toUpperCase() } }, 'uppercase author')
  bad(t, 'feed.read', { before: { at: before.at, author: KEY } }, 'missing seq')
  bad(t, 'feed.read', { before: { ...before, x: 1 } }, 'extra key in the cursor')
  bad(t, 'feed.read', { before: null })
  bad(t, 'feed.read', { before: 'x' })
  const r = validateParams('feed.read', { before: { ...before, at: '2026-10-24T12:00:00Z' } })
  t.is(r.message, 'parâmetro inválido: before')
})

test('profile.read', (t) => {
  t.absent(isMutating('profile.read'))
  ok(t, 'profile.read', { authors: [KEY] }, { authors: [KEY] })
  const many = Array.from({ length: PROFILE_LIMIT_MAX }, (_, i) => i.toString(16).padStart(64, '0'))
  ok(t, 'profile.read', { authors: many }, { authors: many })
  ok(t, 'profile.read', { authors: [KEY, KEY] }, { authors: [KEY, KEY] })
  bad(t, 'profile.read', { authors: [] })
  bad(t, 'profile.read', { authors: Array(PROFILE_LIMIT_MAX + 1).fill(KEY) }, 'PROFILE_LIMIT_MAX + 1 keys')
  bad(t, 'profile.read', { authors: [KEY.toUpperCase()] })
  bad(t, 'profile.read', { authors: KEY })
  bad(t, 'profile.read', { authors: null })
  bad(t, 'profile.read', {})
  bad(t, 'profile.read', { authors: [KEY], limit: 5 })
})

test('sync.start', (t) => {
  ok(t, 'sync.start', {}, { once: false })
  ok(t, 'sync.start', { once: false }, { once: false })
  ok(t, 'sync.start', { once: true }, { once: true, timeoutMs: 30000 })
  ok(t, 'sync.start', { once: true, timeoutMs: 1000 }, { once: true, timeoutMs: 1000 })
  ok(t, 'sync.start', { once: true, timeoutMs: 600000 })
  bad(t, 'sync.start', { once: true, timeoutMs: 999 })
  bad(t, 'sync.start', { once: true, timeoutMs: 600001 })
  bad(t, 'sync.start', { timeoutMs: 5000 }, 'timeoutMs without once')
  bad(t, 'sync.start', { once: false, timeoutMs: 5000 })
  bad(t, 'sync.start', { once: 'yes' })
  bad(t, 'sync.start', { once: true, bootstrap: ['x'] })
})

test('unknown method and non-object params', (t) => {
  bad(t, 'nope', {})
  bad(t, 'node.info', [])
  bad(t, 'node.info', null)
})

test('messages never echo the value', (t) => {
  const r = validateParams('follow.add', { key: '/home/secret' })
  t.absent(r.message.includes('/home'))
})
