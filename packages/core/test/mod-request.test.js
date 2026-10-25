'use strict'

// lib/mod-request.js: the exact bytes (golden vectors for pull and ack), that
// every field and the exact body bytes are bound by the signature, the
// canonical ack body, domain separation from the report payload, shape
// checks, and that the module stays pure (no fs, no network, no cert.js).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  PREFIX,
  OPS,
  SNAPSHOT_KEYS,
  NONCE_RE,
  MAX_CHANGE_IDS,
  isOrigin,
  canonicalSnapshot,
  canonicalBody,
  modRequestPayload,
  signModRequest,
  verifyModRequest
} = require('../lib/mod-request')
const blocklist = require('../lib/blocklist')

const coreRoot = path.join(__dirname, '..')

// Fixed keys: the moderator pair from a seed of 32 bytes 0x02.
const MOD_KP = crypto.keyPair(b4a.alloc(32, 2))
const MODERATOR = b4a.toString(MOD_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const NONCE = 'B'.repeat(43)
const ORIGIN = 'https://varanda.example.org'

// Shape only: canonicalSnapshot does not verify signatures.
const SNAPSHOT = {
  v: 1,
  seq: 7,
  date: 1760000000000,
  blocked: ['aa'.repeat(32), 'bb'.repeat(32)],
  revokedIssuers: [],
  moderator: MODERATOR,
  moderatorDate: 1750000000000,
  moderatorSignature: 'ee'.repeat(64),
  signature: 'ff'.repeat(64)
}
const CHANGE_IDS = ['c2', 'a1', 'b_3-x']

function pullFields (extra = {}) {
  return { origin: ORIGIN, association: ASSOCIATION, moderator: MODERATOR, nonce: NONCE, op: 'pull', body: canonicalBody('pull'), ...extra }
}

function ackFields (extra = {}) {
  return { origin: ORIGIN, association: ASSOCIATION, moderator: MODERATOR, nonce: NONCE, op: 'ack', body: canonicalBody('ack', { changeIds: CHANGE_IDS, snapshot: SNAPSHOT }), ...extra }
}

test('constants', (t) => {
  t.is(PREFIX, 'varanda-mod-request-v1')
  t.alike([...OPS], ['pull', 'ack'])
  t.ok(Object.isFrozen(OPS))
  t.alike([...SNAPSHOT_KEYS], blocklist.SNAPSHOT_KEYS, 'same keys and order as blocklist.js')
  t.is(MAX_CHANGE_IDS, 4096)
  t.ok(NONCE_RE.test('A-_9'.repeat(32)))
  t.absent(NONCE_RE.test('a'.repeat(42)))
  t.absent(NONCE_RE.test('a'.repeat(129)))
  for (const o of ['https://varanda.example.org', 'https://a.b:8443', 'http://127.0.0.1', 'http://127.0.0.1:45123']) {
    t.ok(isOrigin(o), 'origin ok: ' + o)
  }
  for (const o of ['http://varanda.example.org', 'https://Varanda.org', 'https://a.b/', 'https://a.b/account', 'http://localhost:80', 'http://127.0.0.2', 'https://a.b:123456', 'https://user@a.b', '', null]) {
    t.absent(isOrigin(o), 'origin refused: ' + o)
  }
})

test('golden vector: pull', (t) => {
  t.is(MODERATOR, '8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394')
  const body = canonicalBody('pull')
  t.is(b4a.toString(body, 'utf8'), '{}')
  t.is(body.byteLength, 2)
  t.alike(canonicalBody('pull', { ignored: true }), body, 'pull ignores data')
  const payload = modRequestPayload(pullFields())
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-mod-request-v1',
    ORIGIN,
    ASSOCIATION,
    MODERATOR,
    NONCE,
    'pull',
    'c09da522dac261c3d2566230bed10d2f3ef13f8e7654576c12e857e07f786098'
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
  const signature = signModRequest(pullFields(), MOD_KP)
  t.is(signature, '7d82f4aea61b02cb9911f58b2ed5202965bb694cb303996f11b636e477d6805eefd07c1d1d1714e754bc45c8d4642242aaf72b1ada7e0cb25bf28877eca73f0e')
  t.alike(verifyModRequest(pullFields(), signature), { ok: true })
})

test('golden vector: ack body', (t) => {
  const body = canonicalBody('ack', { changeIds: CHANGE_IDS, snapshot: SNAPSHOT })
  t.is(b4a.toString(body, 'utf8'), '{"changeIds":["a1","b_3-x","c2"],"snapshot":{"v":1,"seq":7,"date":1760000000000,"blocked":["' + 'aa'.repeat(32) + '","' + 'bb'.repeat(32) + '"],"revokedIssuers":[],"moderator":"' + MODERATOR + '","moderatorDate":1750000000000,"moderatorSignature":"' + 'ee'.repeat(64) + '","signature":"' + 'ff'.repeat(64) + '"}}')
  t.is(b4a.toString(crypto.hash(body), 'hex'), '109d72a96451531fccdad63fe3fef1ad264387df4edc7640685ab7cc1dba964a')
  const signature = signModRequest(ackFields(), MOD_KP)
  t.is(signature, '0b4b1e642fbf35e440b980d11cfbba0dddb3e72f08126d4e416d6bf6dcf28f4e14056f0caabc122c706983fe86de852843ba2f086db854cbedb3e1542b672d00')
  t.alike(verifyModRequest(ackFields(), signature), { ok: true })
  t.alike(CHANGE_IDS, ['c2', 'a1', 'b_3-x'], 'the caller\'s list is not sorted in place')
})

test('the ack body is canonical: order of changeIds does not matter, content does', (t) => {
  const base = canonicalBody('ack', { changeIds: CHANGE_IDS, snapshot: SNAPSHOT })
  t.alike(canonicalBody('ack', { changeIds: ['b_3-x', 'c2', 'a1'], snapshot: SNAPSHOT }), base, 'reordered changeIds: same bytes')
  t.alike(canonicalBody('ack', { snapshot: SNAPSHOT, changeIds: CHANGE_IDS }), base, 'data key order does not matter')
  t.unlike(canonicalBody('ack', { changeIds: ['c2', 'a1', 'b_3-y'], snapshot: SNAPSHOT }), base, 'changed changeId: other bytes')
  t.unlike(canonicalBody('ack', { changeIds: ['c2', 'a1'], snapshot: SNAPSHOT }), base, 'dropped changeId: other bytes')

  // Snapshot keys given in another order are rebuilt in the canonical order.
  const shuffled = {}
  for (const k of [...SNAPSHOT_KEYS].reverse()) shuffled[k] = SNAPSHOT[k]
  t.alike(canonicalBody('ack', { changeIds: CHANGE_IDS, snapshot: shuffled }), base, 'snapshot key order is canonical')
  t.alike(Object.keys(canonicalSnapshot(shuffled)), [...SNAPSHOT_KEYS])

  const signature = signModRequest(ackFields(), MOD_KP)
  const changed = canonicalBody('ack', { changeIds: ['c2', 'a1', 'b_3-y'], snapshot: SNAPSHOT })
  t.alike(verifyModRequest(ackFields({ body: changed }), signature), { ok: false, reason: 'bad-signature' })
  const reordered = canonicalBody('ack', { changeIds: ['a1', 'c2', 'b_3-x'], snapshot: SNAPSHOT })
  t.alike(verifyModRequest(ackFields({ body: reordered }), signature), { ok: true }, 'reordered list: same hash')

  // Whitespace never survives rebuilding: the pretty-printed bytes (what
  // store.js writeJsonAtomic writes) hash differently from the canonical body.
  const pretty = b4a.from(JSON.stringify({ changeIds: ['a1', 'b_3-x', 'c2'], snapshot: SNAPSHOT }, null, 2) + '\n', 'utf8')
  t.unlike(pretty, base)
  t.alike(verifyModRequest(ackFields({ body: pretty }), signature), { ok: false, reason: 'bad-signature' }, 'pretty body fails')
  const reparsed = JSON.parse(b4a.toString(pretty, 'utf8'))
  t.alike(canonicalBody('ack', reparsed), base, 'parsing then rebuilding gives the canonical bytes')
})

test('canonicalSnapshot: exact keys, copies the lists', (t) => {
  const c = canonicalSnapshot(SNAPSHOT)
  t.alike(c, SNAPSHOT)
  t.not(c.blocked, SNAPSHOT.blocked, 'blocked is a fresh array')
  t.not(c.revokedIssuers, SNAPSHOT.revokedIssuers, 'revokedIssuers is a fresh array')

  t.exception.all(() => canonicalSnapshot({ ...SNAPSHOT, extra: 1 }), /TypeError/, 'extra key')
  for (const k of SNAPSHOT_KEYS) {
    const s = { ...SNAPSHOT }
    delete s[k]
    t.exception.all(() => canonicalSnapshot(s), /TypeError/, 'missing ' + k)
    t.exception.all(() => canonicalBody('ack', { changeIds: [], snapshot: s }), /TypeError/, 'ack body without ' + k)
  }
  // Same count, one key swapped for another.
  const swapped = { ...SNAPSHOT, other: 1 }
  delete swapped.signature
  t.exception.all(() => canonicalSnapshot(swapped), /TypeError/, 'swapped key')
  t.exception.all(() => canonicalSnapshot({ ...SNAPSHOT, blocked: 'x' }), /TypeError/, 'blocked not an array')
  for (const bad of [null, undefined, [], 'x', 1, new Map()]) {
    t.exception.all(() => canonicalSnapshot(bad), /TypeError/, 'not a plain object')
  }
})

test('canonicalBody: shape checks', (t) => {
  t.exception.all(() => canonicalBody('push', {}), /TypeError/, 'unknown op')
  t.exception.all(() => canonicalBody('ack', null), /TypeError/)
  t.exception.all(() => canonicalBody('ack', { changeIds: [] }), /TypeError/, 'no snapshot')
  t.exception.all(() => canonicalBody('ack', { changeIds: [], snapshot: SNAPSHOT, extra: 1 }), /TypeError/, 'extra key')
  t.exception.all(() => canonicalBody('ack', { changeIds: 'a1', snapshot: SNAPSHOT }), /TypeError/, 'changeIds not an array')
  for (const id of ['', 'a'.repeat(65), 'a b', 'a/b', 'é', 1, null]) {
    t.exception.all(() => canonicalBody('ack', { changeIds: [id], snapshot: SNAPSHOT }), /TypeError/, 'bad changeId: ' + id)
  }
  const many = Array.from({ length: MAX_CHANGE_IDS }, (_, i) => 'c' + i)
  t.ok(canonicalBody('ack', { changeIds: many, snapshot: SNAPSHOT }).byteLength > 0, 'at the limit')
  t.exception.all(() => canonicalBody('ack', { changeIds: [...many, 'x'], snapshot: SNAPSHOT }), /TypeError/, 'over the limit')
  t.ok(canonicalBody('ack', { changeIds: [], snapshot: SNAPSHOT }).byteLength > 0, 'an empty list is fine')
})

test('every field is bound by the signature', (t) => {
  const signature = signModRequest(pullFields(), MOD_KP)
  const changes = {
    origin: 'https://other.example.org',
    association: 'ce'.repeat(32),
    nonce: 'C'.repeat(43),
    op: 'ack',
    body: b4a.from('{ }', 'utf8')
  }
  for (const [k, v] of Object.entries(changes)) {
    t.alike(verifyModRequest(pullFields({ [k]: v }), signature), { ok: false, reason: 'bad-signature' }, 'changed ' + k)
  }
  t.alike(verifyModRequest(pullFields({ origin: 'http://127.0.0.1:8080' }), signature), { ok: false, reason: 'bad-signature' }, 'loopback origin')
  const other = crypto.keyPair()
  t.alike(verifyModRequest(pullFields({ moderator: b4a.toString(other.publicKey, 'hex') }), signature), { ok: false, reason: 'bad-signature' }, 'other moderator')
  t.alike(verifyModRequest(pullFields(), signModRequest(pullFields(), other)), { ok: false, reason: 'bad-signature' }, 'signed by another key')
  t.alike(verifyModRequest(pullFields(), signature.slice(0, -2) + (signature.endsWith('00') ? '01' : '00')), { ok: false, reason: 'bad-signature' }, 'flipped signature')
})

test('domain separation from the report payload', (t) => {
  // A report payload (packages/core/lib/report.js) starts with
  // 'varanda-report-v1'; signed bytes of that shape never verify here.
  const report = b4a.from(['varanda-report-v1', ORIGIN, ASSOCIATION, MODERATOR, NONCE, 'pull', b4a.toString(crypto.hash(canonicalBody('pull')), 'hex')].join('\n'), 'utf8')
  const reportSig = b4a.toString(crypto.sign(report, MOD_KP.secretKey), 'hex')
  t.alike(verifyModRequest(pullFields(), reportSig), { ok: false, reason: 'bad-signature' }, 'a report signature is not a mod request')
  t.alike(verifyModRequest(report, reportSig), { ok: false, reason: 'malformed' }, 'a report buffer is malformed as fields')
  t.absent(crypto.verify(report, b4a.from(signModRequest(pullFields(), MOD_KP), 'hex'), MOD_KP.publicKey), 'a mod request signature is not a report')
  t.ok(b4a.toString(modRequestPayload(pullFields()), 'utf8').startsWith(PREFIX + '\n'))
})

test('shape checks: payload throws, verify never throws', (t) => {
  const signature = signModRequest(pullFields(), MOD_KP)
  const bad = [
    null,
    undefined,
    'x',
    [],
    b4a.from('varanda-report-v1\n', 'utf8'),
    pullFields({ origin: 'http://varanda.example.org' }),
    pullFields({ origin: ORIGIN + '/' }),
    pullFields({ association: 'CD'.repeat(32) }),
    pullFields({ association: 'cd'.repeat(31) }),
    pullFields({ moderator: MODERATOR.toUpperCase() }),
    pullFields({ moderator: 1 }),
    pullFields({ nonce: 'a'.repeat(42) }),
    pullFields({ nonce: 'a\nb'.repeat(20) }),
    pullFields({ op: 'push' }),
    pullFields({ op: 'PULL' }),
    pullFields({ body: '{}' }),
    pullFields({ body: null })
  ]
  for (const fields of bad) {
    t.alike(verifyModRequest(fields, signature), { ok: false, reason: 'malformed' })
    t.exception.all(() => modRequestPayload(fields), /TypeError/)
    t.exception.all(() => signModRequest(fields, MOD_KP), /TypeError/)
  }
  for (const sig of [undefined, null, '', signature.toUpperCase(), signature.slice(2), signature + '00', 1, b4a.from(signature, 'hex')]) {
    t.alike(verifyModRequest(pullFields(), sig), { ok: false, reason: 'malformed' })
  }
  const hostile = {}
  Object.defineProperty(hostile, 'origin', { enumerable: true, get () { throw new Error('boom') } })
  t.alike(verifyModRequest(hostile, signature), { ok: false, reason: 'malformed' }, 'a throwing getter')
  t.exception.all(() => signModRequest(pullFields(), null), /TypeError/)
  t.exception.all(() => signModRequest(pullFields(), { secretKey: b4a.alloc(32) }), /TypeError/)
})

// hypercore-crypto loads sodium-native under Node, whose addon loader
// (require-addon) reads the prebuild with 'fs' (see account-link.test.js);
// so the module's OWN requires are pinned, and no network module, '#fs' or
// cert.js is pulled in by anything it loads.
test('the module is pure: no fs, no network, no cert.js', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/mod-request.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'mod-request.js')).map(([id]) => id)
  t.alike(own.sort(), ['b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/blocklist.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
