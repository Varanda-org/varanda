'use strict'

const test = require('brittle')
const fs = require('#fs')
const { createHash } = require('node:crypto')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const current = require('../lib/records')
const { createCert, createIssuerCert, createIssuedCert } = require('../lib/cert')
const { buildFeed } = require('../lib/feed')
const { applyDeletes } = require('../lib/deletion')
const { READERS, PINS, FIXTURE_PATHS, readOld } = require('./helpers/old-reader')

const AT = '2026-01-01T00:00:00.000Z'

function publicKey () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

// store.appendRecord stores the JSON encoding of the validated plain record.
function encode (record) {
  return b4a.from(JSON.stringify(record), 'utf8')
}

function diaries () {
  const associationKey = crypto.keyPair()
  const issuerKey = crypto.keyPair()
  const member = publicKey()
  const issuerCert = createIssuerCert({ issuer: b4a.toString(issuerKey.publicKey, 'hex'), date: AT }, associationKey)
  const v1 = createCert({ member, date: AT }, associationKey)
  const v2 = createIssuedCert({ member, date: AT }, issuerKey, issuerCert)
  const avatar = {
    core: publicKey(),
    mime: 'image/webp',
    start: 1,
    blocks: 1,
    bytes: 100,
    sha256: createHash('sha256').update('avatar fixture').digest('hex'),
    width: 512,
    height: 512
  }
  const records = [
    current.memberCertRecord(v1),
    ...current.profileRecords({ name: 'Ana', bio: 'Compatibility', avatar, at: AT }),
    current.postRecord({ text: 'Plain post', at: AT }),
    current.postRecord({ text: 'Media post', media: [avatar], at: AT }),
    current.followRecord({ key: publicKey(), on: true, at: AT }),
    current.likeRecord({ to: { author: member, seq: 3 }, on: true, at: AT }),
    current.groupJoinRecord({ group: publicKey(), writer: publicKey(), on: true, at: AT }),
    current.deleteRecord({ seq: 3, at: AT }),
    { type: 'page-delegate', actor: member, at: AT },
    {
      type: 'page-roster',
      page: publicKey(),
      gen: 1,
      owner: member,
      admins: [],
      prev: null,
      at: AT,
      nonce: 'n'.repeat(43),
      association: issuerCert.association,
      issuer: issuerCert.issuer,
      issuerDate: issuerCert.date,
      issuerSignature: issuerCert.signature,
      // Shape fixtures only: page signature verification is a separate fold.
      signature: '0'.repeat(128),
      countersignature: '0'.repeat(128)
    },
    current.postRecord({ text: 'Final post', at: AT })
  ]
  return {
    member,
    association: v1.association,
    avatar,
    v1: records.map(encode),
    v2: [current.memberCertRecord(v2), ...records.slice(1)].map(encode)
  }
}

function entriesOf (raws) {
  return raws.map((raw, seq) => ({ seq, record: current.decodeBlock(raw) }))
}

function malformed (seqs) {
  return seqs.map((seq) => ({ seq, reason: 'malformed' }))
}

test('compat: frozen reader bytes match the historical pins', (t) => {
  for (const name of Object.keys(READERS)) {
    t.is(createHash('sha256').update(fs.readFileSync(FIXTURE_PATHS[name])).digest('hex'), PINS[name], name)
  }
})

test('compat: pre-115 reads v1 known records at their original indexes', (t) => {
  const { v1 } = diaries()
  const result = readOld(READERS['pre-115'], v1)
  t.is(result.gate, null)
  t.alike(result.entries, [0, 1, 3, 11].map((seq) => ({ seq, record: current.decodeBlock(v1[seq]) })))
  t.alike(result.invalid, malformed([2, 4, 5, 6, 7, 8, 9, 10]))
  t.alike(result.profile, { name: 'Ana', bio: 'Compatibility' }, 'plain half of the avatar pair survives')
  t.alike(result.posts.map(({ seq }) => seq), [3, 11])
  t.is(result.posts[result.posts.length - 1].seq, v1.length - 1)
})

