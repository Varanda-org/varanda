'use strict'

const test = require('brittle')
const { validateParams, METHODS, MUTATING, isMutating, MAX_NAME, MAX_BIO, MAX_TEXT, LOG_LIMIT_MAX, FEED_LIMIT_MAX, PEEK_LIMIT_MAX, NOTICES_LIMIT_DEFAULT, NOTICES_LIMIT_MAX, PROFILE_LIMIT_MAX, ENGAGEMENT_LIMIT_MAX, PEEK_SEQS_MAX, PEEK_TIMEOUT_MS, GROUP_LIMIT_DEFAULT, GROUP_LIMIT_MAX, GROUP_MEMBERS_LIMIT_MAX, MAX_GROUP_NAME, DM_THREAD_LIMIT_MAX } = require('..')

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
    'account.sign', 'age.proof', 'age.sign', 'cert.add', 'community.admin', 'community.admit', 'community.ban', 'community.create', 'community.info', 'community.invitePolicy', 'community.join', 'community.leave', 'community.list', 'community.members', 'community.meta', 'community.removeGroup', 'community.requests', 'diary.peek',
    'dm.enable', 'dm.list', 'dm.lookup', 'dm.pull', 'dm.putMedia', 'dm.reportSign', 'dm.seen', 'dm.send', 'dm.set', 'dm.thread', 'engagement.read', 'feed.read', 'follow.add', 'follow.list', 'follow.remove',
    'group.admin', 'group.admit', 'group.ban', 'group.create', 'group.hide', 'group.info', 'group.invitePolicy', 'group.join', 'group.leave', 'group.list', 'group.members',
    'group.meta', 'group.post', 'group.read', 'group.rekey', 'group.requests', 'group.seen',
    'identity.clear', 'identity.create', 'identity.forget', 'identity.install', 'identity.recoveryBind', 'identity.recoveryLookup', 'identity.recoveryOpen', 'identity.recoveryWrap',
    'identity.reset', 'identity.sessionSaved', 'identity.show', 'identity.status', 'invite.sign', 'like.set', 'log.read', 'media.readFile', 'media.uploadFile', 'node.close', 'node.info', 'notices.list',
    'page.feed', 'page.read', 'page.register', 'page.sign', 'peek.read',
    'post.create', 'post.delete', 'post.quote', 'post.reply', 'profile.delete', 'profile.read', 'profile.set', 'push.sign', 'recovery.sign', 'report.sign', 'repost.set',
    'seen.merge', 'seen.sign', 'session.open', 'sync.start', 'sync.status', 'sync.stop', 'terms.sign', 'username.add'
  ])
  t.alike([...MUTATING].sort(), [
    'cert.add', 'community.admin', 'community.admit', 'community.ban', 'community.create', 'community.invitePolicy', 'community.join', 'community.leave', 'community.meta', 'community.removeGroup', 'dm.enable', 'dm.putMedia', 'dm.send', 'dm.set', 'follow.add', 'follow.remove', 'group.admin', 'group.admit', 'group.ban',
    'group.create', 'group.hide', 'group.invitePolicy', 'group.join', 'group.leave', 'group.meta', 'group.post', 'group.rekey', 'identity.clear', 'identity.create', 'identity.forget',
    'identity.install', 'identity.recoveryBind', 'identity.reset', 'identity.sessionSaved', 'like.set', 'media.uploadFile', 'node.close', 'page.register', 'post.create', 'post.delete',
    'post.quote', 'post.reply',
    'profile.delete', 'profile.set', 'repost.set', 'sync.start', 'sync.stop', 'username.add'
  ])
})

test('seen.sign', (t) => {
  const base = { nonce: 'n'.repeat(43), action: 'read' }
  t.is(isMutating('seen.sign'), isMutating('push.sign'))
  t.absent(isMutating('seen.sign'))
  for (const action of ['read', 'write', 'delete']) {
    ok(t, 'seen.sign', { ...base, action }, { ...base, action })
  }
  ok(t, 'seen.sign', { ...base, nonce: 'A-_9'.repeat(32) })
  bad(t, 'seen.sign', {})
  bad(t, 'seen.sign', { nonce: base.nonce })
  bad(t, 'seen.sign', { action: 'read' })
  for (const action of ['', 'READ', 'on', 'merge', null, 1]) bad(t, 'seen.sign', { ...base, action })
  for (const nonce of ['n'.repeat(42), 'n'.repeat(129), 'n'.repeat(42) + '=', 'n'.repeat(42) + '+', null, 1]) {
    bad(t, 'seen.sign', { ...base, nonce })
  }
  for (const action of ['read', 'write', 'delete']) {
    for (const key of ['hash', 'prevHash', 'newHash', 'blob', 'member', 'association', 'payload', 'key']) {
      bad(t, 'seen.sign', { ...base, action, [key]: KEY })
    }
  }
})

test('seen.merge: shape and unchanged', (t) => {
  const base = { blob: null, avisos: { own: [] }, unchanged: false }
  t.absent(isMutating('seen.merge'))
  ok(t, 'seen.merge', base, base)
  ok(t, 'seen.merge', { ...base, unchanged: true })
  ok(t, 'seen.merge', { ...base, avisos: { own: [], pages: {} } })
  ok(t, 'seen.merge', { ...base, avisos: { own: [], pages: Object.create(null) } })
  for (const key of Object.keys(base)) {
    const params = { ...base }
    delete params[key]
    bad(t, 'seen.merge', params, 'missing ' + key)
  }
  for (const unchanged of [null, 0, 'false']) bad(t, 'seen.merge', { ...base, unchanged })
  bad(t, 'seen.merge', { ...base, blob: 'A'.repeat(43744), unchanged: true }, 'unchanged with blob')
  bad(t, 'seen.merge', { ...base, hash: KEY })
  for (const avisos of [null, [], 'x', {}, { pages: {} }, { own: [], dm: [] }, Object.create({ own: [] })]) {
    bad(t, 'seen.merge', { ...base, avisos })
  }
})

test('seen.merge: exact canonical base64 blob', (t) => {
  const base = { blob: 'Aa0+/z'.repeat(7290) + 'AAAA', avisos: { own: [] }, unchanged: false }
  t.is(base.blob.length, 43744)
  ok(t, 'seen.merge', base)
  for (const blob of [undefined, 1, {}, '', 'A'.repeat(43743), 'A'.repeat(43745), 'A'.repeat(43740)]) {
    bad(t, 'seen.merge', { ...base, blob }, 'invalid blob type or length')
  }
  for (const char of ['=', '-', '_', ' ', '\n', '\r', 'é']) {
    bad(t, 'seen.merge', { ...base, blob: 'A'.repeat(43743) + char }, 'noncanonical blob ' + JSON.stringify(char))
  }
})

test('seen.merge: bounded notice tokens and page keys', (t) => {
  const token = 'ab'.repeat(16)
  const page = 'page:' + KEY
  const base = { blob: null, avisos: { own: [token], pages: { [page]: [token] } }, unchanged: false }
  ok(t, 'seen.merge', base, base)
  ok(t, 'seen.merge', { ...base, avisos: { own: [], pages: { [page]: [] } } })
  const pages = Object.fromEntries(Array.from({ length: 4 }, (_, i) => ['page:' + String(i).repeat(64), Array(32).fill(token)]))
  ok(t, 'seen.merge', { ...base, avisos: { own: Array(256).fill(token), pages } })
  bad(t, 'seen.merge', { ...base, avisos: { own: Array(257).fill(token) } }, '257 own tokens')
  bad(t, 'seen.merge', { ...base, avisos: { own: [], pages: { ...pages, [page]: [] } } }, 'fifth page')
  bad(t, 'seen.merge', { ...base, avisos: { own: [], pages: { [page]: Array(33).fill(token) } } }, '33 page tokens')
  for (const list of [null, {}, token, Array(1), [null], [1], [token.toUpperCase()], [token.slice(1)], [token + '0'], [token + '\n'], [{ token, t: 1 }]]) {
    bad(t, 'seen.merge', { ...base, avisos: { own: list } })
    bad(t, 'seen.merge', { ...base, avisos: { own: [], pages: { [page]: list } } })
  }
  for (const key of [KEY, 'page:' + KEY.toUpperCase(), page.slice(1), page + '0', page + '\n', '__proto__']) {
    bad(t, 'seen.merge', { ...base, avisos: { own: [], pages: { [key]: [] } } })
  }
  for (const pages of [null, [], 'x', Object.create({ [page]: [] })]) {
    bad(t, 'seen.merge', { ...base, avisos: { own: [], pages } })
  }
})

