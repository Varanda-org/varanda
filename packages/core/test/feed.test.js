'use strict'

const test = require('brittle')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const certModule = require('../lib/cert')
const { createCert, createIssuerCert, createIssuedCert, createUsernameRecord } = certModule
const { buildFeed, shortKey, formatFeedItem, MAX_FUTURE_MS } = require('../lib/feed')
const { testnet } = require('./helpers/net')
const { displayWidth } = require('../lib/safe')

const KA = 'a'.repeat(64)
const KB = 'b'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const HOUR = 3600 * 1000

function cert (member) {
  return { type: 'member-cert', cert: { v: 1, member, ageBand: '18+', method: 'stub', date: AT, association: 'c'.repeat(64), signature: 'd'.repeat(128) } }
}
const post = (text, at, replyTo = null) => ({ type: 'post', text, at, replyTo })
const profile = (name, at = AT) => ({ type: 'profile', name, bio: '', at })
const iso = (ms) => new Date(ms).toISOString()

test('constants and shortKey', async (t) => {
  await testnet(t)
  t.is(MAX_FUTURE_MS, 86400000)
  t.is(shortKey(KA), 'aaaaaaaa')
})

test('merge two logs ordered by at, author, seq', async (t) => {
  await testnet(t)
  const logs = [
    {
      key: KB,
      entries: [
        { seq: 0, record: cert(KB) },
        { seq: 1, record: post('b1', '2026-01-02T00:00:00.000Z') },
        { seq: 2, record: post('b2', '2026-01-03T00:00:00.000Z') }
      ]
    },
    {
      key: KA,
      entries: [
        { seq: 0, record: cert(KA) },
        { seq: 1, record: post('a1', '2026-01-01T00:00:00.000Z') },
        { seq: 2, record: post('a2', '2026-01-02T00:00:00.000Z') },
        { seq: 3, record: post('a3', '2026-01-02T00:00:00.000Z') }
      ]
    }
  ]
  const { items, future } = buildFeed({ logs, now: NOW })
  t.alike(future, [])
  t.alike(items.map((i) => i.text), ['a1', 'a2', 'a3', 'b1', 'b2'])
  // tie on at: author ascending, then seq ascending
  t.alike(items.slice(1, 4).map((i) => [i.author === KA ? 'A' : 'B', i.seq]), [['A', 2], ['A', 3], ['B', 1]])
})

test('limit keeps the last n', async (t) => {
  await testnet(t)
  const entries = [{ seq: 0, record: cert(KA) }]
  for (let i = 1; i <= 5; i++) entries.push({ seq: i, record: post('p' + i, iso(NOW - (10 - i) * HOUR)) })
  const logs = [{ key: KA, entries }]
  t.alike(buildFeed({ logs, limit: 2, now: NOW }).items.map((i) => i.text), ['p4', 'p5'])
  t.is(buildFeed({ logs, limit: 1, now: NOW }).items.length, 1)
  t.is(buildFeed({ logs, limit: 99, now: NOW }).items.length, 5)
  t.is(buildFeed({ logs, now: NOW }).items.length, 5)
})