test('compat: pre-115 rejects a v2 certificate at the diary gate', (t) => {
  const { v2 } = diaries()
  const reader = READERS['pre-115']
  t.is(reader.validateRecord(reader.decodeBlock(v2[0]), 0), 'malformed')
  const result = readOld(reader, v2)
  t.is(result.gate, 'not-in-log', 'pinned historical v2 break')
  t.alike(result.invalid, malformed([0]))
  t.alike(result.entries, [])
  t.alike(result.posts, [])
  t.is(result.profile, null)
})

test('compat: a future certificate version is refused by name, not as a missing diary', (t) => {
  const { v2 } = diaries()
  const block0 = JSON.parse(b4a.toString(v2[0], 'utf8'))
  const raws = [encode({ ...block0, cert: { ...block0.cert, v: 3 } }), ...v2.slice(1)]
  t.is(readOld(current, raws).gate, 'unsupported-cert-version')
  t.is(readOld(READERS['pre-218'], raws).gate, 'not-in-log', 'an old reader collapses it')
})

test('compat: pre-218 reads v2 but retains a post deleted by a newer writer', (t) => {
  const { v2, avatar } = diaries()
  const result = readOld(READERS['pre-218'], v2)
  t.is(result.gate, null)
  t.alike(result.entries, [0, 1, 2, 3, 4, 5, 6, 11].map((seq) => ({ seq, record: current.decodeBlock(v2[seq]) })))
  t.alike(result.invalid, malformed([7, 8, 9, 10]))
  t.alike(result.profile, { name: 'Ana', bio: 'Compatibility', avatar })
  // Historical residual: skipping an unknown delete leaves its target visible.
  t.alike(result.posts.map(({ seq }) => seq), [3, 4, 11])
  t.alike(result.posts[0].record, current.decodeBlock(v2[3]), 'deleted post remains visible to this reader')
  t.is(result.posts[result.posts.length - 1].seq, v2.length - 1)
})

test('compat: current reader accepts every block in both writer diaries', (t) => {
  const { v1, v2, member, association } = diaries()
  for (const [name, raws] of Object.entries({ v1, v2 })) {
    const entries = entriesOf(raws)
    for (const { seq, record } of entries) {
      t.is(current.validateRecord(record, seq), null, name + ' block ' + seq + ' ' + record.type)
    }
    t.is(applyDeletes(entries)[3].record, null, name + ' current reader applies the deletion')
    const { items } = buildFeed({ logs: [{ key: member, entries }], association, now: Date.parse(AT) })
    t.alike(items.map(({ seq }) => seq), [4, 11], name + ' surviving posts keep their indexes')
  }
})

test('compat: current reader skips future types and extra keys without applying an invalid delete', (t) => {
  const { v1, member, association } = diaries()
  const known = (text) => current.postRecord({ text, at: AT })
  const records = [
    current.decodeBlock(v1[0]),
    known('Before edit'),
    { type: 'edit', seq: 1, text: 'x', at: AT },
    known('After edit'),
    { ...known('Future alt'), alt: 'x' },
    known('After alt'),
    { ...current.profileRecord({ name: 'Future profile', at: AT }), extra: true },
    known('After profile'),
    { ...current.deleteRecord({ seq: 1, at: AT }), extra: true },
    known('After delete'),
    { ...known('Future version'), v: 2 },
    known('After version')
  ]
  const raws = records.map(encode)
  const entries = entriesOf(raws)
  const invalidSeqs = [2, 4, 6, 8, 10]
  const knownSeqs = [1, 3, 5, 7, 9, 11]
  for (const { seq, record } of entries) {
    t.is(current.validateRecord(record, seq), invalidSeqs.includes(seq) ? 'malformed' : null, 'block ' + seq)
  }
  const result = readOld(current, raws)
  t.is(result.gate, null)
  t.alike(result.invalid, malformed(invalidSeqs))
  t.alike(result.entries.map(({ seq }) => seq), [0, ...knownSeqs])
  t.alike(result.posts.map(({ seq }) => seq), knownSeqs)
  t.is(result.profile, null, 'unknown profile does not become the displayed profile')
  t.alike(applyDeletes(entries), entries, 'over-keyed delete deletes nothing')
  const { items, future } = buildFeed({ logs: [{ key: member, entries }], association, now: Date.parse(AT) })
  t.alike(items.map(({ seq, text }) => ({ seq, text })), knownSeqs.map((seq) => ({ seq, text: records[seq].text })))
  t.alike(future, [])
  const validDeleteEntries = entries.map((entry) => entry.seq === 8 ? { seq: 8, record: current.deleteRecord({ seq: 1, at: AT }) } : entry)
  t.is(applyDeletes(validDeleteEntries)[1].record, null, 'the same delete without the extra key removes its target')
})