test('no-param methods reject any key', (t) => {
  for (const m of ['node.info', 'identity.create', 'identity.show', 'sync.stop', 'sync.status', 'node.close', 'identity.clear', 'identity.status',
    'identity.reset', 'identity.forget', 'identity.sessionSaved']) {
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
  ok(t, 'invite.sign', { ...base, action: 'summary' })
  bad(t, 'invite.sign', {})
  for (const k of ['action', 'nonce']) {
    const p = { ...base }
    delete p[k]
    bad(t, 'invite.sign', p, 'missing ' + k)
  }
  // The caller never chooses the member, the association or the bytes.
  for (const k of ['member', 'association', 'payload', 'bytes', 'key', 'email']) {
    bad(t, 'invite.sign', { ...base, [k]: 'ab'.repeat(32) }, 'extra ' + k)
    bad(t, 'invite.sign', { ...base, action: 'summary', [k]: 'ab'.repeat(32) }, 'summary extra ' + k)
  }
  for (const action of ['revoke', 'read', 'SUMMARY', 'ISSUE', '', null, 1]) bad(t, 'invite.sign', { ...base, action }, 'action ' + action)
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

test('age.proof', (t) => {
  const proof = { type: 'age-verified', member: KEY, date: '2026-10-30T12:00:00.000Z' }
  const since = { type: 'age-since', since: '2026-10-29T00:00:00.000Z' }
  t.absent(isMutating('age.proof'))
  ok(t, 'age.proof', { verified: proof }, { verified: proof })
  ok(t, 'age.proof', { since }, { since })
  ok(t, 'age.proof', { since: null }, { since: null })
  ok(t, 'age.proof', { verified: proof, since: null }, { verified: proof, since: null })
  ok(t, 'age.proof', { verified: proof, since })
  bad(t, 'age.proof', {}, 'neither field')
  t.is(validateParams('age.proof', {}).message, 'parâmetro obrigatório: verified')
  bad(t, 'age.proof', { verified: null }, 'verified null')
  for (const v of ['x', 1, [], true]) {
    bad(t, 'age.proof', { verified: v }, 'verified ' + JSON.stringify(v))
    bad(t, 'age.proof', { since: v }, 'since ' + JSON.stringify(v))
  }
  // Size bound only: the node verifies the signature chain.
  const big = { pad: 'x'.repeat(1024) }
  bad(t, 'age.proof', { verified: big }, 'oversize verified')
  bad(t, 'age.proof', { since: big }, 'oversize since')
  ok(t, 'age.proof', { verified: { pad: 'x'.repeat(1024 - 10) } })
  bad(t, 'age.proof', { verified: proof, member: KEY }, 'extra key')
  bad(t, 'age.proof', { proof }, 'unknown key')
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
  // anexo: the hex SHA-256 of an attached image, on a group message only.
  const group = { ...post, writer: KEY, group: 'ab'.repeat(32) }
  const anexo = 'cd'.repeat(32)
  ok(t, 'report.sign', { ...group, anexo }, { ...group, anexo })
  ok(t, 'report.sign', { ...group, quote: '', anexo }, { ...group, quote: '', anexo })
  t.alike(validateParams('report.sign', { ...post, anexo }), { ok: false, code: 'USAGE', message: 'anexo só com writer' })
  t.alike(validateParams('report.sign', { ...account, anexo }), { ok: false, code: 'USAGE', message: 'anexo só com writer' })
  for (const a of ['', anexo.toUpperCase(), anexo.slice(1), anexo + '0', 1, null]) bad(t, 'report.sign', { ...group, anexo: a }, 'anexo ' + a)
  bad(t, 'report.sign', { ...group, anexo, bytes: 'AAAA' }, 'the image bytes never reach the node')
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

test('post.delete and profile.delete take one canonical ref and nothing else', (t) => {
  for (const method of ['post.delete', 'profile.delete']) {
    t.ok(isMutating(method))
    ok(t, method, { to: KEY + ':1' }, { to: KEY + ':1' })
    ok(t, method, { to: KEY + ':' + Number.MAX_SAFE_INTEGER }, { to: KEY + ':' + Number.MAX_SAFE_INTEGER })
    t.is(validateParams(method, {}).message, 'parâmetro obrigatório: to')
    t.is(validateParams(method, { to: KEY + ':1', on: true }).message, 'parâmetro desconhecido')
    for (const to of [null, 1, {}, { author: KEY, seq: 1 }, KEY, KEY + ':0', KEY + ':01', KEY + ':-1', KEY + ':1.5', KEY.toUpperCase() + ':1', KEY + ':9007199254740992']) {
      t.is(validateParams(method, { to }).message, 'parâmetro inválido: to')
    }
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

test('report.sign: writer and group (a group post)', (t) => {
  const nonce = 'n'.repeat(43)
  const WRITER = 'cd'.repeat(32)
  const base = { nonce, target: KEY, seq: 3, reason: 'spam' }
  const full = { ...base, writer: WRITER, group: KEY }
  ok(t, 'report.sign', full, { ...full, text: '', quote: '' })
  ok(t, 'report.sign', { ...full, quote: 'citado' })
  for (const [label, p] of [['writer only', { ...base, writer: WRITER }], ['group only', { ...base, group: KEY }]]) {
    bad(t, 'report.sign', p, label)
  }
  const noSeq = { nonce, target: KEY, reason: 'spam', writer: WRITER, group: KEY }
  bad(t, 'report.sign', noSeq, 'writer without seq')
  t.is(validateParams('report.sign', { ...base, writer: WRITER }).message, 'writer só com seq e group')
  t.is(validateParams('report.sign', { ...base, group: KEY }).message, 'group só com writer')
  for (const writer of [WRITER.toUpperCase(), WRITER.slice(1), 1, null]) bad(t, 'report.sign', { ...full, writer }, 'writer ' + writer)
  for (const group of [KEY.toUpperCase(), KEY.slice(1), 1, null]) bad(t, 'report.sign', { ...full, group }, 'group ' + group)
})

test('group.create', (t) => {
  t.ok(isMutating('group.create'))
  ok(t, 'group.create', { name: 'Clube', join: 'open', community: KEY }, { name: 'Clube', join: 'open', visibility: 'public', community: KEY })
  ok(t, 'group.create', { name: 'Clube', join: 'approval', visibility: 'private', community: KEY }, { name: 'Clube', join: 'approval', visibility: 'private', community: KEY })
  ok(t, 'group.create', { name: 'Clube', join: 'open', visibility: 'private', community: KEY })
  for (const visibility of ['secret', 'Public', '', null, true, 1]) bad(t, 'group.create', { name: 'Clube', join: 'open', visibility, community: KEY }, 'visibility ' + visibility)
  ok(t, 'group.create', { name: 'x'.repeat(MAX_GROUP_NAME), join: 'approval', community: KEY })
  ok(t, 'group.create', { name: '😀'.repeat(MAX_GROUP_NAME), join: 'open', community: KEY })
  bad(t, 'group.create', {})
  bad(t, 'group.create', { name: 'Clube', join: 'open' }, 'community required')
  for (const community of [KEY.toUpperCase(), KEY.slice(1), 1, null, '']) bad(t, 'group.create', { name: 'Clube', join: 'open', community }, 'community ' + community)
  bad(t, 'group.create', { name: 'Clube' })
  bad(t, 'group.create', { join: 'open', community: KEY })
  bad(t, 'group.create', { name: '', join: 'open', community: KEY })
  bad(t, 'group.create', { name: 'x'.repeat(MAX_GROUP_NAME + 1), join: 'open', community: KEY })
  for (const join of ['closed', 'Open', '', null, true]) bad(t, 'group.create', { name: 'Clube', join, community: KEY }, 'join ' + join)
  bad(t, 'group.create', { name: 'Clube', join: 'open', epoch: 1, community: KEY })
})

test('community.create', (t) => {
  t.ok(isMutating('community.create'))
  ok(t, 'community.create', { name: 'Praia', join: 'open' }, { name: 'Praia', join: 'open' })
  ok(t, 'community.create', { name: 'Praia', join: 'approval' })
  ok(t, 'community.create', { name: '😀'.repeat(MAX_GROUP_NAME), join: 'open' })
  bad(t, 'community.create', {})
  bad(t, 'community.create', { name: 'Praia' }, 'join required')
  bad(t, 'community.create', { join: 'open' })
  bad(t, 'community.create', { name: '', join: 'open' })
  bad(t, 'community.create', { name: 'x'.repeat(MAX_GROUP_NAME + 1), join: 'open' })
  for (const join of ['closed', 'Open', '', null, true]) bad(t, 'community.create', { name: 'Praia', join }, 'join ' + join)
  bad(t, 'community.create', { name: 'Praia', join: 'open', visibility: 'private' })
})

test('community.link is gone', (t) => {
  t.absent(METHODS.includes('community.link'))
  t.absent(isMutating('community.link'))
  const r = validateParams('community.link', { community: KEY, group: KEY, on: true })
  t.is(r.ok, false)
})

test('community.admin', (t) => {
  t.ok(isMutating('community.admin'))
  ok(t, 'community.admin', { community: KEY, member: KEY, on: false }, { community: KEY, member: KEY, on: false })
  bad(t, 'community.admin', { community: KEY, member: KEY })
  bad(t, 'community.admin', { community: KEY, on: true })
  bad(t, 'community.admin', { community: 'x', member: KEY, on: true })
  bad(t, 'community.admin', { community: KEY, member: KEY, on: 'true' })
  ok(t, 'community.admin', { community: KEY, member: KEY, on: true })
  bad(t, 'community.admin', { community: KEY, member: KEY, on: true, cuts: [] })
})

test('community.join and community.leave', (t) => {
  for (const m of ['community.join', 'community.leave']) {
    t.ok(isMutating(m))
    ok(t, m, { community: KEY }, m === 'community.leave' ? { community: KEY, force: false } : { community: KEY })
    bad(t, m, {})
    bad(t, m, { community: KEY.toUpperCase() })
    bad(t, m, { community: KEY.slice(1) })
    bad(t, m, { community: 1 })
    bad(t, m, { group: KEY })
    bad(t, m, { community: KEY, extra: 1 })
  }
})

test('community.leave force', (t) => {
  ok(t, 'community.leave', { community: KEY }, { community: KEY, force: false })
  ok(t, 'community.leave', { community: KEY, force: true }, { community: KEY, force: true })
  ok(t, 'community.leave', { community: KEY, force: false }, { community: KEY, force: false })
  bad(t, 'community.leave', { community: KEY, force: 'true' })
  bad(t, 'community.leave', { community: KEY, force: 1 })
  ok(t, 'community.leave', { community: KEY, force: ['root'] }, { community: KEY, force: ['root'] })
  ok(t, 'community.leave', { community: KEY, force: ['devices', 'groups'] }, { community: KEY, force: ['devices', 'groups'] })
  ok(t, 'community.leave', { community: KEY, force: ['root', 'devices', 'groups'] }, { community: KEY, force: ['root', 'devices', 'groups'] })
  bad(t, 'community.leave', { community: KEY, force: [] })
  bad(t, 'community.leave', { community: KEY, force: ['root', 'root'] })
  bad(t, 'community.leave', { community: KEY, force: ['other'] })
  bad(t, 'community.leave', { community: KEY, force: [true] })
  bad(t, 'community.leave', { community: KEY, force: 'root' })
  bad(t, 'community.leave', { force: true })
  bad(t, 'community.join', { community: KEY, force: true })
})

test('community.members and community.requests', (t) => {
  for (const m of ['community.members', 'community.requests']) {
    t.absent(isMutating(m))
    ok(t, m, { community: KEY }, { community: KEY, offset: 0, limit: GROUP_MEMBERS_LIMIT_MAX })
    ok(t, m, { community: KEY, offset: 5, limit: 1 }, { community: KEY, offset: 5, limit: 1 })
    ok(t, m, { community: KEY, limit: GROUP_MEMBERS_LIMIT_MAX })
    bad(t, m, {})
    bad(t, m, { community: 'x' })
    bad(t, m, { community: KEY, limit: 0 })
    bad(t, m, { community: KEY, limit: GROUP_MEMBERS_LIMIT_MAX + 1 })
    bad(t, m, { community: KEY, offset: -1 })
    bad(t, m, { community: KEY, offset: 1.5 })
    bad(t, m, { community: KEY, group: KEY })
  }
})

test('community.admit and community.ban', (t) => {
  for (const m of ['community.admit', 'community.ban']) {
    t.ok(isMutating(m))
    ok(t, m, { community: KEY, member: KEY, on: true }, { community: KEY, member: KEY, on: true })
    ok(t, m, { community: KEY, member: KEY, on: false })
    bad(t, m, { community: KEY, member: KEY })
    bad(t, m, { community: KEY, on: true })
    bad(t, m, { member: KEY, on: true })
    bad(t, m, { community: 'x', member: KEY, on: true })
    bad(t, m, { community: KEY, member: 'x', on: true })
    bad(t, m, { community: KEY, member: KEY, on: 1 })
    bad(t, m, { community: KEY, member: KEY, on: true, cuts: [] })
  }
})

test('community.removeGroup', (t) => {
  t.ok(isMutating('community.removeGroup'))
  ok(t, 'community.removeGroup', { community: KEY, group: KEY }, { community: KEY, group: KEY, undo: false })
  ok(t, 'community.removeGroup', { community: KEY, group: KEY, undo: true }, { community: KEY, group: KEY, undo: true })
  bad(t, 'community.removeGroup', { community: KEY, group: KEY, undo: 'yes' }, 'string undo')
  bad(t, 'community.removeGroup', { community: KEY, group: KEY, undo: null }, 'null undo')
  bad(t, 'community.removeGroup', {})
  bad(t, 'community.removeGroup', { community: KEY }, 'missing group')
  bad(t, 'community.removeGroup', { group: KEY }, 'missing community')
  bad(t, 'community.removeGroup', { community: KEY, group: KEY.slice(1) }, 'short group')
  bad(t, 'community.removeGroup', { community: KEY, group: null }, 'null group')
  bad(t, 'community.removeGroup', { community: KEY, group: KEY, force: true }, 'extra key')
})

test('community.meta', (t) => {
  t.ok(isMutating('community.meta'))
  ok(t, 'community.meta', { community: KEY, name: 'Novo' }, { community: KEY, name: 'Novo' })
  ok(t, 'community.meta', { community: KEY, join: 'approval' }, { community: KEY, join: 'approval' })
  ok(t, 'community.meta', { community: KEY, name: 'Novo', join: 'open' })
  ok(t, 'community.meta', { community: KEY, name: 'x'.repeat(MAX_GROUP_NAME) })
  bad(t, 'community.meta', {})
  bad(t, 'community.meta', { community: KEY }, 'nothing to change')
  t.is(validateParams('community.meta', { community: KEY }).message, 'nada a alterar')
  bad(t, 'community.meta', { name: 'Novo' })
  bad(t, 'community.meta', { community: KEY, name: '' })
  bad(t, 'community.meta', { community: KEY, name: 'x'.repeat(MAX_GROUP_NAME + 1) })
  bad(t, 'community.meta', { community: KEY, join: 'closed' })
  bad(t, 'community.meta', { community: KEY, name: null })
  bad(t, 'community.meta', { community: KEY, name: 'a', visibility: 'private' })
})

test('group.invitePolicy and community.invitePolicy', (t) => {
  for (const [m, k] of [['group.invitePolicy', 'group'], ['community.invitePolicy', 'community']]) {
    t.ok(isMutating(m))
    ok(t, m, { [k]: KEY, members: true }, { [k]: KEY, members: true })
    ok(t, m, { [k]: KEY, members: false })
    bad(t, m, { [k]: KEY }, 'missing members')
    bad(t, m, { members: true }, 'missing ' + k)
    bad(t, m, { [k]: KEY, members: true, extra: 1 }, 'extra key')
    for (const v of ['true', 1, 0, null, undefined]) bad(t, m, { [k]: KEY, members: v }, 'non-boolean members')
    bad(t, m, { [k]: 'x', members: true }, 'bad key')
  }
})

test('community.info', (t) => {
  t.absent(isMutating('community.info'))
  ok(t, 'community.info', { community: KEY }, { community: KEY })
  bad(t, 'community.info', {})
  bad(t, 'community.info', { community: 'x' })
  bad(t, 'community.info', { community: KEY, limit: 1 })
})

test('community.list', (t) => {
  t.absent(isMutating('community.list'))
  ok(t, 'community.list', {}, {})
  bad(t, 'community.list', { community: KEY })
  bad(t, 'community.list', { offset: 0 })
  bad(t, 'community.list', { limit: 1 })
})

test('group.rekey', (t) => {
  t.ok(isMutating('group.rekey'))
  ok(t, 'group.rekey', { group: KEY }, { group: KEY })
  bad(t, 'group.rekey', {})
  bad(t, 'group.rekey', { group: 'x' })
  bad(t, 'group.rekey', { group: KEY, epoch: { writer: KEY, seq: 1 } })
  bad(t, 'group.rekey', { group: KEY, key: 'x' })
})

test('group.join community hint', (t) => {
  ok(t, 'group.join', { group: KEY, community: KEY }, { group: KEY, community: KEY })
  for (const community of [KEY.toUpperCase(), KEY.slice(1), 1, null, '']) bad(t, 'group.join', { group: KEY, community }, 'community ' + community)
  bad(t, 'group.leave', { group: KEY, community: KEY })
})

test('group.join and group.leave', (t) => {
  for (const m of ['group.join', 'group.leave']) {
    t.ok(isMutating(m))
    ok(t, m, { group: KEY }, { group: KEY })
    bad(t, m, {})
    bad(t, m, { group: KEY.toUpperCase() })
    bad(t, m, { group: KEY.slice(1) })
    bad(t, m, { group: 1 })
    bad(t, m, { group: KEY, extra: 1 })
  }
})

test('group.post', (t) => {
  t.ok(isMutating('group.post'))
  const reply = { writer: KEY, seq: 4 }
  ok(t, 'group.post', { group: KEY, text: 'oi' }, { group: KEY, text: 'oi' })
  ok(t, 'group.post', { group: KEY, text: 'x'.repeat(MAX_TEXT), replyTo: reply }, { group: KEY, text: 'x'.repeat(MAX_TEXT), replyTo: reply })
  bad(t, 'group.post', { group: KEY, text: '' })
  bad(t, 'group.post', { group: KEY, text: 'x'.repeat(MAX_TEXT + 1) })
  bad(t, 'group.post', { text: 'oi' })
  bad(t, 'group.post', { group: KEY })
  for (const replyTo of [{ writer: KEY }, { seq: 1 }, { writer: KEY, seq: 0 }, { writer: KEY, seq: 1.5 }, { writer: 'x', seq: 1 }, { writer: KEY, seq: 1, extra: 1 }, KEY + ':1', null, []]) {
    bad(t, 'group.post', { group: KEY, text: 'oi', replyTo }, 'replyTo ' + JSON.stringify(replyTo))
  }
  // The node computes `seen` from its own fold; a caller cannot pass it.
  bad(t, 'group.post', { group: KEY, text: 'oi', seen: [] })
})

test('group.post with public media', (t) => {
  const d = { core: KEY, mime: 'image/jpeg', start: 1, blocks: 2, bytes: 32769, sha256: 'cd'.repeat(32), width: 640, height: 480 }
  const media = Array.from({ length: 4 }, (_, i) => ({ ...d, start: 1 + i * 2 }))
  const sparse = media.slice()
  delete sparse[1]
  const params = { group: KEY, text: '', media }
  ok(t, 'group.post', params, params)
  ok(t, 'group.post', { ...params, sealed: false })
  ok(t, 'group.post', { ...params, text: '\u{1f600}'.repeat(MAX_TEXT), replyTo: { writer: KEY, seq: 1 } })
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
    ok(t, 'group.post', { ...params, media: [{ ...d, mime }] })
  }
  bad(t, 'group.post', { ...params, text: 'x'.repeat(MAX_TEXT + 1) }, 'text over limit with media')
  bad(t, 'group.post', { group: KEY, media }, 'text is required with media')
  for (const invalid of [null, [], {}, [d, d], [...media, { ...d, start: 9 }], new Array(1), sparse,
    [{ ...d, mime: 'application/octet-stream' }], [{ ...d, extra: 1 }], [{ ...d, start: 0 }],
    [{ ...d, blocks: 257 }], [{ ...d, bytes: 32768 }], [{ ...d, width: 0 }]]) {
    bad(t, 'group.post', { ...params, media: invalid }, 'invalid public media')
  }
  bad(t, 'group.post', { ...params, media: [d, { ...d, sha256: KEY }] }, 'same core and start')
  ok(t, 'group.post', { ...params, media: [d, { ...d, core: 'ef'.repeat(32) }] })
  bad(t, 'group.post', { ...params, sealed: true }, 'public media cannot be sealed')
  for (const sealed of [null, 0, 1, 'true']) bad(t, 'group.post', { ...params, sealed }, 'sealed must be boolean')
})

test('group.post with private media', (t) => {
  const d = { core: KEY, mime: 'application/octet-stream', start: 7936, blocks: 256, bytes: 8388608, sha256: 'cd'.repeat(32), key: 'ef'.repeat(32), nonce: 'ab'.repeat(24), plainMime: 'image/jpeg', plainSha256: KEY, w: 16384, h: 16384, ms: 0 }
  const media = Array.from({ length: 4 }, (_, i) => ({ ...d, core: String(i).repeat(64) }))
  const params = { group: KEY, text: '', media, sealed: true }
  ok(t, 'group.post', params, params)
  ok(t, 'group.post', { ...params, text: '\ud800'.repeat(MAX_TEXT), replyTo: { writer: KEY, seq: Number.MAX_SAFE_INTEGER } })
  ok(t, 'group.post', { ...params, media: [{ ...d, start: 1, blocks: 1, bytes: 32768, w: 1, h: 1 }] })
  const { sealed, ...unmarked } = params
  bad(t, 'group.post', unmarked, 'private media requires sealed')
  bad(t, 'group.post', { ...params, sealed: false }, 'private media requires sealed true')
  for (const plainMime of ['image/png', 'image/webp', 'image/gif']) ok(t, 'group.post', { ...params, media: [{ ...d, plainMime }] })
  for (const field of Object.keys(d)) {
    const missing = { ...d }
    delete missing[field]
    bad(t, 'group.post', { ...params, media: [missing] }, 'missing ' + field)
  }
  for (const patch of [
    { extra: 1 }, { core: 'x' }, { key: KEY.toUpperCase() }, { key: '' },
    { nonce: 'f'.repeat(47) }, { nonce: 'A'.repeat(48) }, { nonce: null },
    { sha256: 'x' }, { plainSha256: 'x' }, { plainMime: 'application/octet-stream' },
    { plainMime: 'image/svg+xml' }, { mime: 'image/jpeg' }, { start: 0 }, { start: 7937 },
    { blocks: 257, bytes: 8421376 }, { bytes: 8388607 }, { width: 1 }, { height: 1 },
    { w: 0 }, { w: 1.5 }, { h: 16385 }, { ms: 1 }
  ]) bad(t, 'group.post', { ...params, media: [{ ...d, ...patch }] }, 'invalid private item fields: ' + Object.keys(patch).join(', '))
  const publicItem = { core: KEY, mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1, sha256: KEY, width: 1, height: 1 }
  for (const sealed of [false, true]) bad(t, 'group.post', { ...params, media: [d, publicItem], sealed }, 'mixed media')
  for (const media of [null, [], new Array(1), [d, d], Array(5).fill(d), [d, { ...d, key: KEY }]]) {
    bad(t, 'group.post', { ...params, media }, 'invalid private media list')
  }
  bad(t, 'post.create', { text: '', media: [d] }, 'private items stay out of public posts')
  bad(t, 'group.post', { group: KEY, text: '', sealed: true }, 'sealed alone does not allow empty text')
  bad(t, 'group.post', { group: KEY, text: 'oi', sealed: true }, 'sealed only with media')
  ok(t, 'group.post', { group: KEY, text: 'oi', sealed: false })
})

test('group.post accepts one public voice item and keeps diary posts image-only', (t) => {
  const item = { core: KEY, mime: 'audio/mp4', start: 8144, blocks: 48, bytes: 1572864, sha256: KEY, width: 0, height: 0, ms: 120000 }
  const params = { group: KEY, text: '', media: [item] }
  ok(t, 'group.post', params, params)
  ok(t, 'group.post', { ...params, sealed: false })
  ok(t, 'group.post', { ...params, text: 'Áudio', replyTo: { writer: KEY, seq: 1 }, media: [{ ...item, start: 1, blocks: 1, bytes: 1, ms: 1 }] })
  bad(t, 'group.post', { ...params, sealed: true }, 'public voice cannot be sealed')
  for (const patch of [
    { bytes: 1572865, blocks: 49, start: 1 }, { bytes: 47 * 32768 }, { bytes: 1.5, blocks: 1 },
    { start: 8145 }, { start: 0 }, { blocks: 0 }, { core: 'x' }, { sha256: 'x' },
    { width: 1 }, { height: 1 }, { width: '0' }, { mime: 'audio/ogg' }, { mime: 'image/jpeg' },
    { ms: 0 }, { ms: 120001 }, { ms: 1.5 }, { ms: '1' }, { ms: null }, { kind: 'voice' }
  ]) bad(t, 'group.post', { ...params, media: [{ ...item, ...patch }] }, 'invalid public voice: ' + JSON.stringify(patch))
  for (const field of Object.keys(item)) {
    const missing = { ...item }
    delete missing[field]
    bad(t, 'group.post', { ...params, media: [missing] }, 'public voice without ' + field)
  }
  const image = { core: KEY, mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1, sha256: KEY, width: 1, height: 1 }
  for (const media of [[item, { ...item, core: 'cd'.repeat(32) }], [item, image], [image, item]]) {
    bad(t, 'group.post', { ...params, media }, 'voice must be alone')
  }
  bad(t, 'post.create', { text: '', media: [item] })
  bad(t, 'post.reply', { text: '', to: KEY + ':1', media: [item] })
  bad(t, 'post.quote', { text: 'Áudio', to: KEY + ':1', media: [item] })
  bad(t, 'profile.set', { name: 'Ana', avatar: item })
})

test('group.post accepts one private voice item within the padded byte cap', (t) => {
  const item = { core: KEY, mime: 'application/octet-stream', start: 8143, blocks: 49, bytes: 49 * 32768, sha256: KEY, key: KEY, nonce: 'ab'.repeat(24), plainMime: 'audio/mp4', plainSha256: KEY, w: 0, h: 0, ms: 120000 }
  const params = { group: KEY, text: '', media: [item], sealed: true }
  ok(t, 'group.post', params, params)
  ok(t, 'group.post', { ...params, media: [{ ...item, blocks: 1, bytes: 32768, ms: 1 }] })
  const { sealed, ...unmarked } = params
  bad(t, 'group.post', unmarked, 'private voice requires sealed')
  bad(t, 'group.post', { ...params, sealed: false })
  for (const patch of [
    { blocks: 50, bytes: 50 * 32768, start: 1 }, { bytes: 49 * 32768 - 1 },
    { start: 8144 }, { w: 1 }, { h: 1 }, { h: '0' },
    { ms: 0 }, { ms: 120001 }, { ms: 1.5 }, { ms: '1' }, { ms: null },
    { plainMime: 'audio/ogg' }, { plainMime: 'image/jpeg' }, { mime: 'audio/mp4' },
    { key: 'x' }, { nonce: 'x' }, { plainSha256: 'x' }, { kind: 'voice' }
  ]) bad(t, 'group.post', { ...params, media: [{ ...item, ...patch }] }, 'invalid private voice: ' + JSON.stringify(patch))
  for (const field of Object.keys(item)) {
    const missing = { ...item }
    delete missing[field]
    bad(t, 'group.post', { ...params, media: [missing] }, 'private voice without ' + field)
  }
  const image = { ...item, start: 1, plainMime: 'image/jpeg', w: 1, h: 1, ms: 0 }
  for (const media of [[item, { ...item, core: 'cd'.repeat(32) }], [item, image], [image, item]]) {
    bad(t, 'group.post', { ...params, media }, 'private voice must be alone')
  }
})

test('group.read', (t) => {
  t.absent(isMutating('group.read'))
  t.is(GROUP_LIMIT_DEFAULT, GROUP_LIMIT_MAX)
  const AT = '2026-10-28T12:00:00.000Z'
  const cur = { at: AT, writer: KEY, seq: 9 }
  ok(t, 'group.read', { group: KEY }, { group: KEY, limit: GROUP_LIMIT_DEFAULT })
  ok(t, 'group.read', { group: KEY, limit: 1 })
  ok(t, 'group.read', { group: KEY, limit: GROUP_LIMIT_MAX, before: cur }, { group: KEY, limit: GROUP_LIMIT_MAX, before: cur })
  bad(t, 'group.read', {})
  bad(t, 'group.read', { group: KEY, limit: 0 })
  bad(t, 'group.read', { group: KEY, limit: GROUP_LIMIT_MAX + 1 })
  bad(t, 'group.read', { group: KEY, limit: 1.5 })
  for (const before of [{ at: AT, writer: KEY }, { at: AT, seq: 1 }, { writer: KEY, seq: 1 }, { at: '2026-10-28', writer: KEY, seq: 1 },
    { at: AT, writer: KEY, seq: 0 }, { at: AT, writer: 'x', seq: 1 }, { at: AT, writer: KEY, seq: 1, extra: 1 }, 5, null, []]) {
    bad(t, 'group.read', { group: KEY, before }, 'before ' + JSON.stringify(before))
  }
})

test('group.list', (t) => {
  t.absent(isMutating('group.list'))
  ok(t, 'group.list', {}, { offset: 0, limit: GROUP_LIMIT_DEFAULT })
  ok(t, 'group.list', { offset: 40, limit: GROUP_LIMIT_MAX }, { offset: 40, limit: GROUP_LIMIT_MAX })
  bad(t, 'group.list', { offset: -1 })
  bad(t, 'group.list', { offset: 1.5 })
  bad(t, 'group.list', { limit: 0 })
  bad(t, 'group.list', { limit: GROUP_LIMIT_MAX + 1 })
  bad(t, 'group.list', { group: KEY })
})

test('group.info', (t) => {
  t.absent(isMutating('group.info'))
  ok(t, 'group.info', { group: KEY }, { group: KEY })
  bad(t, 'group.info', {})
  bad(t, 'group.info', { group: 'x' })
  bad(t, 'group.info', { group: KEY, limit: 1 })
})

test('group.seen takes the group and an optional upTo cursor, not mutating', (t) => {
  t.absent(isMutating('group.seen'))
  ok(t, 'group.seen', { group: KEY }, { group: KEY })
  const cur = { at: '2026-10-28T12:00:00.000Z', writer: KEY, seq: 9 }
  ok(t, 'group.seen', { group: KEY, upTo: cur }, { group: KEY, upTo: cur })
  for (const upTo of [{ at: cur.at, writer: KEY }, { at: cur.at, seq: 1 }, { writer: KEY, seq: 1 }, { at: '2026-10-28', writer: KEY, seq: 1 },
    { at: cur.at, writer: KEY, seq: 0 }, { at: cur.at, writer: 'x', seq: 1 }, { at: cur.at, writer: KEY, seq: 1, extra: 1 }, 5, null, []]) {
    bad(t, 'group.seen', { group: KEY, upTo }, 'upTo ' + JSON.stringify(upTo))
  }
  bad(t, 'group.seen', {})
  bad(t, 'group.seen', { group: KEY, id: 'cd'.repeat(16) }, 'no mark by id')
})

test('group.members and group.requests', (t) => {
  for (const m of ['group.members', 'group.requests']) {
    t.absent(isMutating(m))
    ok(t, m, { group: KEY }, { group: KEY, offset: 0, limit: GROUP_MEMBERS_LIMIT_MAX })
    ok(t, m, { group: KEY, offset: 200, limit: 100 }, { group: KEY, offset: 200, limit: 100 })
    ok(t, m, { group: KEY, limit: 1 })
    bad(t, m, {})
    bad(t, m, { group: KEY, limit: 0 })
    bad(t, m, { group: KEY, limit: 101 })
  }
  bad(t, 'group.members', { group: KEY, offset: -1 })
  bad(t, 'group.members', { group: KEY, offset: 1.5 })
})

test('group.admit, group.ban and group.admin', (t) => {
  const OTHER = 'cd'.repeat(32)
  for (const m of ['group.admit', 'group.ban', 'group.admin']) {
    t.ok(isMutating(m))
    ok(t, m, { group: KEY, member: OTHER, on: true }, { group: KEY, member: OTHER, on: true })
    ok(t, m, { group: KEY, member: OTHER, on: false })
    for (const k of ['group', 'member', 'on']) {
      const p = { group: KEY, member: OTHER, on: true }
      delete p[k]
      bad(t, m, p, 'missing ' + k)
    }
    bad(t, m, { group: KEY, member: OTHER, on: 1 })
    bad(t, m, { group: KEY, member: OTHER, on: 'true' })
    bad(t, m, { group: KEY, member: 'x', on: true })
    bad(t, m, { group: KEY, member: OTHER.toUpperCase(), on: true })
    bad(t, m, { group: KEY, member: OTHER, on: true, extra: 1 })
  }
})

test('group.hide', (t) => {
  t.ok(isMutating('group.hide'))
  const target = { writer: KEY, seq: 2 }
  ok(t, 'group.hide', { group: KEY, target, on: true }, { group: KEY, target, on: true })
  ok(t, 'group.hide', { group: KEY, target, on: false })
  bad(t, 'group.hide', { group: KEY, target })
  bad(t, 'group.hide', { group: KEY, on: true })
  bad(t, 'group.hide', { group: KEY, target: KEY, on: true })
  bad(t, 'group.hide', { group: KEY, target: { writer: KEY, seq: 0 }, on: true })
  bad(t, 'group.hide', { group: KEY, target: { writer: KEY }, on: true })
  bad(t, 'group.hide', { group: KEY, target, on: 'yes' })
})

test('group.meta', (t) => {
  t.ok(isMutating('group.meta'))
  ok(t, 'group.meta', { group: KEY, name: 'Novo' }, { group: KEY, name: 'Novo' })
  ok(t, 'group.meta', { group: KEY, join: 'approval' }, { group: KEY, join: 'approval' })
  ok(t, 'group.meta', { group: KEY, name: 'Novo', join: 'open' })
  ok(t, 'group.meta', { group: KEY, name: 'x'.repeat(MAX_GROUP_NAME) })
  bad(t, 'group.meta', {})
  bad(t, 'group.meta', { group: KEY }, 'nothing to change')
  bad(t, 'group.meta', { group: KEY, name: '' })
  bad(t, 'group.meta', { group: KEY, name: 'x'.repeat(MAX_GROUP_NAME + 1) })
  bad(t, 'group.meta', { group: KEY, join: 'closed' })
  bad(t, 'group.meta', { group: KEY, name: null })
  bad(t, 'group.meta', { group: KEY, name: 'a', visibility: 'private' })
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

test('web-node host controls: mutating flags', (t) => {
  for (const m of ['identity.install', 'identity.clear', 'identity.reset', 'identity.forget', 'identity.sessionSaved', 'media.uploadFile']) {
    t.ok(isMutating(m), m + ' mutating')
  }
  t.absent(isMutating('identity.status'), 'identity.status not mutating')
  for (const m of ['follows.legacy', 'follows.confirmLegacy']) t.is(validateParams(m, {}).message, 'método desconhecido', m + ' not offered')
})

test('identity.install', (t) => {
  const base = { prf: 'cd'.repeat(32), credentialId: 'AbC-_9', userId: KEY, rpId: 'varanda.org', resumed: false }
  ok(t, 'identity.install', base, base)
  ok(t, 'identity.install', { ...base, userId: '', resumed: true })
  ok(t, 'identity.install', { ...base, credentialId: '~'.repeat(1024), rpId: 'a'.repeat(253) })
  for (const k of Object.keys(base)) {
    const p = { ...base }
    delete p[k]
    bad(t, 'identity.install', p, 'missing ' + k)
  }
  for (const prf of ['CD'.repeat(32), 'cd'.repeat(31), 'cd'.repeat(33), 'zz'.repeat(32), '', 1, null, ['cd'.repeat(32)]]) {
    bad(t, 'identity.install', { ...base, prf }, 'bad prf')
  }
  for (const credentialId of ['', 'a'.repeat(1025), 'a b', 'a\nb', 'a\u0000', 'é', 1, null]) {
    bad(t, 'identity.install', { ...base, credentialId }, 'bad credentialId')
  }
  for (const userId of ['AB'.repeat(32), 'ab'.repeat(31), 'x', null, 0]) bad(t, 'identity.install', { ...base, userId }, 'bad userId')
  for (const rpId of ['', 'a'.repeat(254), 1, null]) bad(t, 'identity.install', { ...base, rpId }, 'bad rpId')
  for (const resumed of ['true', 1, 0, null]) bad(t, 'identity.install', { ...base, resumed }, 'bad resumed')
  bad(t, 'identity.install', { ...base, secretKey: KEY })
})

const RBLOB = { v: 1, kind: 'passkey', nonce: 'cd'.repeat(24), ciphertext: 'cd'.repeat(82) }
const RNONCE = 'A-_9'.repeat(11)

test('recovery.sign', (t) => {
  t.absent(isMutating('recovery.sign'))
  const put = { action: 'put', nonce: RNONCE, kind: 'passkey', lookupId: KEY, blob: RBLOB }
  ok(t, 'recovery.sign', put, put)
  ok(t, 'recovery.sign', { ...put, kind: 'code', blob: { ...RBLOB, kind: 'code' } })
  ok(t, 'recovery.sign', { action: 'remove', nonce: RNONCE, kind: 'code', lookupId: KEY })
  ok(t, 'recovery.sign', { action: 'list', nonce: RNONCE }, { action: 'list', nonce: RNONCE })
  const { blob, ...noBlob } = put
  bad(t, 'recovery.sign', noBlob, 'put without blob')
  bad(t, 'recovery.sign', { ...put, blob: { ...RBLOB, kind: 'code' } }, 'blob kind differs')
  bad(t, 'recovery.sign', { action: 'remove', nonce: RNONCE, kind: 'code', lookupId: KEY, blob: RBLOB }, 'remove with blob')
  bad(t, 'recovery.sign', { action: 'list', nonce: RNONCE, lookupId: KEY }, 'list with lookupId')
  bad(t, 'recovery.sign', { action: 'list', nonce: RNONCE, kind: 'passkey' }, 'list with kind')
  bad(t, 'recovery.sign', { action: 'list', nonce: RNONCE, blob: RBLOB }, 'list with blob')
  for (const k of ['action', 'nonce', 'kind', 'lookupId']) {
    const p = { ...put }
    delete p[k]
    bad(t, 'recovery.sign', p, 'missing ' + k)
  }
  for (const action of ['get', '', null, 1]) bad(t, 'recovery.sign', { ...put, action }, 'action ' + action)
  for (const kind of ['prf', 'Passkey', null]) bad(t, 'recovery.sign', { ...put, kind }, 'kind ' + kind)
  for (const lookupId of ['AB'.repeat(32), 'ab'.repeat(31), '']) bad(t, 'recovery.sign', { ...put, lookupId }, 'lookupId')
  bad(t, 'recovery.sign', { ...put, nonce: 'short' }, 'nonce')
  for (const k of ['member', 'association', 'blobHash', 'secret']) bad(t, 'recovery.sign', { ...put, [k]: KEY }, 'extra ' + k)
  const blobs = [
    { ...RBLOB, ciphertext: 'cd'.repeat(81) },
    { ...RBLOB, ciphertext: 'cd'.repeat(83) },
    { ...RBLOB, ciphertext: 'CD'.repeat(82) },
    { ...RBLOB, nonce: 'cd'.repeat(23) },
    { ...RBLOB, v: 2 },
    { ...RBLOB, kind: 'x' },
    { ...RBLOB, extra: 1 },
    { v: 1, kind: 'passkey', nonce: 'cd'.repeat(24) },
    null,
    'cd'.repeat(82)
  ]
  for (const b of blobs) bad(t, 'recovery.sign', { ...put, blob: b }, 'bad blob ' + JSON.stringify(b))
})

test('identity.recoveryLookup', (t) => {
  t.absent(isMutating('identity.recoveryLookup'))
  const pk = { kind: 'passkey', secret: 'cd'.repeat(32) }
  const code = { kind: 'code', code: 'ABCD-EFGH' }
  ok(t, 'identity.recoveryLookup', pk, pk)
  ok(t, 'identity.recoveryLookup', code, code)
  ok(t, 'identity.recoveryLookup', { kind: 'code', code: 'x'.repeat(64) })
  bad(t, 'identity.recoveryLookup', { ...pk, code: 'ABCD' }, 'passkey with both secret and code')
  bad(t, 'identity.recoveryLookup', { ...code, secret: 'cd'.repeat(32) }, 'code with both secret and code')
  bad(t, 'identity.recoveryLookup', { kind: 'passkey' }, 'passkey with neither')
  bad(t, 'identity.recoveryLookup', { kind: 'code' }, 'code with neither')
  bad(t, 'identity.recoveryLookup', { kind: 'passkey', code: 'ABCD' }, 'passkey with code only')
  bad(t, 'identity.recoveryLookup', { kind: 'code', secret: 'cd'.repeat(32) }, 'code with secret only')
  for (const c of ['', 'x'.repeat(65), 1, null]) bad(t, 'identity.recoveryLookup', { kind: 'code', code: c }, 'bad code')
  for (const s of ['CD'.repeat(32), 'cd'.repeat(31), '', null]) bad(t, 'identity.recoveryLookup', { kind: 'passkey', secret: s }, 'bad secret')
  bad(t, 'identity.recoveryLookup', { ...pk, member: KEY }, 'extra key')
  bad(t, 'identity.recoveryLookup', { secret: 'cd'.repeat(32) }, 'missing kind')
})

test('identity.recoveryOpen', (t) => {
  t.absent(isMutating('identity.recoveryOpen'))
  const base = { blob: RBLOB, member: KEY }
  ok(t, 'identity.recoveryOpen', base, base)
  ok(t, 'identity.recoveryOpen', { ...base, blob: { ...RBLOB, kind: 'code' } })
  bad(t, 'identity.recoveryOpen', { ...base, blob: { ...RBLOB, ciphertext: 'cd'.repeat(80) } }, 'ciphertext of the wrong length')
  bad(t, 'identity.recoveryOpen', { blob: RBLOB }, 'missing member')
  bad(t, 'identity.recoveryOpen', { member: KEY }, 'missing blob')
  bad(t, 'identity.recoveryOpen', { ...base, member: 'ab'.repeat(31) }, 'bad member')
  bad(t, 'identity.recoveryOpen', { ...base, secret: 'cd'.repeat(32) }, 'extra key')
})

test('identity.recoveryWrap', (t) => {
  t.absent(isMutating('identity.recoveryWrap'))
  const pk = { kind: 'passkey', secret: 'cd'.repeat(32) }
  ok(t, 'identity.recoveryWrap', pk, pk)
  ok(t, 'identity.recoveryWrap', { kind: 'code' }, { kind: 'code' })
  bad(t, 'identity.recoveryWrap', { kind: 'passkey' }, 'passkey without secret')
  bad(t, 'identity.recoveryWrap', { kind: 'code', secret: 'cd'.repeat(32) }, 'code with secret')
  bad(t, 'identity.recoveryWrap', { kind: 'code', code: 'ABCD' }, 'code is never an input')
  bad(t, 'identity.recoveryWrap', { ...pk, secret: 'cd'.repeat(31) }, 'bad secret')
  bad(t, 'identity.recoveryWrap', {}, 'missing kind')
})

test('identity.recoveryBind', (t) => {
  t.ok(isMutating('identity.recoveryBind'), 'rewrites the kv passkey record')
  const base = { credentialId: 'AbC-_9', userId: KEY }
  ok(t, 'identity.recoveryBind', base, base)
  bad(t, 'identity.recoveryBind', { ...base, userId: '' }, 'empty userId')
  bad(t, 'identity.recoveryBind', { ...base, userId: 'AB'.repeat(32) }, 'uppercase userId')
  bad(t, 'identity.recoveryBind', { ...base, userId: 'ab'.repeat(31) }, 'short userId')
  bad(t, 'identity.recoveryBind', { credentialId: 'AbC-_9' }, 'missing userId')
  bad(t, 'identity.recoveryBind', { userId: KEY }, 'missing credentialId')
  bad(t, 'identity.recoveryBind', { ...base, credentialId: 'a b' }, 'bad credentialId')
  bad(t, 'identity.recoveryBind', { ...base, prf: 'cd'.repeat(32) }, 'extra key')
})

test('media.uploadFile with sealed', (t) => {
  const params = { name: 'a'.repeat(32) + '.bin', mime: 'image/jpeg', width: 1, height: 1, sealed: true }
  ok(t, 'media.uploadFile', params, params)
  ok(t, 'media.uploadFile', { ...params, sealed: false })
  for (const mime of ['image/png', 'image/webp', 'image/gif']) ok(t, 'media.uploadFile', { ...params, mime })
  for (const sealed of [null, 0, 1, 'true']) bad(t, 'media.uploadFile', { ...params, sealed }, 'sealed must be boolean')
  bad(t, 'media.uploadFile', { ...params, mime: 'application/octet-stream' }, 'the node seals: the file is always the image')
  bad(t, 'dm.putMedia', params, 'group sealing does not use the DM blob channel')
})

test('media.readFile', (t) => {
  t.absent(isMutating('media.readFile'), 'writes only a local temp file')
  const ID = 'cd'.repeat(16)
  const dm = { kind: 'dm', from: KEY, id: ID, index: 0 }
  ok(t, 'media.readFile', dm, dm)
  ok(t, 'media.readFile', { ...dm, index: 3 })
  for (const index of [-1, 4, 1.5, '0', null]) bad(t, 'media.readFile', { ...dm, index }, 'bad index')
  for (const from of ['AB'.repeat(32), 'ab'.repeat(31), '', null]) bad(t, 'media.readFile', { ...dm, from }, 'bad from')
  for (const id of ['CD'.repeat(16), 'cd'.repeat(15), 'cd'.repeat(32), 1]) bad(t, 'media.readFile', { ...dm, id }, 'bad id')
  for (const k of ['from', 'id', 'index']) {
    const p = { ...dm }
    delete p[k]
    t.is(validateParams('media.readFile', p).message, 'parâmetro obrigatório: ' + k)
  }
  const item = { core: KEY, mime: 'application/octet-stream', start: 1, blocks: 1, bytes: 32768, sha256: 'cd'.repeat(32), key: 'ef'.repeat(32), nonce: 'ab'.repeat(24), plainMime: 'image/jpeg', plainSha256: KEY, w: 10, h: 10, ms: 0 }
  const group = { kind: 'group', diary: KEY, item }
  ok(t, 'media.readFile', group, group)
  for (const k of ['diary', 'item']) {
    const p = { ...group }
    delete p[k]
    t.is(validateParams('media.readFile', p).message, 'parâmetro obrigatório: ' + k)
  }
  bad(t, 'media.readFile', { ...group, item: { ...item, mime: 'image/jpeg' } }, 'a public item is not opened by the node')
  bad(t, 'media.readFile', { ...group, item: { ...item, extra: 1 } }, 'extra item key')
  bad(t, 'media.readFile', { ...group, diary: 'x' }, 'bad diary')
  bad(t, 'media.readFile', { ...dm, diary: KEY }, 'dm with a group field')
  bad(t, 'media.readFile', { ...group, index: 0 }, 'group with a dm field')
  for (const kind of ['', 'DM', 'blob', null, undefined]) bad(t, 'media.readFile', { ...dm, kind }, 'bad kind')
  const { kind, ...noKind } = dm
  bad(t, 'media.readFile', noKind, 'missing kind')
  for (const k of ['name', 'path', 'bytes']) bad(t, 'media.readFile', { ...dm, [k]: 'a' }, 'extra ' + k)
})

test('media uploads require the explicit voice shape for audio', (t) => {
  const voice = { name: 'ab'.repeat(16) + '.bin', mime: 'audio/mp4', width: 0, height: 0, ms: 120000, kind: 'voice' }
  for (const method of ['media.uploadFile', 'dm.putMedia']) {
    ok(t, method, voice, voice)
    ok(t, method, { ...voice, ms: 1 })
    for (const field of Object.keys(voice)) {
      const missing = { ...voice }
      delete missing[field]
      bad(t, method, missing, 'voice without ' + field)
    }
    for (const patch of [
      { mime: 'image/jpeg' }, { mime: 'audio/ogg' }, { width: 1 }, { height: 1 },
      { width: '0' }, { height: -1 }, { ms: 0 }, { ms: 120001 }, { ms: 1.5 },
      { ms: '1' }, { ms: null }, { kind: 'audio' }, { kind: null }, { bytes: 1 }
    ]) bad(t, method, { ...voice, ...patch }, 'invalid upload voice: ' + JSON.stringify(patch))
    const image = { name: voice.name, mime: 'image/png', width: 1, height: 1 }
    ok(t, method, image, image)
    bad(t, method, { ...image, kind: 'voice' })
    bad(t, method, { ...image, kind: 'voice', ms: 1 })
    bad(t, method, { ...image, ms: 0 }, 'duration only belongs to voice uploads')
    bad(t, method, { ...image, width: 0, height: 0 })
  }
  for (const sealed of [false, true]) {
    ok(t, 'media.uploadFile', { ...voice, sealed })
    bad(t, 'dm.putMedia', { ...voice, sealed })
  }
})

test('media.uploadFile', (t) => {
  const base = { name: '0123456789abcdef0123456789abcdef.bin', mime: 'image/jpeg', width: 1, height: 16384 }
  ok(t, 'media.uploadFile', base, base)
  for (const mime of ['image/png', 'image/webp', 'image/gif']) ok(t, 'media.uploadFile', { ...base, mime })
  ok(t, 'media.uploadFile', { ...base, name: 'f'.repeat(32) + '.bin' })
  for (const k of Object.keys(base)) {
    const p = { ...base }
    delete p[k]
    bad(t, 'media.uploadFile', p, 'missing ' + k)
  }
  const hex = '0123456789abcdef0123456789abcdef'
  const names = [
    '', 1, null, '.bin', hex, hex + '.jpg', hex + '.BIN', hex.toUpperCase() + '.bin',
    hex.slice(1) + '.bin', hex + '0.bin', '../' + hex.slice(3) + '.bin', '/' + hex.slice(1) + '.bin',
    hex.slice(0, 16) + '/' + hex.slice(17) + '.bin', '..', hex + '.bin\n', hex + '.bin/', 'g' + hex.slice(1) + '.bin'
  ]
  for (const name of names) bad(t, 'media.uploadFile', { ...base, name }, 'bad name')
  bad(t, 'media.uploadFile', { ...base, path: '/cache/' + base.name }, 'a path is refused')
  const { name, ...rest } = base
  bad(t, 'media.uploadFile', { ...rest, path: '/cache/' + name }, 'a path instead of a name is refused')
  for (const mime of ['image/svg+xml', 'IMAGE/JPEG', 'video/mp4', '', 1]) bad(t, 'media.uploadFile', { ...base, mime }, 'bad mime')
  for (const v of [0, 16385, 1.5, -1, '10', null]) {
    bad(t, 'media.uploadFile', { ...base, width: v }, 'bad width')
    bad(t, 'media.uploadFile', { ...base, height: v }, 'bad height')
  }
  bad(t, 'media.uploadFile', { ...base, bytes: 'x' })
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

test('dm.* (Conversas)', (t) => {
  const ID = 'cd'.repeat(16)
  const nonce = 'n'.repeat(43)
  for (const m of ['dm.enable', 'dm.pull']) {
    ok(t, m, {}, {})
    bad(t, m, { peer: KEY })
  }
  t.ok(isMutating('dm.enable'))
  t.absent(isMutating('dm.pull'))

  const AT = '2026-11-03T12:00:00.000Z'
  const cur = { at: AT, peer: KEY }
  t.absent(isMutating('dm.list'))
  ok(t, 'dm.list', {}, { folder: 'inbox', limit: 30 })
  ok(t, 'dm.list', { folder: 'request' }, { folder: 'request', limit: 30 })
  ok(t, 'dm.list', { folder: 'inbox', limit: 1 })
  ok(t, 'dm.list', { folder: 'request', limit: 50, before: cur }, { folder: 'request', limit: 50, before: cur })
  for (const folder of ['Inbox', 'requests', 'blocked', '', null, 1]) bad(t, 'dm.list', { folder }, 'folder ' + folder)
  for (const limit of [0, 51, 1.5, '30', null]) bad(t, 'dm.list', { limit }, 'limit ' + limit)
  for (const before of [{ at: AT }, { peer: KEY }, { at: '2026-11-03', peer: KEY }, { at: AT, peer: KEY.toUpperCase() },
    { at: AT, peer: KEY, seq: 1 }, { at: AT, key: KEY }, AT, null, []]) {
    bad(t, 'dm.list', { before }, 'before ' + JSON.stringify(before))
  }
  bad(t, 'dm.list', { peer: KEY })

  t.absent(isMutating('dm.lookup'))
  ok(t, 'dm.lookup', { member: KEY }, { member: KEY })
  bad(t, 'dm.lookup', {})
  bad(t, 'dm.lookup', { member: KEY.toUpperCase() })
  bad(t, 'dm.lookup', { member: KEY, peer: KEY })

  t.ok(isMutating('dm.send'))
  ok(t, 'dm.send', { to: KEY, text: 'oi' }, { to: KEY, text: 'oi' })
  ok(t, 'dm.send', { to: KEY, text: 'x' })
  ok(t, 'dm.send', { to: KEY, text: '😀'.repeat(MAX_TEXT), replyTo: ID }, { to: KEY, text: '😀'.repeat(MAX_TEXT), replyTo: ID })
  t.is(validateParams('dm.send', { to: KEY, text: '' }).message, 'parâmetro inválido: text')
  bad(t, 'dm.send', { to: KEY, text: 'x'.repeat(MAX_TEXT + 1) }, 'text too long')
  bad(t, 'dm.send', { text: 'oi' })
  bad(t, 'dm.send', { to: KEY })
  for (const replyTo of [ID.toUpperCase(), ID.slice(1), ID + '0', KEY, null, 1]) {
    t.is(validateParams('dm.send', { to: KEY, text: 'oi', replyTo }).message, 'parâmetro inválido: replyTo')
  }
  bad(t, 'dm.send', { to: KEY, text: 'oi', media: [] }, 'empty media list')
  bad(t, 'dm.send', { to: KEY, text: 'oi', media: null }, 'null media')

  // media: blob descriptors (core lib/blob.js) plus mime, w, h, ms.
  const item = { id: 'a1'.repeat(32), key: 'b2'.repeat(32), nonce: 'c3'.repeat(24), mime: 'image/jpeg', chunks: 2, bytes: 32768 + 17, sha256: 'd4'.repeat(32), w: 1080, h: 1920, ms: 0 }
  ok(t, 'dm.send', { to: KEY, text: '', media: [item] }, { to: KEY, text: '', media: [item] })
  const four = ['a1', 'a2', 'a3', 'a4'].map((h) => ({ ...item, id: h.repeat(32) }))
  ok(t, 'dm.send', { to: KEY, text: 'legenda', replyTo: ID, media: four })
  t.is(validateParams('dm.send', { to: KEY, text: '', media: [item, item] }).message, 'parâmetro inválido: media', 'repeated blob ids refused')
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) ok(t, 'dm.send', { to: KEY, text: '', media: [{ ...item, mime }] })
  ok(t, 'dm.send', { to: KEY, text: '', media: [{ ...item, chunks: 1, bytes: 17 }] })
  ok(t, 'dm.send', { to: KEY, text: '', media: [{ ...item, chunks: 1, bytes: 32768 }] })
  ok(t, 'dm.send', { to: KEY, text: '', media: [{ ...item, chunks: 257, bytes: 257 * 32768 }] })
  ok(t, 'dm.send', { to: KEY, text: '', media: [{ ...item, w: 16384, h: 1 }] })
  t.is(validateParams('dm.send', { to: KEY, text: '', media: [...four, { ...item, id: 'a5'.repeat(32) }] }).message, 'parâmetro inválido: media')
  bad(t, 'dm.send', { to: KEY, text: 'x'.repeat(MAX_TEXT + 1), media: [item] }, 'text too long with media')
  const badItems = [
    ['chunks 0', { chunks: 0, bytes: 0 }],
    ['chunks 258', { chunks: 258, bytes: 257 * 32768 + 1 }],
    ['bytes over the cap', { chunks: 257, bytes: 257 * 32768 + 1 }],
    ['bytes only the MAC', { chunks: 1, bytes: 16 }],
    ['chunks not ceil(bytes / 32768)', { chunks: 3, bytes: 32768 + 17 }],
    ['chunks below ceil(bytes / 32768)', { chunks: 1, bytes: 32769 }],
    ['fractional bytes', { bytes: 32768.5 }],
    ['string chunks', { chunks: '2' }],
    ['uppercase id', { id: 'A1'.repeat(32) }],
    ['short key', { key: 'b2'.repeat(31) }],
    ['nonce of 46 hex', { nonce: 'c3'.repeat(23) }],
    ['nonce of 64 hex', { nonce: 'c3'.repeat(32) }],
    ['sha256 not hex', { sha256: 'zz'.repeat(32) }],
    ['video mime', { mime: 'video/mp4' }],
    ['svg mime', { mime: 'image/svg+xml' }],
    ['w 0', { w: 0 }],
    ['h 16385', { h: 16385 }],
    ['ms 1', { ms: 1 }],
    ['ms null', { ms: null }]
  ]
  for (const [label, patch] of badItems) {
    t.is(validateParams('dm.send', { to: KEY, text: '', media: [{ ...item, ...patch }] }).message, 'parâmetro inválido: media', label)
  }
  for (const k of Object.keys(item)) {
    const missing = { ...item }
    delete missing[k]
    bad(t, 'dm.send', { to: KEY, text: '', media: [missing] }, 'media item without ' + k)
  }
  // The post descriptor keys and an extra field are not a DM media item.
  for (const k of ['core', 'width', 'height', 'card', 'fwd', 'path']) {
    bad(t, 'dm.send', { to: KEY, text: '', media: [{ ...item, [k]: 1 }] }, 'media item with ' + k)
  }
  bad(t, 'dm.send', { to: KEY, text: '', media: [item, undefined] }, 'undefined item')
  // eslint-disable-next-line no-sparse-arrays
  bad(t, 'dm.send', { to: KEY, text: '', media: [item, , item] }, 'sparse media list')
  bad(t, 'dm.send', { to: KEY, text: '', media: item }, 'media not a list')
  bad(t, 'dm.send', { to: KEY, text: '', media: [Object.assign(Object.create({ x: 1 }), item)] }, 'item with a prototype')

  t.ok(isMutating('dm.putMedia'))
  const put = { name: 'ab'.repeat(16) + '.bin', mime: 'image/png', width: 640, height: 480 }
  ok(t, 'dm.putMedia', put, put)
  for (const k of Object.keys(put)) {
    const p = { ...put }
    delete p[k]
    t.is(validateParams('dm.putMedia', p).message, 'parâmetro obrigatório: ' + k)
  }
  for (const name of ['../x.bin', 'ab'.repeat(16) + '.jpg', 'AB'.repeat(16) + '.bin', '/tmp/' + 'ab'.repeat(16) + '.bin', 'ab'.repeat(16)]) {
    bad(t, 'dm.putMedia', { ...put, name }, 'name ' + name)
  }
  bad(t, 'dm.putMedia', { ...put, mime: 'video/mp4' })
  bad(t, 'dm.putMedia', { ...put, width: 0 })
  bad(t, 'dm.putMedia', { ...put, height: 16385 })
  // No bytes over RPC and no recipient: the descriptor goes in a later dm.send.
  for (const k of ['bytes', 'data', 'path', 'to', 'key']) bad(t, 'dm.putMedia', { ...put, [k]: 'ab' }, 'extra ' + k)

  t.absent(isMutating('dm.thread'))
  t.is(DM_THREAD_LIMIT_MAX, 46)
  ok(t, 'dm.thread', { peer: KEY }, { peer: KEY, limit: 30 })
  ok(t, 'dm.thread', { peer: KEY, before: ID, limit: DM_THREAD_LIMIT_MAX }, { peer: KEY, before: ID, limit: DM_THREAD_LIMIT_MAX })
  ok(t, 'dm.thread', { peer: KEY, limit: 1 })
  bad(t, 'dm.thread', {})
  bad(t, 'dm.thread', { peer: KEY, limit: 0 })
  bad(t, 'dm.thread', { peer: KEY, limit: DM_THREAD_LIMIT_MAX + 1 })
  bad(t, 'dm.thread', { peer: KEY, limit: 50 })
  bad(t, 'dm.thread', { peer: KEY, limit: 100 })
  bad(t, 'dm.thread', { peer: KEY, before: 'x' })
  bad(t, 'dm.thread', { peer: KEY, offset: 0 })

  t.ok(isMutating('dm.set'))
  for (const state of ['accepted', 'declined', 'blocked', 'unblocked', 'deleted']) {
    ok(t, 'dm.set', { peer: KEY, state }, { peer: KEY, state })
  }
  for (const state of ['Accepted', 'accept', 'read', '', null, true]) bad(t, 'dm.set', { peer: KEY, state }, 'state ' + state)
  bad(t, 'dm.set', { state: 'accepted' })
  bad(t, 'dm.set', { peer: KEY })

  t.absent(isMutating('dm.seen'))
  ok(t, 'dm.seen', { peer: KEY }, { peer: KEY })
  bad(t, 'dm.seen', {})
  bad(t, 'dm.seen', { peer: KEY, id: ID }, 'no read receipt by id')

  const base = { nonce, target: KEY, reason: 'assedio', quote: 'mensagem' }
  t.absent(isMutating('dm.reportSign'))
  ok(t, 'dm.reportSign', base, { ...base, text: '' })
  ok(t, 'dm.reportSign', { ...base, text: '😀'.repeat(280), quote: 'x'.repeat(MAX_TEXT) })
  for (const reason of ['spam', 'assedio', 'ilegal', 'outro']) ok(t, 'dm.reportSign', { ...base, reason })
  for (const k of ['nonce', 'target', 'reason', 'quote']) {
    const p = { ...base }
    delete p[k]
    t.is(validateParams('dm.reportSign', p).message, 'parâmetro obrigatório: ' + k)
  }
  bad(t, 'dm.reportSign', { ...base, quote: '' }, 'empty quote')
  // anexo: the hex SHA-256 of an attached image; only with it may the quote
  // be empty (a media-only message).
  const anexo = 'cd'.repeat(32)
  ok(t, 'dm.reportSign', { ...base, anexo }, { ...base, text: '', anexo })
  ok(t, 'dm.reportSign', { ...base, quote: '', anexo }, { ...base, text: '', quote: '', anexo })
  t.is(validateParams('dm.reportSign', { ...base, quote: '' }).message, 'parâmetro inválido: quote')
  for (const a of ['', anexo.toUpperCase(), anexo.slice(1), anexo + '0', 1, null]) bad(t, 'dm.reportSign', { ...base, anexo: a }, 'anexo ' + a)
  for (const k of ['bytes', 'media', 'mime', 'image']) bad(t, 'dm.reportSign', { ...base, anexo, [k]: 'AAAA' }, 'extra ' + k)
  bad(t, 'dm.reportSign', { ...base, quote: 'x'.repeat(MAX_TEXT + 1) }, 'quote too long')
  bad(t, 'dm.reportSign', { ...base, text: '😀'.repeat(281) }, 'text of 281 code points')
  for (const target of [KEY.toUpperCase(), KEY.slice(1), 1, null]) bad(t, 'dm.reportSign', { ...base, target }, 'target ' + target)
  for (const n of ['n'.repeat(42), 'n'.repeat(129), 1]) bad(t, 'dm.reportSign', { ...base, nonce: n }, 'nonce ' + n)
  // The caller never chooses the member, the association, a signature or bytes.
  for (const k of ['member', 'association', 'signature', 'payload', 'seq', 'id', 'key']) {
    bad(t, 'dm.reportSign', { ...base, [k]: 'ab'.repeat(32) }, 'extra ' + k)
  }
})

test('dm.send accepts one voice item within the ciphertext byte cap', (t) => {
  const item = { id: KEY, key: KEY, nonce: 'ab'.repeat(24), chunks: 49, bytes: 1572864 + 16, sha256: KEY, mime: 'audio/mp4', w: 0, h: 0, ms: 120000 }
  const params = { to: KEY, text: '', media: [item] }
  ok(t, 'dm.send', params, params)
  ok(t, 'dm.send', { ...params, text: 'Áudio', replyTo: 'ab'.repeat(16), media: [{ ...item, chunks: 1, bytes: 17, ms: 1 }] })
  for (const patch of [
    { bytes: 1572864 + 17 }, { chunks: 48 }, { chunks: 1, bytes: 16 },
    { chunks: 1, bytes: 17.5 }, { mime: 'audio/ogg' }, { mime: 'image/jpeg' },
    { w: 1 }, { h: 1 }, { w: '0' }, { ms: 0 }, { ms: 120001 }, { ms: 1.5 },
    { ms: '1' }, { ms: null }, { id: 'x' }, { key: 'x' }, { nonce: 'x' },
    { sha256: 'x' }, { kind: 'voice' }
  ]) bad(t, 'dm.send', { ...params, media: [{ ...item, ...patch }] }, 'invalid DM voice: ' + JSON.stringify(patch))
  for (const field of Object.keys(item)) {
    const missing = { ...item }
    delete missing[field]
    bad(t, 'dm.send', { ...params, media: [missing] }, 'DM voice without ' + field)
  }
  const image = { ...item, id: 'cd'.repeat(32), mime: 'image/jpeg', w: 1, h: 1, ms: 0 }
  for (const media of [[item, { ...item, id: image.id }], [item, image], [image, item]]) {
    bad(t, 'dm.send', { ...params, media }, 'DM voice must be alone')
  }
})

test('page.* (Páginas)', (t) => {
  const nonce = 'n'.repeat(43)
  const at = '2026-11-03T12:00:00.000Z'
  const base = { action: 'post', nonce, page: KEY, op: { text: 'olá' } }
  t.absent(isMutating('page.sign'))
  t.absent(isMutating('page.read'))
  t.absent(isMutating('page.feed'))
  t.ok(isMutating('page.register'))

  ok(t, 'page.sign', base, base)
  for (const action of ['list', 'status', 'reply', 'quote', 'delete', 'like', 'repost', 'profile', 'avatar', 'rename', 'invite',
    'dm-list', 'dm-thread', 'dm-send', 'dm-set', 'dm-seen', 'follow', 'follows', 'media', 'notices', 'terms',
    'community-join', 'community-leave', 'group-join', 'group-leave', 'group-post', 'group-read',
    'accept', 'remove', 'offer', 'transfer-accept', 'create', 'close', 'move']) {
    ok(t, 'page.sign', { ...base, action })
  }
  for (const action of ['create', 'list', 'terms']) ok(t, 'page.sign', { ...base, action, page: '' })
  // A core delegate's terms acceptance (5.84): the op the node also signs a
  // terms signature for.
  ok(t, 'page.sign', { action: 'terms', nonce, page: '', op: { version: 13, diary: KEY } })
  bad(t, 'page.sign', { ...base, action: 'offer-cancel', op: {} }, 'the unsigned offer-cancel is gone')
  // An offer names a recipient and an expiry, or neither (the cancel).
  const offerOp = { to: 'cd'.repeat(32), exp: '2026-11-10T12:00:00.000Z', gen: 2, at, nonce }
  ok(t, 'page.sign', { ...base, action: 'offer', op: offerOp })
  ok(t, 'page.sign', { ...base, action: 'offer', op: { ...offerOp, to: null, exp: null } })
  bad(t, 'page.sign', { ...base, action: 'offer', op: { ...offerOp, to: null } }, 'to null with an exp')
  bad(t, 'page.sign', { ...base, action: 'offer', op: { ...offerOp, exp: null } }, 'exp null with a to')
  bad(t, 'page.sign', { ...base, action: 'offer', op: { ...offerOp, to: 'CD'.repeat(32) } }, 'an uppercase to')
  bad(t, 'page.sign', { ...base, action: 'offer', op: { ...offerOp, exp: '2026-11-10' } }, 'a non-canonical exp')
  for (const action of ['post', 'move', 'accept', 'invite']) bad(t, 'page.sign', { ...base, action, page: '' }, 'empty page for ' + action)
  ok(t, 'page.sign', {
    action: 'create',
    nonce,
    page: KEY,
    op: { username: 'padaria', name: 'Padaria', bio: '', roster: { gen: 1, admins: [], prev: null, at, nonce } }
  })
  ok(t, 'page.sign', {
    action: 'move',
    nonce,
    page: KEY,
    op: { to: 'cd'.repeat(32), gen: 3, fromSeq: 40, owner: KEY, admins: ['cd'.repeat(32)], at, nonce }
  })
  const nullProto = Object.create(null)
  nullProto.text = 'x'
  ok(t, 'page.sign', { ...base, op: nullProto })
  ok(t, 'page.sign', { ...base, op: { text: 'x'.repeat(16 * 1024 - 20) } })

  bad(t, 'page.sign', {})
  for (const k of ['action', 'nonce', 'page', 'op']) {
    const p = { ...base }
    delete p[k]
    bad(t, 'page.sign', p, 'missing ' + k)
  }
  // The caller never chooses the member, the actor, the association, a hash,
  // a signature or the bytes.
  for (const k of ['member', 'actor', 'association', 'opHash', 'signature', 'countersignature', 'payload', 'key']) {
    bad(t, 'page.sign', { ...base, [k]: KEY }, 'extra ' + k)
  }
  for (const action of ['POST', 'optin', 'page-roster', 'post ', '', null, 1]) bad(t, 'page.sign', { ...base, action }, 'action ' + action)
  for (const n of ['n'.repeat(42), 'n'.repeat(129), 'n'.repeat(42) + '=', 1]) bad(t, 'page.sign', { ...base, nonce: n }, 'nonce ' + n)
  for (const page of [KEY.toUpperCase(), KEY.slice(1), null, 1]) bad(t, 'page.sign', { ...base, page }, 'page ' + page)
  bad(t, 'page.sign', { ...base, op: { text: 'x'.repeat(16 * 1024) } }, 'op over 16 KiB')
  // Charged as canonicalOp charges an array: exactly 16 KiB passes, one more byte fails.
  const exact = (n) => ({ rows: ['x'.repeat(n)] })
  const fill = 16 * 1024 - JSON.stringify(exact(0)).length
  t.is(JSON.stringify(exact(fill)).length, 16 * 1024)
  t.ok(validateParams('page.sign', { ...base, op: exact(fill) }).ok, 'array op of exactly 16 KiB')
  bad(t, 'page.sign', { ...base, op: exact(fill + 1) }, 'array op over 16 KiB')
  // The node fills association from its own configuration.
  bad(t, 'page.sign', { ...base, action: 'close', op: { gen: 2, at, nonce, association: KEY } }, 'op association')
  bad(t, 'page.sign', { ...base, action: 'create', op: { username: 'padaria', name: 'Padaria', bio: '', roster: { gen: 1, admins: [], prev: null, at, nonce, association: KEY } } }, 'nested op association')
  bad(t, 'page.sign', { ...base, action: 'invite', op: { member: KEY, gen: 2, rosterSignature: '', roster: { owner: KEY, admins: [KEY], prev: 'cd'.repeat(64), at, nonce, association: KEY } } }, 'invite roster association')
  bad(t, 'page.sign', { ...base, op: { rows: new Array(20000).fill(1) } }, 'huge op array')
  for (const k of ['secretKey', 'pin', 'seed']) {
    bad(t, 'page.sign', { ...base, op: { [k]: 'x' } }, 'op key ' + k)
    bad(t, 'page.sign', { ...base, op: { roster: { inner: [{ [k]: 'x' }] } } }, 'nested op key ' + k)
  }
  // JSON.stringify reorders array-index-like keys, so canonicalOp refuses them.
  for (const op of [{ 10: 1, 2: 2 }, { 0: 'x' }, { text: 'x', media: [{ 7: 1 }] }]) {
    bad(t, 'page.sign', { ...base, op }, 'index-like op key ' + JSON.stringify(op))
  }
  t.ok(validateParams('page.sign', { ...base, op: { '01': 1, '-1': 2, 1.5: 3, '2a': 4 } }).ok, 'non-index numeric-looking keys')
  let deep = { x: 1 }
  for (let i = 0; i < 8; i++) deep = { d: deep }
  bad(t, 'page.sign', { ...base, op: deep }, 'op too deep')
  const sparse = [1, 2]
  delete sparse[0]
  for (const op of [null, [], 'x', 1, new Date(), { n: NaN }, { n: Infinity }, { n: -0 }, { s: '\ud800' }, { f: () => 1 }, { u: undefined }, { a: sparse }]) {
    bad(t, 'page.sign', { ...base, op }, 'bad op')
  }
  const sym = { text: 'x' }
  sym[Symbol('s')] = 1
  bad(t, 'page.sign', { ...base, op: sym }, 'symbol key in op')
  const getter = {}
  Object.defineProperty(getter, 'text', { get: () => 'x', enumerable: true })
  bad(t, 'page.sign', { ...base, op: getter }, 'getter in op')

  ok(t, 'page.read', { key: KEY }, { key: KEY, full: false })
  ok(t, 'page.read', { key: KEY, full: true }, { key: KEY, full: true })
  bad(t, 'page.read', {})
  bad(t, 'page.read', { key: KEY.toUpperCase() })
  bad(t, 'page.read', { key: KEY, full: 1 })
  bad(t, 'page.read', { key: KEY, page: KEY }, 'extra page')

  const keys = []
  for (let i = 0; i < 64; i++) keys.push(i.toString(16).padStart(2, '0').repeat(32))
  ok(t, 'page.feed', { page: KEY, keys: [KEY] }, { page: KEY, keys: [KEY], limit: 30 })
  ok(t, 'page.feed', { page: KEY, keys, limit: FEED_LIMIT_MAX })
  ok(t, 'page.feed', { page: KEY, keys, limit: 1 })
  bad(t, 'page.feed', { page: KEY, keys: [...keys, 'ff'.repeat(32)] }, '65th feed key')
  bad(t, 'page.feed', { page: KEY, keys: [] }, 'no keys')
  bad(t, 'page.feed', { page: KEY, keys: [KEY, KEY] }, 'duplicate key')
  bad(t, 'page.feed', { page: KEY, keys: [KEY.toUpperCase()] }, 'uppercase key')
  bad(t, 'page.feed', { page: KEY, keys: [KEY], limit: 0 })
  bad(t, 'page.feed', { page: KEY, keys: [KEY], limit: FEED_LIMIT_MAX + 1 })
  bad(t, 'page.feed', { page: KEY, keys: [KEY], before: { at, author: KEY, seq: 1 } }, 'no cursor')
  bad(t, 'page.feed', { keys: [KEY] }, 'missing page')

  ok(t, 'page.register', {}, {})
  bad(t, 'page.register', { key: KEY }, 'extra key')
})

test('page.read worst-case result fits MAX_MESSAGE', (t) => {
  const { PAGE_READ_FOLLOWS_MAX, PAGE_READ_LINKS_MAX } = require('../lib/methods')
  const { MAX_MESSAGE } = require('..')
  const hex = (i) => (i % 256).toString(16).padStart(2, '0').repeat(32)
  const seq = Number.MAX_SAFE_INTEGER
  const result = {
    page: hex(1),
    owner: hex(2),
    admins: Array.from({ length: 16 }, (_, i) => hex(i + 3)),
    gen: seq,
    seq,
    isOwner: false,
    isAdmin: false,
    complete: false,
    follows: Array.from({ length: PAGE_READ_FOLLOWS_MAX }, (_, i) => ({ key: hex(i), seq })),
    followsCount: seq,
    followsTruncated: true,
    closed: false,
    movedTo: { to: hex(4), seq },
    movedFrom: { from: hex(5), fromSeq: seq },
    links: Array.from({ length: PAGE_READ_LINKS_MAX }, (_, i) => ({ actor: hex(i), diary: hex(i + 1) }))
  }
  const line = JSON.stringify({ v: 1, id: 'x'.repeat(64), ok: true, result })
  t.ok(line.length < MAX_MESSAGE, 'page.read result ' + line.length + ' bytes')
  // The shape this replaced: every follow (4095) as a bare key.
  t.ok(JSON.stringify(new Array(4095).fill(hex(0))).length > MAX_MESSAGE)
})