test('feed usernames follow the newest own record on v1 and v2 diaries', (t) => {
  const associationKey = crypto.keyPair()
  const issuerKey = crypto.keyPair()
  const association = b4a.toString(associationKey.publicKey, 'hex')
  const issuerCert = createIssuerCert({ issuer: b4a.toString(issuerKey.publicKey, 'hex'), date: AT }, associationKey)
  const username = (name, member = KA) => createUsernameRecord({ member, username: name, date: AT }, issuerKey, issuerCert)
  const first = username('ana')
  const renamed = username('ana_maria')

  for (const genesis of [createCert({ member: KA, date: AT }, associationKey), createIssuedCert({ member: KA, date: AT }, issuerKey, issuerCert)]) {
    const entries = [
      { seq: 0, record: { type: 'member-cert', cert: genesis } },
      // a profile name that is itself a valid username is still not one
      { seq: 1, record: profile('bia_souza') },
      { seq: 2, record: post('oi', AT) }
    ]
    const read = (root = association, list = entries) => buildFeed({ logs: [{ key: KA, entries: list }], association: root, now: NOW }).items[0]
    t.is(read().username, null, 'a certificate and profile never supply the username')
    t.is(read().name, 'bia_souza')
    entries.push({ seq: 3, record: first })
    t.is(read().username, 'ana', 'a signed username works with either genesis version')
    entries.push({ seq: 5, record: renamed }, { seq: 4, record: first })
    t.is(read().username, 'ana_maria', 'highest sequence wins even for unordered entries and equal dates')
    t.is(read().name, 'bia_souza', 'display name is independent')
    entries.push({ seq: 6, record: username('outra', KB) })
    t.is(read().username, 'ana_maria', 'foreign records do not hide the name')
    t.is(read('f'.repeat(64)).username, null, 'the configured association is required')
    t.is(read(null).username, null, 'missing trust root gives no username')
    t.is(formatFeedItem(read()), '[' + AT + '] bia_souza (aaaaaaaa @ana_maria) #2\n  oi')
    for (const bad of [
      { ...renamed, username: 'forged' },
      { ...renamed, issuerSignature: '0'.repeat(128) }
    ]) {
      t.is(read(association, entries.concat([{ seq: 7, record: bad }])).username, null, 'an invalid newest own record yields username null')
    }
    // a 6-hex name is not shape-valid, so the record is no candidate at all
    t.is(read(association, entries.concat([{ seq: 7, record: { ...renamed, username: 'abc123' } }])).username, 'ana_maria', 'a malformed record is skipped')
  }

  const invalidLogs = [
    { key: KA, entries: [{ seq: 0, record: first }, { seq: 1, record: post('oi', AT) }] },
    { key: KB, entries: [{ seq: 0, record: cert(KB) }, { seq: 1, record: first }, { seq: 2, record: post('oi', AT) }] }
  ]
  t.alike(buildFeed({ logs: invalidLogs, association, now: NOW }).items.map((item) => item.username), [null, null])
})

test('feed usernames ignore records from a revoked issuer', (t) => {
  const associationKey = crypto.keyPair()
  const issuerKey = crypto.keyPair()
  const otherIssuerKey = crypto.keyPair()
  const association = b4a.toString(associationKey.publicKey, 'hex')
  const issuerHex = b4a.toString(issuerKey.publicKey, 'hex')
  const otherHex = b4a.toString(otherIssuerKey.publicKey, 'hex')
  const issuerCert = createIssuerCert({ issuer: issuerHex, date: AT }, associationKey)
  const otherCert = createIssuerCert({ issuer: otherHex, date: AT }, associationKey)
  const entries = [
    { seq: 0, record: { type: 'member-cert', cert: createCert({ member: KA, date: AT }, associationKey) } },
    { seq: 1, record: createUsernameRecord({ member: KA, username: 'ana', date: AT }, otherIssuerKey, otherCert) },
    { seq: 2, record: createUsernameRecord({ member: KA, username: 'ana_maria', date: AT }, issuerKey, issuerCert) },
    { seq: 3, record: post('oi', AT) }
  ]
  const read = (revokedIssuers) => buildFeed({ logs: [{ key: KA, entries }], association, now: NOW, revokedIssuers }).items[0]
  t.is(read(undefined).username, 'ana_maria', 'no revocation: the newest record')
  t.is(read(null).username, 'ana_maria', 'null means none revoked')
  t.is(read(new Set([otherHex])).username, 'ana_maria', 'revoking another issuer changes nothing')
  t.is(read(new Set([issuerHex])).username, null, 'a newest record from a revoked issuer yields null, with no fallback')
  t.is(read(new Set([issuerHex])).text, 'oi', 'the posts of a v1 diary stay visible')
})

