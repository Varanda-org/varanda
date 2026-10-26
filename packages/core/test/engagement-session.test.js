'use strict'

// like.set, repost.set, post.quote, engagement.read and diary.peek of the node
// session (lib/session.js) through a real dispatcher + client pair.
const test = require('brittle')
const path = require('node:path')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure } = require('./helpers/net')
const { initAssociation, issueCertificate } = require('../lib/assoc')

const BOOTSTRAP = ['127.0.0.1:49737']
const OTHER = 'ab'.repeat(32)

async function member (t, { cert = true } = {}) {
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const session = newSession(t, { dataDir: tmpDir(t), association: assoc, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  if (cert) await link.call('cert.add', { cert: issueCertificate(assocDir, { member: publicKey }) })
  return { session, publicKey, ...link }
}

function types (log) {
  return log.entries.map((e) => e.record.type)
}

test('like.set is an idempotent toggle: one record, changed false the second time', async (t) => {
  const m = await member(t)
  const post = await m.call('post.create', { text: 'oi' })
  const to = OTHER + ':3'

  t.alike(await m.call('like.set', { to, on: false }), { seq: null, on: false, changed: false }, 'off with no record ever')
  const first = await m.call('like.set', { to, on: true })
  t.is(first.changed, true)
  t.is(first.on, true)
  t.is(first.seq, post.seq + 1)
  t.alike(await m.call('like.set', { to, on: true }), { seq: first.seq, on: true, changed: false })
  t.alike(types(await m.call('log.read')), ['member-cert', 'post', 'like'], 'one like record')

  const off = await m.call('like.set', { to, on: false })
  t.alike(off, { seq: first.seq + 1, on: false, changed: true }, 'unlike')
  t.alike(await m.call('like.set', { to, on: false }), { seq: off.seq, on: false, changed: false })
  const again = await m.call('like.set', { to, on: true })
  t.is(again.changed, true, 'liked again')
  t.alike(types(await m.call('log.read')), ['member-cert', 'post', 'like', 'like', 'like'])
  t.alike(m.session.internal, [], 'no internal error')
})

test('repost.set is independent of like.set and allows the own post', async (t) => {
  const m = await member(t)
  const own = await m.call('post.create', { text: 'meu' })

  t.alike(await m.call('like.set', { to: own.ref, on: true }), { seq: own.seq + 1, on: true, changed: true }, 'self-like')
  const r = await m.call('repost.set', { to: own.ref, on: true })
  t.alike(r, { seq: own.seq + 2, on: true, changed: true }, 'self-repost')
  t.alike(await m.call('repost.set', { to: own.ref, on: true }), { seq: r.seq, on: true, changed: false })
  t.alike(await m.call('repost.set', { to: own.ref, on: false }), { seq: r.seq + 1, on: false, changed: true }, 'unrepost')
  t.alike(await m.call('repost.set', { to: own.ref, on: false }), { seq: r.seq + 1, on: false, changed: false })
  t.alike(types(await m.call('log.read')), ['member-cert', 'post', 'like', 'repost', 'repost'])
})

test('like.set and repost.set need the member certificate and a valid target', async (t) => {
  const m = await member(t, { cert: false })
  const NEED = { code: 'USAGE', message: 'grave o certificado de membro antes de publicar' }
  t.alike(await failure(m.call('like.set', { to: OTHER + ':1', on: true })), NEED)
  t.alike(await failure(m.call('repost.set', { to: OTHER + ':1', on: true })), NEED)
  const c = await member(t)
  t.alike(await failure(c.call('like.set', { to: OTHER + ':0', on: true })), { code: 'USAGE', message: 'parâmetro inválido: to' })
  t.alike(await failure(c.call('repost.set', { to: OTHER + ':0', on: true })), { code: 'USAGE', message: 'parâmetro inválido: to' })
  t.alike(types(await c.call('log.read')), ['member-cert'], 'nothing written')
})

test('post.quote writes a post with `quote` and no replyTo', async (t) => {
  const m = await member(t)
  const r = await m.call('post.quote', { to: OTHER + ':7', text: 'concordo' })
  t.alike(r, { seq: 1 })
  const log = await m.call('log.read')
  const record = log.entries[1].record
  t.is(record.type, 'post')
  t.is(record.text, 'concordo')
  t.is(record.replyTo, null)
  t.alike(record.quote, { author: OTHER, seq: 7 })
  t.alike(log.invalid, [])

  const feed = await m.call('feed.read', { limit: 10 })
  t.alike(feed.items.map((i) => i.kind), ['post'])
  t.alike(feed.items[0].quote, { author: OTHER, seq: 7 })
  t.is(feed.items[0].replyTo, null)
})

test('post.quote with media is refused (USAGE) before anything opens', async (t) => {
  const media = [{ core: 'dd'.repeat(32), mime: 'image/png', start: 1, blocks: 1, bytes: 10, sha256: 'ee'.repeat(32), width: 4, height: 4 }]
  const NO = { code: 'USAGE', message: 'mídia disponível só na versão web' }
  const fresh = await member(t, { cert: false })
  t.alike(await failure(fresh.call('post.quote', { to: OTHER + ':1', text: 'x', media })), NO)
  const m = await member(t)
  const before = await m.call('log.read')
  t.alike(await failure(m.call('post.quote', { to: OTHER + ':1', text: 'x', media })), NO)
  t.alike(await failure(m.call('post.quote', { to: OTHER + ':0', text: 'x' })), { code: 'USAGE', message: 'parâmetro inválido: to' })
  t.alike(await m.call('log.read'), before, 'nothing written')
  t.alike([fresh.session.internal, m.session.internal], [[], []])
})

test('engagement.read answers the subsets of refs the own diary likes and reposts', async (t) => {
  const m = await member(t)
  const a = OTHER + ':1'
  const b = OTHER + ':2'
  const c = OTHER + ':3'
  await m.call('like.set', { to: a, on: true })
  await m.call('like.set', { to: b, on: true })
  await m.call('like.set', { to: b, on: false })
  await m.call('repost.set', { to: c, on: true })

  t.alike(await m.call('engagement.read', { refs: [a, b, c] }), { liked: [a], reposted: [c] })
  t.alike(await m.call('engagement.read', { refs: [c, a] }), { liked: [a], reposted: [c] }, 'request order')
  t.alike(await m.call('engagement.read', { refs: [b] }), { liked: [], reposted: [] })
  t.alike(await m.call('engagement.read', { refs: [OTHER + ':9'] }), { liked: [], reposted: [] }, 'unknown ref')
  t.alike(await failure(m.call('engagement.read', { refs: [] })), { code: 'USAGE', message: 'parâmetro inválido: refs' })
})

test('feed.read returns a repost item for a reposted target', async (t) => {
  const m = await member(t)
  const own = await m.call('post.create', { text: 'meu' })
  await m.call('repost.set', { to: own.ref, on: true })
  const feed = await m.call('feed.read', { limit: 10 })
  t.alike(feed.items.map((i) => i.kind).sort(), ['post', 'repost'])
  const item = feed.items.find((i) => i.kind === 'repost')
  t.alike(item.to, { author: m.publicKey, seq: own.seq })
})

test('diary.peek is refused on the node session, nothing opened', async (t) => {
  const NO = { code: 'USAGE', message: 'leitura sob demanda só na versão web' }
  const fresh = await member(t, { cert: false })
  t.alike(await failure(fresh.call('diary.peek', { author: OTHER, seqs: [1] })), NO, 'before a certificate')
  const m = await member(t)
  const before = await m.call('log.read')
  t.alike(await failure(m.call('diary.peek', { author: OTHER, seqs: [1, 2], profileSeq: 1 })), NO)
  t.alike(await m.call('log.read'), before)
  t.alike([fresh.session.internal, m.session.internal], [[], []])
})

test('the dispatcher rejects unknown params on the new methods', async (t) => {
  const m = await member(t)
  const UNKNOWN = { code: 'USAGE', message: 'parâmetro desconhecido' }
  t.alike(await failure(m.call('like.set', { to: OTHER + ':1', on: true, extra: 1 })), UNKNOWN)
  t.alike(await failure(m.call('repost.set', { to: OTHER + ':1', on: true, extra: 1 })), UNKNOWN)
  t.alike(await failure(m.call('post.quote', { to: OTHER + ':1', text: 'x', extra: 1 })), UNKNOWN)
  t.alike(await failure(m.call('engagement.read', { refs: [OTHER + ':1'], extra: 1 })), UNKNOWN)
  t.alike(await failure(m.call('diary.peek', { author: OTHER, seqs: [1], extra: 1 })), UNKNOWN)
})