test('compat: undecodable blocks gate genesis or leave later indexes intact', (t) => {
  const { v1 } = diaries()
  for (const [name, reader] of Object.entries(READERS)) {
    const broken = v1.slice()
    broken[0] = b4a.from('{')
    t.is(readOld(reader, broken).gate, 'not-in-log', name + ' undecodable genesis')
    broken[0] = v1[0]
    broken[3] = b4a.from('{')
    const result = readOld(reader, broken)
    t.is(result.gate, null, name + ' undecodable later block')
    t.ok(result.invalid.some(({ seq, reason }) => seq === 3 && reason === 'malformed'))
    t.is(result.posts[result.posts.length - 1].seq, v1.length - 1)
  }
})

test('compat: a post-edit is skipped as malformed by older readers, which keep the post as written', (t) => {
  // A v1 certificate: every frozen reader accepts that genesis.
  const { v1, member, association } = diaries()
  const records = [
    current.decodeBlock(v1[0]),
    current.postRecord({ text: 'Original', at: AT }),
    current.postEditRecord({ seq: 1, text: 'Corrigido', at: AT }),
    current.postRecord({ text: 'After', at: AT })
  ]
  const raws = records.map(encode)
  for (const { seq, record } of entriesOf(raws)) t.is(current.validateRecord(record, seq), null, 'current reads block ' + seq)
  for (const name of Object.keys(READERS)) {
    const reader = READERS[name]
    t.is(reader.validateRecord(reader.decodeBlock ? reader.decodeBlock(raws[2]) : JSON.parse(b4a.toString(raws[2], 'utf8')), 2), 'malformed', name + ' does not know the type')
    const result = readOld(reader, raws)
    t.is(result.gate, null, name + ' gate')
    t.alike(result.invalid, malformed([2]), name + ' skips only the edit')
    t.alike(result.posts.map(({ seq, record }) => [seq, record.text]), [[1, 'Original'], [3, 'After']], name + ' shows the post as written')
  }
  const feed = buildFeed({ logs: [{ key: member, entries: entriesOf(raws) }], association, now: Date.parse(AT) })
  const edited = feed.items.find((i) => i.seq === 1)
  t.is(edited.text, 'Corrigido', 'a current reader shows the correction')
  t.is(edited.edited, true)
  t.absent('edited' in feed.items.find((i) => i.seq === 3), 'an unedited post has no mark')
})

test('compat: a post-thumbs companion is skipped as malformed by older readers, the post and later indexes stay', (t) => {
  const { v2, avatar } = diaries()
  const thumb = { ...avatar, mime: 'image/jpeg', width: 320, height: 240, bytes: 20000 }
  const photo = { ...avatar, mime: 'image/jpeg' }
  const records = [
    current.decodeBlock(v2[0]),
    current.postRecord({ text: 'Photo', media: [photo], at: AT }),
    current.postThumbsRecord({ seq: 1, thumbs: [thumb], at: AT }),
    current.postRecord({ text: 'After', at: AT })
  ]
  const raws = records.map(encode)
  for (const { seq, record } of entriesOf(raws)) t.is(current.validateRecord(record, seq), null, 'current reads block ' + seq)
  const reader = READERS['pre-218']
  t.is(reader.validateRecord(reader.decodeBlock(raws[2]), 2), 'malformed', 'an older reader does not know the type')
  const result = readOld(reader, raws)
  t.is(result.gate, null)
  t.alike(result.invalid, malformed([2]))
  t.alike(result.posts.map(({ seq }) => seq), [1, 3])
})