test('junk username records cost one candidate verification per log', (t) => {
  const associationKey = crypto.keyPair()
  const issuerKey = crypto.keyPair()
  const association = b4a.toString(associationKey.publicKey, 'hex')
  const issuerCert = createIssuerCert({ issuer: b4a.toString(issuerKey.publicKey, 'hex'), date: AT }, associationKey)
  const valid = createUsernameRecord({ member: KA, username: 'ana_maria', date: AT }, issuerKey, issuerCert)
  // shape-valid records of the log's own member whose signatures fail
  const junk = (i) => ({ ...valid, username: 'junk' + i })
  const JUNK = 5000

  let calls = 0
  const original = certModule.verifyUsernameRecord
  certModule.verifyUsernameRecord = (...args) => {
    calls++
    return original(...args)
  }
  t.teardown(() => { certModule.verifyUsernameRecord = original })

  const head = [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('oi', AT) }]
  const run = (entries) => {
    calls = 0
    const item = buildFeed({ logs: [{ key: KA, entries }], association, now: NOW }).items[0]
    return { username: item.username, calls }
  }

  const before = head.slice()
  for (let i = 0; i < JUNK; i++) before.push({ seq: 2 + i, record: junk(i) })
  before.push({ seq: 2 + JUNK, record: valid })
  const a = run(before)
  t.is(a.username, 'ana_maria', 'junk before the final valid record: the valid name')
  t.is(a.calls, 1, 'exactly one candidate verification')

  const after = head.concat([{ seq: 2, record: valid }])
  for (let i = 0; i < JUNK; i++) after.push({ seq: 3 + i, record: junk(i) })
  const b = run(after)
  t.is(b.username, null, 'junk after the valid record: an invalid newest record yields null')
  t.is(b.calls, 1, 'exactly one candidate verification')
})

test('limit must be Infinity or an integer >= 1', async (t) => {
  await testnet(t)
  const logs = [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('p', AT) }] }]
  for (const limit of [NaN, -1, 1.9, 0, -Infinity, '2', null]) {
    try {
      buildFeed({ logs, limit, now: NOW })
      t.fail('accepted ' + String(limit))
    } catch (err) {
      t.ok(err instanceof TypeError && err.message === 'limit inválido', 'rejects ' + String(limit))
    }
  }
  t.is(buildFeed({ logs, limit: Infinity, now: NOW }).items.length, 1)
})

test('returned items do not alias the input', async (t) => {
  await testnet(t)
  const replyTo = { author: KB, seq: 1 }
  const logs = [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('r', AT, replyTo) }] }]
  const { items } = buildFeed({ logs, now: NOW })
  t.not(items[0].replyTo, replyTo)
  items[0].replyTo.seq = 99
  items[0].replyTo.author = KA
  t.alike(logs[0].entries[1].record.replyTo, { author: KB, seq: 1 })

  // a post whose text turns invalid after it is copied: the feed shows the
  // value that was validated (all feed readers share one plain snapshot)
  let reads = 0
  const shifty = { type: 'post', get text () { return reads++ < 1 ? 'ok' : '' }, at: AT, replyTo: null }
  const r = buildFeed({ logs: [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: shifty }] }], now: NOW })
  t.is(r.items.length, 1)
  t.is(r.items[0].text, 'ok')
  t.is(reads, 1)
})

test('reply annotation and name resolution', async (t) => {
  await testnet(t)
  const logs = [
    {
      key: KA,
      entries: [
        { seq: 0, record: cert(KA) },
        { seq: 1, record: profile('Ana') },
        { seq: 2, record: post('oi', '2026-01-01T00:00:00.000Z') },
        { seq: 3, record: profile('Ana Maria') }
      ]
    },
    {
      key: KB,
      entries: [
        { seq: 0, record: cert(KB) },
        { seq: 1, record: post('concordo\nmesmo', '2026-01-02T00:00:00.000Z', { author: KA, seq: 2 }) }
      ]
    }
  ]
  const { items } = buildFeed({ logs, now: NOW })
  t.is(items[0].name, 'Ana Maria')
  t.is(items[1].name, null)
  t.alike(items[1].replyTo, { author: KA, seq: 2 })
  t.is(formatFeedItem(items[0]), '[2026-01-01T00:00:00.000Z] Ana Maria (aaaaaaaa) #2\n  oi')
  // Every line of the text is indented (S5): no line can pass for a header.
  t.is(formatFeedItem(items[1]), '[2026-01-02T00:00:00.000Z] anônimo (bbbbbbbb) #1 ↳ aaaaaaaa#2\n  concordo\n  mesmo')
})

