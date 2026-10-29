'use strict'

const test = require('brittle')
const { validateParams, METHODS, MUTATING, isMutating, MAX_NAME, MAX_BIO, MAX_TEXT, LOG_LIMIT_MAX, FEED_LIMIT_MAX, PEEK_LIMIT_MAX, NOTICES_LIMIT_DEFAULT, NOTICES_LIMIT_MAX, PROFILE_LIMIT_MAX, ENGAGEMENT_LIMIT_MAX, PEEK_SEQS_MAX, PEEK_TIMEOUT_MS } = require('..')

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
    'account.sign', 'age.sign', 'cert.add', 'diary.peek', 'engagement.read', 'feed.read', 'follow.add', 'follow.list', 'follow.remove', 'identity.create',
    'identity.show', 'invite.sign', 'like.set', 'log.read', 'node.close', 'node.info', 'notices.list', 'peek.read', 'post.create', 'post.quote', 'post.reply', 'profile.read',
    'profile.set', 'push.sign', 'report.sign', 'repost.set', 'session.open', 'sync.start', 'sync.status', 'sync.stop', 'terms.sign', 'username.add'
  ])
  t.alike([...MUTATING].sort(), [
    'cert.add', 'follow.add', 'follow.remove', 'identity.create', 'like.set', 'node.close', 'post.create', 'post.quote', 'post.reply',
    'profile.set', 'repost.set', 'sync.start', 'sync.stop', 'username.add'
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

test('terms.sign', (t) => {
  const base = { nonce: 'n'.repeat(43), version: 1 }
  t.absent(isMutating('terms.sign'))
  ok(t, 'terms.sign', base, base)
  ok(t, 'terms.sign', { ...base, version: 9999 })
  ok(t, 'terms.sign', { ...base, nonce: 'A-_9'.repeat(32) })
  bad(t, 'terms.sign', {})
  for (const k of ['nonce', 'version']) {
    const p = { ...base }
    delete p[k]
    bad(t, 'terms.sign', p, 'missing ' + k)
  }
  // The caller never chooses the member, the association or the bytes.
  for (const k of ['member', 'association', 'payload', 'bytes', 'key']) {
    bad(t, 'terms.sign', { ...base, [k]: 'ab'.repeat(32) }, 'extra ' + k)
  }
  for (const version of [0, 10000, 1.5, '1', null, -1]) bad(t, 'terms.sign', { ...base, version }, 'version ' + version)
  for (const n of ['n'.repeat(42), 'n'.repeat(129), 'n'.repeat(42) + '=', 'n'.repeat(42) + '+', 1]) {
    bad(t, 'terms.sign', { ...base, nonce: n }, 'nonce ' + n)
  }
})

test('invite.sign', (t) => {
  const base = { action: 'issue', nonce: 'n'.repeat(43) }
  t.absent(isMutating('invite.sign'))
  ok(t, 'invite.sign', base, base)
  ok(t, 'invite.sign', { ...base, nonce: 'A-_9'.repeat(32) })
  bad(t, 'invite.sign', {})
  for (const k of ['action', 'nonce']) {
    const p = { ...base }
    delete p[k]
    bad(t, 'invite.sign', p, 'missing ' + k)
  }
  // The caller never chooses the member, the association or the bytes.
  for (const k of ['member', 'association', 'payload', 'bytes', 'key', 'email']) {
    bad(t, 'invite.sign', { ...base, [k]: 'ab'.repeat(32) }, 'extra ' + k)
  }
  for (const action of ['revoke', 'ISSUE', '', null, 1]) bad(t, 'invite.sign', { ...base, action }, 'action ' + action)
  for (const n of ['n'.repeat(42), 'n'.repeat(129), 'n'.repeat(42) + '=', 'n'.repeat(42) + '+', 1]) {
    bad(t, 'invite.sign', { ...base, nonce: n }, 'nonce ' + n)
  }
})

test('age.sign', (t) => {
  const base = { action: 'session', nonce: 'n'.repeat(43) }
  t.absent(isMutating('age.sign'))
  ok(t, 'age.sign', base, base)
  ok(t, 'age.sign', { ...base, action: 'result' })
  ok(t, 'age.sign', { ...base, nonce: 'A-_9'.repeat(32) })
  bad(t, 'age.sign', {})
  for (const k of ['action', 'nonce']) {
    const p = { ...base }
    delete p[k]
    bad(t, 'age.sign', p, 'missing ' + k)
  }
  // The caller never chooses the member, the association or the bytes.
  for (const k of ['member', 'association', 'payload', 'bytes', 'key', 'age', 'band']) {
    bad(t, 'age.sign', { ...base, [k]: 'ab'.repeat(32) }, 'extra ' + k)
  }
  for (const action of ['SESSION', 'issue', '', null, 1]) bad(t, 'age.sign', { ...base, action }, 'action ' + action)
  for (const n of ['n'.repeat(42), 'n'.repeat(129), 'n'.repeat(42) + '=', 'n'.repeat(42) + '+', 1]) {
    bad(t, 'age.sign', { ...base, nonce: n }, 'nonce ' + n)
  }
})

test('push.sign', (t) => {
  const host = 'https://example.com/'
  const base = {
    nonce: 'n'.repeat(43),
    action: 'on',
    endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc',
    p256dh: 'B'.repeat(87),
    auth: 'A'.repeat(22)
  }
  t.is(isMutating('push.sign'), false)
  ok(t, 'push.sign', base, base)
  ok(t, 'push.sign', { ...base, action: 'off' })
  ok(t, 'push.sign', { ...base, nonce: 'A-_9'.repeat(32) })
  ok(t, 'push.sign', { ...base, endpoint: host + 'a'.repeat(2048 - host.length) })
  ok(t, 'push.sign', { ...base, endpoint: 'https://example.com/push?token=1' })
  ok(t, 'push.sign', { ...base, p256dh: 'A-_', auth: 'b' })
  ok(t, 'push.sign', { ...base, p256dh: 'A'.repeat(128), auth: 'B'.repeat(32) })
  bad(t, 'push.sign', {})
  for (const k of ['nonce', 'action', 'endpoint', 'p256dh', 'auth']) {
    const p = { ...base }
    delete p[k]
    bad(t, 'push.sign', p, 'missing ' + k)
  }
  // The caller never chooses the member, the association, the hash or the bytes.
  for (const k of ['member', 'association', 'endpointHash', 'payload', 'bytes', 'key']) {
    bad(t, 'push.sign', { ...base, [k]: 'ab'.repeat(32) }, 'extra ' + k)
  }
  bad(t, 'push.sign', { ...base, action: 'add' }, 'action add')
  bad(t, 'push.sign', { ...base, endpoint: 'http://example.com/push' }, 'http endpoint')
  bad(t, 'push.sign', { ...base, endpoint: 'https://user:pass@example.com/push' }, 'endpoint with credentials')
  bad(t, 'push.sign', { ...base, endpoint: 'https://user@example.com/push' }, 'endpoint with a username')
  bad(t, 'push.sign', { ...base, endpoint: 'https://example.com/push#frag' }, 'endpoint with a hash')
  bad(t, 'push.sign', { ...base, endpoint: host + 'a'.repeat(2049 - host.length) }, '2049-char endpoint')
  bad(t, 'push.sign', { ...base, endpoint: 'https://example.com/pu\tsh' }, 'endpoint with a tab')
  bad(t, 'push.sign', { ...base, endpoint: 'https://example.com/push\u00e9' }, 'endpoint with a non-ASCII char')
  bad(t, 'push.sign', { ...base, endpoint: 'https://example.com\\push' }, 'endpoint with a backslash')
  bad(t, 'push.sign', { ...base, endpoint: 'https://example.com/push\ud800' }, 'endpoint with a lone surrogate')
  bad(t, 'push.sign', { ...base, endpoint: host + '\u00e9'.repeat(2048 - host.length) }, 'non-ASCII endpoint within 2048 code points')
  ok(t, 'push.sign', { ...base, endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def?x=1&y=2' })
  bad(t, 'push.sign', { ...base, endpoint: 'https://example.com:443/push' }, 'endpoint with the default port')
  bad(t, 'push.sign', { ...base, endpoint: 'https://Example.com/push' }, 'endpoint with an uppercase host')
  bad(t, 'push.sign', { ...base, endpoint: 'https://example.com/a/../b' }, 'endpoint with dot segments')
  bad(t, 'push.sign', { ...base, endpoint: 'https://' }, 'endpoint with no host')
  bad(t, 'push.sign', { ...base, endpoint: 'https:///x' }, 'endpoint with an empty authority')
  bad(t, 'push.sign', { ...base, p256dh: 'abc=' }, 'p256dh with =')
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

test('profile.set avatar', (t) => {
  const d = { core: KEY, mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: 'cd'.repeat(32), width: 512, height: 512 }
  const msg = (params) => validateParams('profile.set', params).message
  ok(t, 'profile.set', { name: 'Ana', avatar: d }, { name: 'Ana', bio: '', avatar: d })
  ok(t, 'profile.set', { name: 'Ana', avatar: null }, { name: 'Ana', bio: '', avatar: null })
  ok(t, 'profile.set', { name: 'Ana', avatar: { ...d, mime: 'image/jpeg' } })
  ok(t, 'profile.set', { name: 'Ana', avatar: { ...d, blocks: 8, bytes: 262144 } })
  ok(t, 'profile.set', { name: 'Ana', avatar: { ...d, blocks: 1, bytes: 1 } })
  // Absent stays absent: the node keeps the newest own avatar.
  const absent = validateParams('profile.set', { name: 'Ana' })
  t.absent('avatar' in absent.value)
  t.alike(Object.keys(absent.value), ['name', 'bio'])
  const missing = { ...d }
  delete missing.width
  for (const avatar of [
    { ...d, mime: 'image/png' },
    { ...d, mime: 'image/gif' },
    { ...d, width: 511, height: 511 },
    { ...d, width: 513, height: 513 },
    { ...d, width: 512, height: 511 },
    { ...d, blocks: 9, bytes: 9 * 32768 },
    { ...d, blocks: 8, bytes: 262145 },
    { ...d, extra: 1 },
    missing,
    undefined,
    [d],
    'x',
    0,
    {}
  ]) {
    t.is(msg({ name: 'Ana', avatar }), 'parâmetro inválido: avatar', JSON.stringify(avatar))
  }
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
  ok(t, 'post.quote', { to: KEY + ':1', text: 'legenda', media: [d, d, d, d] })
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
    t.is(msg('post.quote', { to: KEY + ':1', text: 'x', media }), 'parâmetro inválido: media')
  }
  // Sparse arrays: a hole is never a descriptor.
  const between = [d, d, d]
  delete between[1]
  for (const media of [new Array(1), new Array(4), between]) {
    t.is(msg('post.create', { text: '', media }), 'parâmetro inválido: media', 'sparse media of length ' + media.length)
    t.is(msg('post.reply', { to: KEY + ':1', text: 'x', media }), 'parâmetro inválido: media')
    t.is(msg('post.quote', { to: KEY + ':1', text: 'x', media }), 'parâmetro inválido: media')
  }
  const missing = { ...d }
  delete missing.height
  t.is(msg('post.create', { text: 'x', media: [missing] }), 'parâmetro inválido: media', 'missing key')
  t.is(msg('post.quote', { to: KEY + ':1', text: 'x', media: [missing] }), 'parâmetro inválido: media')
})

test('like.set, repost.set and post.quote refs and required fields', (t) => {
  for (const method of ['like.set', 'repost.set', 'post.quote']) {
    const base = method === 'post.quote' ? { to: KEY + ':1', text: 'x' } : { to: KEY + ':1', on: true }
    t.ok(isMutating(method))
    ok(t, method, base, base)
    ok(t, method, { ...base, to: KEY + ':' + Number.MAX_SAFE_INTEGER })
    bad(t, method, {})
    for (const key of Object.keys(base)) {
      const params = { ...base }
      delete params[key]
      t.is(validateParams(method, params).message, 'parâmetro obrigatório: ' + key)
    }
    for (const to of [null, 1, {}, { author: KEY, seq: 1 }, KEY, KEY.toUpperCase() + ':1', KEY + ':0', KEY + ':01', KEY + ':-1', KEY + ':1.5', KEY + ':9007199254740992']) {
      t.is(validateParams(method, { ...base, to }).message, 'parâmetro inválido: to')
    }
    t.is(validateParams(method, { ...base, extra: true }).message, 'parâmetro desconhecido')
    if (method !== 'post.quote') {
      ok(t, method, { ...base, on: false }, { ...base, on: false })
      for (const on of [undefined, null, 0, 1, 'true', {}]) {
        t.is(validateParams(method, { ...base, on }).message, 'parâmetro inválido: on')
      }
    }
  }
})

test('post.quote requires nonempty text even with media', (t) => {
  const to = KEY + ':1'
  const d = { core: KEY, mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1, sha256: KEY, width: 1, height: 1 }
  for (const extra of [{}, { media: [d] }]) {
    for (const text of ['x', '😀'.repeat(MAX_TEXT), '\ud800'.repeat(MAX_TEXT), 'line 1\nline 2']) {
      ok(t, 'post.quote', { to, text, ...extra }, { to, text, ...extra })
    }
    for (const text of ['', null, 1, {}, 'x'.repeat(MAX_TEXT + 1), '😀'.repeat(MAX_TEXT + 1)]) {
      t.is(validateParams('post.quote', { to, text, ...extra }).message, 'parâmetro inválido: text')
    }
    t.is(validateParams('post.quote', { to, ...extra }).message, 'parâmetro obrigatório: text')
  }
  // Like post.create, RPC leaves control-character rejection to the node's
  // record builder; it only checks the text's type and code-point length.
  for (const text of ['\u0000', '\t', '\r', '\u007f', '\u0085', '\u2028', '\u202e', '\u2066']) {
    t.alike(validateParams('post.quote', { to, text }), { ...validateParams('post.create', { text }), value: { to, text } })
  }
})

test('engagement.read requires distinct refs in a dense bounded array', (t) => {
  t.is(ENGAGEMENT_LIMIT_MAX, 62)
  t.absent(isMutating('engagement.read'))
  const ref = KEY + ':1'
  ok(t, 'engagement.read', { refs: [ref] }, { refs: [ref] })
  const refs = Array.from({ length: ENGAGEMENT_LIMIT_MAX }, (_, i) => KEY + ':' + (i + 1))
  ok(t, 'engagement.read', { refs }, { refs })
  ok(t, 'engagement.read', { refs: [KEY + ':' + Number.MAX_SAFE_INTEGER, ref] })
  const sparse = [ref, KEY + ':2', KEY + ':3']
  delete sparse[1]
  for (const invalid of [undefined, null, ref, {}, [], [ref, ref], [ref, KEY + ':2', ref], [KEY.toUpperCase() + ':1'], [KEY + ':0'], [KEY + ':01'], [KEY + ':9007199254740992'], [1], [{ author: KEY, seq: 1 }], new Array(1), sparse, [...refs, KEY + ':63']]) {
    t.is(validateParams('engagement.read', { refs: invalid }).message, 'parâmetro inválido: refs')
  }
  t.is(validateParams('engagement.read', {}).message, 'parâmetro obrigatório: refs')
  t.is(validateParams('engagement.read', { refs, author: KEY }).message, 'parâmetro desconhecido')
})

test('diary.peek requires an author and dense strictly ascending seqs', (t) => {
  t.is(PEEK_SEQS_MAX, 36)
  t.is(PEEK_TIMEOUT_MS, 8000)
  t.absent(isMutating('diary.peek'))
  const base = { author: KEY, seqs: [1] }
  ok(t, 'diary.peek', base, base)
  const seqs = Array.from({ length: PEEK_SEQS_MAX }, (_, i) => i + 1)
  ok(t, 'diary.peek', { author: KEY, seqs }, { author: KEY, seqs })
  ok(t, 'diary.peek', { author: KEY, seqs: [1, Number.MAX_SAFE_INTEGER] })
  for (const author of [undefined, null, 1, {}, KEY.toUpperCase(), KEY.slice(1), KEY + '0']) {
    t.is(validateParams('diary.peek', { ...base, author }).message, 'parâmetro inválido: author')
  }
  for (const key of Object.keys(base)) {
    const params = { ...base }
    delete params[key]
    t.is(validateParams('diary.peek', params).message, 'parâmetro obrigatório: ' + key)
  }
  const sparse = [1, 2, 3]
  delete sparse[1]
  for (const invalid of [undefined, null, 1, '1', {}, [], [0], [-1], [1.5], ['1'], [null], [Number.MAX_SAFE_INTEGER + 1], [1, 1], [2, 1], [1, 3, 2], new Array(1), sparse, [...seqs, PEEK_SEQS_MAX + 1]]) {
    t.is(validateParams('diary.peek', { ...base, seqs: invalid }).message, 'parâmetro inválido: seqs')
  }
  for (const key of ['profileSeq', 'usernameSeq']) {
    for (const seq of [1, Number.MAX_SAFE_INTEGER]) ok(t, 'diary.peek', { ...base, [key]: seq }, { ...base, [key]: seq })
    for (const seq of [undefined, null, 0, -1, 1.5, '1', {}, Number.MAX_SAFE_INTEGER + 1]) {
      t.is(validateParams('diary.peek', { ...base, [key]: seq }).message, 'parâmetro inválido: ' + key)
    }
  }
  ok(t, 'diary.peek', { ...base, profileSeq: 1, usernameSeq: 2 })
  t.is(validateParams('diary.peek', { ...base, extra: true }).message, 'parâmetro desconhecido')
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

test('peek.read', (t) => {
  t.absent(isMutating('peek.read'))
  ok(t, 'peek.read', {}, { limit: 30 })
  ok(t, 'peek.read', { limit: PEEK_LIMIT_MAX }, { limit: PEEK_LIMIT_MAX })
  bad(t, 'peek.read', { limit: 0 })
  bad(t, 'peek.read', { limit: PEEK_LIMIT_MAX + 1 })
  bad(t, 'peek.read', { limit: null })
  bad(t, 'peek.read', { x: 1 })
})

test('peek.read after', (t) => {
  const after = { round: 0, at: '2026-10-24T12:00:00.000Z', author: KEY, seq: 1 }
  ok(t, 'peek.read', { limit: 5, after }, { limit: 5, after })
  ok(t, 'peek.read', { after }, { limit: 30, after })
  ok(t, 'peek.read', { after: { ...after, round: 2 } })
  bad(t, 'peek.read', { after: { at: after.at, author: KEY, seq: 1 } }, 'missing round')
  bad(t, 'peek.read', { after: { round: 0, author: KEY, seq: 1 } }, 'missing at')
  bad(t, 'peek.read', { after: { round: 0, at: after.at, seq: 1 } }, 'missing author')
  bad(t, 'peek.read', { after: { round: 0, at: after.at, author: KEY } }, 'missing seq')
  bad(t, 'peek.read', { after: { ...after, x: 1 } }, 'extra key in the cursor')
  bad(t, 'peek.read', { after: { ...after, round: -1 } }, 'round -1')
  bad(t, 'peek.read', { after: { ...after, round: 1.5 } }, 'round 1.5')
  bad(t, 'peek.read', { after: { ...after, at: '2026-10-24T12:00:00Z' } }, 'non-canonical at')
  bad(t, 'peek.read', { after: { ...after, author: KEY.toUpperCase() } }, 'uppercase author')
  bad(t, 'peek.read', { after: { ...after, seq: 0 } }, 'seq 0')
  bad(t, 'peek.read', { after: null })
  bad(t, 'peek.read', { after: 'x' })
})

test('notices.list', (t) => {
  t.is(isMutating('notices.list'), false)
  t.is(NOTICES_LIMIT_DEFAULT, 30)
  t.is(NOTICES_LIMIT_MAX, 64)
  ok(t, 'notices.list', {}, { limit: 30 })
  ok(t, 'notices.list', { limit: 1 }, { limit: 1 })
  ok(t, 'notices.list', { limit: NOTICES_LIMIT_MAX }, { limit: NOTICES_LIMIT_MAX })
  for (const limit of [0, 65, 1.5, '3', null]) bad(t, 'notices.list', { limit })
  bad(t, 'notices.list', { x: 1 })
})

test('notices.list after', (t) => {
  const after = { at: '2026-10-24T12:00:00.000Z', key: KEY }
  ok(t, 'notices.list', { limit: 5, after }, { limit: 5, after })
  ok(t, 'notices.list', { after }, { limit: 30, after })
  bad(t, 'notices.list', { after: { key: KEY } }, 'missing at')
  bad(t, 'notices.list', { after: { at: after.at } }, 'missing key')
  bad(t, 'notices.list', { after: { ...after, x: 1 } }, 'extra key in the cursor')
  bad(t, 'notices.list', { after: { ...after, key: KEY.toUpperCase() } }, 'uppercase key')
  bad(t, 'notices.list', { after: { ...after, key: KEY.slice(1) } }, 'short key')
  bad(t, 'notices.list', { after: { ...after, key: KEY + '0' } }, 'long key')
  for (const at of ['2026-10-24T12:00:00Z', '2026-10-24', 'invalid', 1, '']) {
    bad(t, 'notices.list', { after: { ...after, at } }, 'at ' + JSON.stringify(at))
  }
  bad(t, 'notices.list', { after: null })
  bad(t, 'notices.list', { after: 'x' })
  bad(t, 'notices.list', { after: [] })
  bad(t, 'notices.list', { after, x: 1 })
})

test('notices.list after with seq', (t) => {
  const after = { at: '2026-10-24T12:00:00.000Z', key: KEY }
  ok(t, 'notices.list', { limit: 5, after: { ...after, seq: 1 } }, { limit: 5, after: { ...after, seq: 1 } })
  ok(t, 'notices.list', { after: { ...after, seq: Number.MAX_SAFE_INTEGER } }, { limit: 30, after: { ...after, seq: Number.MAX_SAFE_INTEGER } })
  ok(t, 'notices.list', { after }, { limit: 30, after })
  bad(t, 'notices.list', { after: { ...after, seq: 0 } }, 'seq 0')
  bad(t, 'notices.list', { after: { ...after, seq: -1 } }, 'seq -1')
  bad(t, 'notices.list', { after: { ...after, seq: 1.5 } }, 'seq 1.5')
  bad(t, 'notices.list', { after: { ...after, seq: '1' } }, 'string seq')
  bad(t, 'notices.list', { after: { ...after, seq: 1, kind: 'x' } }, '4 keys')
  bad(t, 'notices.list', { after: { ...after, x: 1 } }, '2 keys plus an extra key')
  bad(t, 'notices.list', { after: { at: after.at, seq: 1 } }, 'seq without key')
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
