'use strict'

// export.read (docs/rpc.md 5.180) through a real session: the walk of the
// stateless cursor, the snapshot bound, the exact result shape and that no
// secret or path reaches a page.
const test = require('brittle')
const path = require('node:path')
const { LOG_LIMIT_MAX, MAX_MESSAGE, validateResponse, followsDigest } = require('@varanda/rpc')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure, wire } = require('./helpers/net')
const { initAssociation, issueCertificate } = require('../lib/assoc')
const store = require('../lib/store')

const BOOTSTRAP = ['127.0.0.1:49737']
const RESULT_KEYS = ['entries', 'follows', 'head', 'invalid', 'key', 'next']
const BIG = '\u{1F600}'.repeat(1000)

function forms (bytes) {
  const b64 = bytes.toString('base64').replace(/=+$/, '')
  return [bytes.toString('hex'), b64, bytes.toString('base64url'), JSON.stringify([...bytes])]
}

test('export.read: walk, snapshot bound, shape and secrets', async (t) => {
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: association } = initAssociation(assocDir)
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association, bootstrap: BOOTSTRAP, dhtHost: '127.0.0.1' })
  const { call } = await connect(t, session)

  const none = await failure(call('export.read', {}))
  t.alike(none, { code: 'NOT_FOUND', message: 'identidade não encontrada' }, 'no identity')

  const { publicKey } = await call('identity.create')
  await call('cert.add', { cert: issueCertificate(assocDir, { member: publicKey }) })
  await call('profile.set', { name: 'Ana', bio: 'bio' })
  const refs = []
  for (let i = 0; i < 70; i++) refs.push((await call('post.create', { text: BIG })).ref)
  await call('post.reply', { to: refs[0], text: 'resposta' })
  await call('like.set', { to: refs[1], on: true })
  const follows = ['11', '22', '33'].map((x) => x.repeat(32))
  for (const key of follows) await call('follow.add', { key })
  await call('post.delete', { to: refs[2] })

  const mark = wire.length
  const log = await call('log.read', { limit: 30 })
  const length = log.entries.at(-1).seq + 1

  const pages = []
  let part = await call('export.read', {})
  pages.push(part)
  while (part.next !== null) {
    part = await call('export.read', part.next)
    pages.push(part)
  }
  const head = pages[0].head
  t.is(head.length, length, 'head.length is the log length')
  t.alike(Object.keys(head).sort(), ['association', 'blocked', 'follows', 'followsDigest', 'format', 'length', 'muted', 'profile', 'version'], 'head keys')
  t.is(head.followsDigest, followsDigest(follows), 'digest of the follow set')
  t.is(head.association, association)
  t.is(head.follows, 3)
  t.alike(head.profile, { name: 'Ana', bio: 'bio' })
  t.is(head.blocked, null)
  t.is(head.muted, null)
  for (const p of pages) t.alike(Object.keys(p).sort(), RESULT_KEYS, 'result keys')
  t.alike(pages[1].follows.slice().sort(), follows, 'follows part')
  t.is(pages[1].next.part, 'diary')

  const diary = pages.filter((p) => p.entries.length + p.invalid.length > 0)
  t.ok(diary.length >= 2, 'at least two diary pages (' + diary.length + ')')
  const seqs = []
  const entries = []
  const invalid = []
  for (const p of diary) {
    const merged = [...p.entries, ...p.invalid].map((x) => x.seq).sort((a, b) => a - b)
    seqs.push(...merged)
    entries.push(...p.entries)
    invalid.push(...p.invalid)
  }
  t.alike(seqs, Array.from({ length }, (_, i) => i), 'every seq once, ascending across pages')
  t.ok(entries.length > LOG_LIMIT_MAX, 'more entries than one log.read page')
  t.alike(invalid.filter((x) => x.reason === 'deleted').length, 1)
  const deletedSeq = invalid.find((x) => x.reason === 'deleted').seq
  t.alike(invalid.find((x) => x.seq === deletedSeq), { seq: deletedSeq, reason: 'deleted' })

  // Entries equal log.read's records for the same seqs.
  const bySeq = new Map(entries.map((e) => [e.seq, e.record]))
  let compared = 0
  for (let before = length; before > 0; before -= 30) {
    const r = await call('log.read', { limit: 30, before })
    for (const e of r.entries) {
      t.alike(bySeq.get(e.seq), e.record, 'record ' + e.seq)
      compared++
    }
  }
  t.is(compared, entries.length, 'every entry compared')

  // Responses: valid envelopes under MAX_MESSAGE.
  const texts = wire.slice(mark).filter((x) => x.includes('"ok":true') && x.includes('"head"'))
  t.ok(texts.length >= pages.length)
  for (const text of texts) {
    t.ok(validateResponse(JSON.parse(text)).ok, 'valid response')
    t.ok(Buffer.byteLength(text) < MAX_MESSAGE, 'under MAX_MESSAGE')
  }

  // A stale bound past the length clamps; the snapshot excludes a later post.
  const stale = await call('export.read', { part: 'diary', offset: length - 1, until: length + 50 })
  t.is(stale.entries.length + stale.invalid.length, 1)
  t.is(stale.next, null)
  await call('post.create', { text: 'depois' })
  const last = await call('export.read', { part: 'diary', offset: length - 1, until: length })
  t.is(last.entries.length + last.invalid.length, 1, 'post after the head is not exported')
  t.is(last.next, null)
  // A delete written after the head clears its target's bytes: inside the
  // snapshot that block reads as deleted, never as malformed.
  const target = entries.filter((e) => e.record.type === 'post' && e.record.text === BIG).at(-1)
  await call('post.delete', { to: refs[refs.length - 1] })
  const late = await call('export.read', { part: 'diary', offset: target.seq, until: target.seq + 1 })
  t.alike(late.invalid, [{ seq: target.seq, reason: 'deleted' }], 'cleared after the head, reported as deleted')

  // Secrets and paths.
  await session.close()
  const st = await store.openStore(dataDir)
  let secrets
  try {
    const d = await store.openDiary(st)
    secrets = [Buffer.from(d.keyPair.secretKey).subarray(0, 32), Buffer.from(st.primaryKey)]
  } finally {
    await st.close()
  }
  const all = JSON.stringify(pages) + JSON.stringify(stale)
  for (const s of secrets) for (const f of forms(s)) t.absent(all.includes(f), 'no secret form')
  t.absent(all.includes(dataDir), 'no data dir')
})