test('formatFeedItem indents every line of a multi-line text', async (t) => {
  await testnet(t)
  const forged = 'primeira\n[2026-01-01T00:00:00.000Z] Falsa (cccccccc) #9\n\núltima'
  const out = formatFeedItem({ author: KA, name: 'Ana', seq: 1, at: AT, text: forged, replyTo: null })
  const lines = out.split('\n')
  t.is(lines[0], '[' + AT + '] Ana (aaaaaaaa) #1')
  t.alike(lines.slice(1), ['  primeira', '  [2026-01-01T00:00:00.000Z] Falsa (cccccccc) #9', '  ', '  última'])
  t.ok(lines.slice(1).every((l) => l.startsWith('  ')), 'no text line starts at column 0')
})

test('formatFeedItem escapes usernames and keeps their header within the width', (t) => {
  const item = { author: KA, name: 'Ana', username: 'ana\n\u001b[31m', seq: 1, at: AT, text: 'oi', replyTo: null }
  const out = formatFeedItem(item)
  t.is(out.split('\n').length, 2, 'a username cannot introduce a header line')
  t.absent(out.includes('\u001b'), 'no terminal escape')
  item.username = 'u'.repeat(20)
  item.name = '界'.repeat(80)
  for (const width of [20, 60, 100]) {
    const rows = formatFeedItem(item, { width }).split('\n')
    t.ok(rows.every((row) => displayWidth(row) <= width), 'header fits ' + width)
    t.ok(rows.slice(1).every((row) => row.startsWith('  ')), 'continuations are indented')
    if (width === 100) t.ok(rows[0].endsWith('(aaaaaaaa @' + item.username + ') #1'), 'key and username stay visible')
  }
})

test('formatFeedItem hard-wraps to width and indents every segment (L1)', async (t) => {
  await testnet(t)
  const text = ' '.repeat(70) + '[2026-01-01T00:00:00.000Z] Falsa (cccccccc) #9'
  const out = formatFeedItem({ author: KA, name: 'Ana', seq: 1, at: AT, text, replyTo: null }, { width: 80 })
  const lines = out.split('\n').slice(1)
  t.ok(lines.length >= 2, 'the long line was wrapped')
  t.ok(lines.every((l) => l.startsWith('  ')), 'every segment is indented')
  t.ok(lines.every((l) => Array.from(l).length <= 80), 'no line exceeds the width')
  t.is(lines.map((l) => l.slice(2)).join(''), text, 'nothing is lost')
  t.is(formatFeedItem({ author: KA, name: 'Ana', seq: 1, at: AT, text, replyTo: null }).split('\n')[1], '  ' + text, 'no width, no wrap')
})

test('formatFeedItem measures display columns and wraps the header too (L1)', async (t) => {
  await testnet(t)
  const forged = '[2026-01-01T00:00:00.000Z] Falsa (cccccccc) #9'
  const cases = [
    { name: 'Ana', text: '界'.repeat(49) + forged, width: 100 },
    { name: 'Ana', text: '\u{1B000}'.repeat(49) + forged, width: 100 },
    { name: 'Ana', text: '\u{17000}'.repeat(49) + forged, width: 100 },
    { name: 'N'.repeat(80), text: 'oi', width: 80 },
    { name: 'Ana', text: 'x'.repeat(30) + forged, width: 1 },
    { name: '界'.repeat(40), text: 'oi', width: 80 }
  ]
  for (const c of cases) {
    const out = formatFeedItem({ author: KA, name: c.name, seq: 1, at: AT, text: c.text, replyTo: null }, { width: c.width })
    const rows = out.split('\n')
    const eff = Math.max(20, c.width)
    t.ok(rows.length >= 2, 'header plus text rows (long names are truncated, not wrapped)')
    t.ok(rows.slice(1).every((l) => l.startsWith('  ')), 'every row after the first is indented')
    t.ok(rows.every((l) => displayWidth(l) <= eff), 'no row wider than ' + eff)
    t.ok(rows[0].startsWith('['), 'first row is the header')
  }
})

test('header keeps the authenticated suffix on row 1 and truncates the name (L1)', async (t) => {
  await testnet(t)
  const item = (name) => ({ author: KA, name, seq: 7, at: AT, text: 'oi', replyTo: null })
  const real = ' (aaaaaaaa) #7'
  const fake = 'Alice (abcd1234) #5' + ' '.repeat(60)
  const rows = formatFeedItem(item(fake), { width: 80 }).split('\n')
  t.is(rows.length, 2, 'header is a single row plus the text')
  t.ok(rows[0].endsWith('...' + real), 'name truncated, real key8 and seq on row 1')
  t.ok(displayWidth(rows[0]) <= 80)
  t.ok(rows[0].endsWith(real) && rows[0].includes('...'), 'ASCII ellipsis, real suffix kept')
  t.absent(rows[0].includes('\u2026'), 'no ambiguous-width ellipsis')
  t.is(formatFeedItem(item('Ana'), { width: 80 }).split('\n')[0], '[' + AT + '] Ana' + real, 'short name unchanged')
  const wide = formatFeedItem(item('　'.repeat(40)), { width: 80 }).split('\n')
  t.is(wide.length, 2)
  t.ok(wide[0].endsWith('...' + real) && displayWidth(wide[0]) <= 80, 'wide name truncated by display width')
  const narrow = formatFeedItem(item('Ana'), { width: 20 }).split('\n')
  t.ok(narrow[0].startsWith('['), 'narrow: header without name first')
  t.absent(narrow[0].includes('Ana'))
  t.ok(narrow.includes('  Ana'), 'name on its own indented row')
})

test('name room of 1 and 2 columns uses a short ASCII mark and keeps the real suffix (L1)', async (t) => {
  await testnet(t)
  const head = '[' + AT + '] '
  const tail = ' (' + shortKey(KA) + ') #7'
  const fixed = displayWidth(head) + displayWidth(tail)
  const item = { author: KA, name: 'N'.repeat(60), seq: 7, at: AT, text: 'oi', replyTo: null }
  for (const [room, mark] of [[1, '.'], [2, '..'], [3, '...']]) {
    const width = fixed + room
    const rows = formatFeedItem(item, { width }).split('\n')
    t.is(rows.length, 2, 'room ' + room + ': single header row plus the text')
    t.ok(rows[0].endsWith(tail), 'room ' + room + ': row 1 ends with the real key8 and seq')
    t.is(rows[0], head + mark + tail, 'room ' + room + ': mark is ' + JSON.stringify(mark))
    t.ok(displayWidth(rows[0]) <= width, 'room ' + room + ': row 1 fits width ' + width)
  }
})

test('invalid blocks are skipped', async (t) => {
  await testnet(t)
  const logs = [
    {
      key: KA,
      entries: [
        { seq: 0, record: cert(KA) },
        { seq: 1, record: null },
        { seq: 2, record: post('', AT) },
        { seq: 3, record: post('ok', AT) },
        { seq: 4, record: post('data ruim', '2026-13-01T00:00:00.000Z') },
        { seq: 5, record: { type: 'post', text: 'sem replyTo', at: AT } },
        { seq: 6, record: cert(KA) }
      ]
    },
    { key: KB, entries: [{ seq: 0, record: post('sem gênese', AT) }, { seq: 1, record: post('depois', AT) }] }
  ]
  const { items } = buildFeed({ logs, now: NOW })
  t.alike(items.map((i) => i.text), ['ok', 'depois'])
})

test('future-dated posts are excluded and reported', async (t) => {
  await testnet(t)
  const logs = [
    {
      key: KB,
      entries: [
        { seq: 0, record: cert(KB) },
        { seq: 1, record: post('b futuro', iso(NOW + 25 * HOUR)) }
      ]
    },
    {
      key: KA,
      entries: [
        { seq: 0, record: cert(KA) },
        { seq: 1, record: post('a ok', iso(NOW + 23 * HOUR)) },
        { seq: 2, record: post('a futuro 2', iso(NOW + 30 * HOUR)) },
        { seq: 3, record: post('a futuro 1', iso(NOW + 26 * HOUR)) },
        { seq: 4, record: post('a passado', iso(NOW - HOUR)) }
      ]
    }
  ]
  const { items, future } = buildFeed({ logs, now: NOW })
  t.alike(items.map((i) => i.text), ['a passado', 'a ok'])
  t.alike(future, [KA + ':2', KA + ':3', KB + ':1'])

  // exactly at the margin is kept
  const edge = buildFeed({ logs: [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('edge', iso(NOW + MAX_FUTURE_MS)) }] }], now: NOW })
  t.is(edge.items.length, 1)
  t.alike(edge.future, [])

  // limit applies after the exclusion
  const limited = buildFeed({ logs, limit: 1, now: NOW })
  t.alike(limited.items.map((i) => i.text), ['a ok'])
  t.is(limited.future.length, 3)

  // default now is the real clock
  const real = buildFeed({ logs: [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('antigo', AT) }] }] })
  t.is(real.items.length, 1)
})

test('buildFeed does not mutate its input', async (t) => {
  await testnet(t)
  const logs = [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('b', '2026-01-02T00:00:00.000Z') }, { seq: 2, record: post('a', AT) }] }]
  const before = JSON.stringify(logs)
  buildFeed({ logs, now: NOW })
  t.is(JSON.stringify(logs), before)
})

test('negative-year posts sort by time, not by string', async (t) => {
  await testnet(t)
  // String order puts -000001 before -000002; time order is the reverse.
  const older = '-000002-01-01T00:00:00.000Z'
  const newer = '-000001-01-01T00:00:00.000Z'
  const logs = [{
    key: KA,
    entries: [
      { seq: 0, record: cert(KA) },
      { seq: 1, record: post('newer', newer) },
      { seq: 2, record: post('older', older) }
    ]
  }]
  const { items } = buildFeed({ logs, now: NOW })
  t.alike(items.map((i) => i.text), ['older', 'newer'])
})

// Ten posts across two diaries, several sharing one timestamp, so the
// cursor order needs author then seq to split them.
function pagingLogs () {
  const t1 = '2026-01-01T00:00:00.000Z'
  const t2 = '2026-01-02T00:00:00.000Z'
  const t3 = '2026-01-03T00:00:00.000Z'
  return [
    { key: KB, entries: [{ seq: 0, record: cert(KB) }, { seq: 1, record: post('b1', t1) }, { seq: 2, record: post('b2', t2) }, { seq: 3, record: post('b3', t2) }, { seq: 4, record: post('b4', t3) }] },
    { key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('a1', t1) }, { seq: 2, record: post('a2', t1) }, { seq: 3, record: post('a3', t2) }, { seq: 4, record: post('a4', t3) }, { seq: 5, record: post('a5', t3) }, { seq: 6, record: post('a6', t3) }] }
  ]
}

test('before pages backwards over every item exactly once', async (t) => {
  await testnet(t)
  const logs = pagingLogs()
  const all = buildFeed({ logs, now: NOW }).items.map((i) => i.text)
  t.alike(all, ['a1', 'a2', 'b1', 'a3', 'b2', 'b3', 'a4', 'a5', 'a6', 'b4'])
  const seen = []
  let before = null
  let pages = 0
  for (;;) {
    const { items } = buildFeed({ logs, limit: 3, now: NOW, before })
    pages++
    seen.unshift(...items.map((i) => i.text))
    if (items.length < 3) break
    before = { at: items[0].at, author: items[0].author, seq: items[0].seq }
  }
  t.alike(seen, all)
  t.is(pages, 4)
})

test('before splits equal timestamps by author then seq', async (t) => {
  await testnet(t)
  const logs = pagingLogs()
  const at = '2026-01-02T00:00:00.000Z'
  t.alike(buildFeed({ logs, now: NOW, before: { at, author: KB, seq: 3 } }).items.map((i) => i.text), ['a1', 'a2', 'b1', 'a3', 'b2'])
  t.alike(buildFeed({ logs, now: NOW, before: { at, author: KB, seq: 2 } }).items.map((i) => i.text), ['a1', 'a2', 'b1', 'a3'])
  t.alike(buildFeed({ logs, limit: 2, now: NOW, before: { at, author: KA, seq: 3 } }).items.map((i) => i.text), ['a2', 'b1'])
})

test('a cursor newer than everything returns the newest page', async (t) => {
  await testnet(t)
  const logs = pagingLogs()
  const before = { at: '2027-01-01T00:00:00.000Z', author: KA, seq: 1 }
  t.alike(
    buildFeed({ logs, limit: 3, now: NOW, before }).items,
    buildFeed({ logs, limit: 3, now: NOW }).items
  )
  const snapshot = JSON.stringify(before)
  buildFeed({ logs, limit: 3, now: NOW, before })
  t.is(JSON.stringify(before), snapshot, 'the cursor is not mutated')
})

test('an invalid before throws', async (t) => {
  await testnet(t)
  const logs = pagingLogs()
  const bad = ['x', 1, true, [], {}, { at: 'nope', author: KA, seq: 1 }, { at: AT, author: 1, seq: 1 }, { at: AT, author: KA, seq: 1.5 }, { at: AT, author: KA }]
  for (const before of bad) {
    try {
      buildFeed({ logs, now: NOW, before })
      t.fail('accepted ' + JSON.stringify(before))
    } catch (err) {
      t.ok(err instanceof TypeError && err.message === 'before inválido', 'rejects ' + JSON.stringify(before))
    }
  }
})

test('media passes through as a copy; absent media is null', async (t) => {
  await testnet(t)
  const d = { core: KB, mime: 'image/png', start: 1, blocks: 1, bytes: 100, sha256: 'e'.repeat(64), width: 10, height: 20 }
  const photo = { type: 'post', text: '', at: '2026-01-02T00:00:00.000Z', replyTo: null, media: [d] }
  const logs = [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('só texto', AT) }, { seq: 2, record: photo }] }]
  const { items } = buildFeed({ logs, now: NOW })
  t.is(items.length, 2)
  t.is(items[0].media, null)
  t.alike(items[1].media, [d])
  t.is(items[1].text, '')
  t.ok(items[1].media[0] !== d, 'a copy, not the log entry')
  // An invalid media list drops the post, as any invalid record.
  const broken = [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: { ...photo, media: [] } }] }]
  t.alike(buildFeed({ logs: broken, now: NOW }).items, [])
})

const repost = (author, seq, on, at) => ({ type: 'repost', to: { author, seq }, on, at })
const like = (author, seq, on, at) => ({ type: 'like', to: { author, seq }, on, at })
const T1 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-02T00:00:00.000Z'
const T3 = '2026-01-03T00:00:00.000Z'

test('every item has a kind; post items carry quote', async (t) => {
  await testnet(t)
  const q = { type: 'post', text: 'olha', at: T2, replyTo: null, quote: { author: KB, seq: 1 } }
  const logs = [
    { key: KB, entries: [{ seq: 0, record: cert(KB) }, { seq: 1, record: post('b1', T1) }] },
    { key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: profile('Ana') }, { seq: 2, record: q }, { seq: 3, record: post('re', T3, { author: KB, seq: 1 }) }] }
  ]
  const { items } = buildFeed({ logs, now: NOW })
  t.alike(items.map((i) => i.kind), ['post', 'post', 'post'])
  t.alike(items[0], { kind: 'post', author: KB, name: null, username: null, seq: 1, at: T1, text: 'b1', replyTo: null, quote: null, media: null })
  t.alike(items[1], { kind: 'post', author: KA, name: 'Ana', username: null, seq: 2, at: T2, text: 'olha', replyTo: null, quote: { author: KB, seq: 1 }, media: null })
  t.ok(items[1].quote !== q.quote, 'quote is a copy')
  t.alike(items[2].replyTo, { author: KB, seq: 1 })
  t.is(items[2].quote, null)
  for (const it of items) t.ok(it.replyTo === null || it.quote === null, 'never both replyTo and quote')
  // A quote with a replyTo is invalid and dropped.
  const bad = [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: { ...q, replyTo: { author: KB, seq: 1 } } }] }]
  t.alike(buildFeed({ logs: bad, now: NOW }).items, [])
})

test('repost items appear and disappear with on/off', async (t) => {
  await testnet(t)
  const base = [{ seq: 0, record: cert(KA) }, { seq: 1, record: profile('Ana') }]
  const feed = (entries) => buildFeed({ logs: [{ key: KA, entries: base.concat(entries) }], now: NOW }).items
  t.alike(feed([{ seq: 2, record: repost(KB, 4, true, T2) }]), [
    { kind: 'repost', author: KA, name: 'Ana', username: null, seq: 2, at: T2, to: { author: KB, seq: 4 }, text: null, replyTo: null, quote: null, media: null }
  ])
  t.alike(feed([{ seq: 2, record: repost(KB, 4, true, T2) }, { seq: 3, record: repost(KB, 4, false, T3) }]), [], 'off removes it')
  const again = feed([{ seq: 2, record: repost(KB, 4, true, T1) }, { seq: 3, record: repost(KB, 4, false, T2) }, { seq: 4, record: repost(KB, 4, true, T3) }])
  t.is(again.length, 1)
  t.is(again[0].seq, 4, 'seq of the latest on record')
  t.is(again[0].at, T3, 'at of the latest on record')
  t.is(feed([{ seq: 2, record: repost(KB, 4, true, T1) }, { seq: 3, record: repost(KB, 4, true, T2) }]).length, 1, 'one item per target')
  t.alike(feed([{ seq: 2, record: repost(KB, 4, false, T2) }]), [], 'off alone is nothing')
  // Likes never become feed items; self-reposts do.
  t.alike(feed([{ seq: 2, record: like(KB, 4, true, T2) }]), [])
  const self = feed([{ seq: 2, record: post('meu', T1) }, { seq: 3, record: repost(KA, 2, true, T2) }])
  t.alike(self.map((i) => [i.kind, i.seq]), [['post', 2], ['repost', 3]])
  // Invalid repost records are ignored.
  t.alike(feed([{ seq: 2, record: { ...repost(KB, 4, true, T2), extra: 1 } }, { seq: 3, record: repost(KB, 0, true, T2) }]), [])
})

test('repost items share ordering, before, limit and the future rule', async (t) => {
  await testnet(t)
  const logs = [
    { key: KB, entries: [{ seq: 0, record: cert(KB) }, { seq: 1, record: post('b1', T1) }, { seq: 2, record: post('b2', T3) }] },
    { key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('a1', T2) }, { seq: 2, record: repost(KB, 1, true, T2) }, { seq: 3, record: repost(KB, 2, true, iso(NOW + 25 * HOUR)) }] }
  ]
  const label = (i) => i.kind === 'repost' ? 'r' + i.seq : i.text
  const all = buildFeed({ logs, now: NOW })
  t.alike(all.items.map(label), ['b1', 'a1', 'r2', 'b2'])
  t.alike(all.future, [KA + ':3'], 'a future repost is reported, not shown')
  t.alike(buildFeed({ logs, now: NOW, limit: 2 }).items.map(label), ['r2', 'b2'])
  t.alike(buildFeed({ logs, now: NOW, before: { at: T2, author: KA, seq: 2 } }).items.map(label), ['b1', 'a1'])
  t.alike(buildFeed({ logs, now: NOW, before: { at: T3, author: KB, seq: 2 }, limit: 1 }).items.map(label), ['r2'])
})

test('formatFeedItem: repost one-liner and quote marker', async (t) => {
  await testnet(t)
  const r = { kind: 'repost', author: KA, name: 'Ana\u001b[2J', username: null, seq: 5, at: T2, to: { author: KB, seq: 4 }, text: null, replyTo: null, quote: null, media: null }
  t.is(formatFeedItem(r), '[' + T2 + '] Ana\\u{1b}[2J (aaaaaaaa) #5 republicou bbbbbbbb#4')
  t.is(formatFeedItem(r, { width: 80 }).split('\n').length, 1)
  const q = { kind: 'post', author: KA, name: 'Ana', username: null, seq: 6, at: T2, text: 'olha', replyTo: null, quote: { author: KB, seq: 4 }, media: null }
  t.is(formatFeedItem(q), '[' + T2 + '] Ana (aaaaaaaa) #6 cita bbbbbbbb#4\n  olha')
})
