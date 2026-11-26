'use strict'

// post.delete and profile.delete of the node session (lib/session.js)
// through a real dispatcher + client pair.
const test = require('brittle')
const path = require('node:path')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure } = require('./helpers/net')
const { initAssociation, issueCertificate } = require('../lib/assoc')
const storeLib = require('../lib/store')
const { profileRecord, profileRecords, postRecord, postThumbsRecord, postAltRecord, mediaCoreRecord, deleteRecord, validateRecord, MAX_DELETE_RANGES } = require('../lib/records')

const BOOTSTRAP = ['127.0.0.1:49737']
const OTHER = 'ab'.repeat(32)
const CORE = 'cd'.repeat(32)
const UNDECLARED = 'ef'.repeat(32)
const AT = '2026-01-02T03:04:05.000Z'
const BAD_REF = { code: 'USAGE', message: 'referência inválida' }
const NOT_DELETABLE = { code: 'USAGE', message: 'não é possível apagar este registro' }
const NOT_A_POST = { code: 'USAGE', message: 'o registro não é uma publicação' }
const NOT_A_PROFILE = { code: 'USAGE', message: 'o registro não é um perfil' }
const GENESIS = { code: 'USAGE', message: 'grave o certificado de membro antes de publicar' }

async function member (t) {
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: assoc, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: issueCertificate(assocDir, { member: publicKey }) })
  return { session, publicKey, dataDir, ...link }
}

// Appends straight to the diary between session calls (the session holds no
// store open while idle), as a browser device of the same identity would.
async function appendDirect (dataDir, records, many = false) {
  const s = await storeLib.openStore(dataDir)
  try {
    const diary = await storeLib.openDiary(s)
    if (many) return await storeLib.appendRecords(diary, records)
    let seq = null
    for (const r of records) seq = await storeLib.appendRecord(diary, r)
    return seq
  } finally {
    await s.close()
  }
}

function descriptor (core, start, blocks = 1) {
  return { core, mime: 'image/webp', start, blocks, bytes: (blocks - 1) * 32768 + 1000, sha256: 'e'.repeat(64), width: 512, height: 512 }
}

// Judging a target as written needs its bytes: VARANDA_NO_CLEAR=1 keeps
// them -> restore().
function noClear (t) {
  const before = process.env.VARANDA_NO_CLEAR
  process.env.VARANDA_NO_CLEAR = '1'
  const restore = () => {
    if (before === undefined) delete process.env.VARANDA_NO_CLEAR
    else process.env.VARANDA_NO_CLEAR = before
  }
  t.teardown(restore, { force: true })
  return restore
}

function itemSeqs (feed) {
  return feed.items.filter((i) => i.kind === 'post').map((i) => i.seq).sort((a, b) => a - b)
}

test('post.delete hides a post, a reply and a quote; a second call writes nothing', async (t) => {
  const m = await member(t)
  const post = await m.call('post.create', { text: 'oi' })
  const reply = await m.call('post.reply', { to: post.ref, text: 'resposta' })
  const quote = await m.call('post.quote', { to: OTHER + ':1', text: 'citação' })
  const keep = await m.call('post.create', { text: 'fica' })
  t.alike(itemSeqs(await m.call('feed.read', { limit: 20 })), [post.seq, reply.seq, quote.seq, keep.seq])

  const d1 = await m.call('post.delete', { to: post.ref })
  t.alike(d1, { seq: keep.seq + 1, ref: m.publicKey + ':' + (keep.seq + 1), changed: true, deleted: [post.seq] })
  const d2 = await m.call('post.delete', { to: reply.ref })
  const d3 = await m.call('post.delete', { to: m.publicKey + ':' + quote.seq })
  t.alike([d2.deleted, d3.deleted], [[reply.seq], [quote.seq]])

  t.alike(itemSeqs(await m.call('feed.read', { limit: 20 })), [keep.seq], 'only the kept post is in the feed')
  const log = await m.call('log.read')
  t.alike(log.invalid, [post.seq, reply.seq, quote.seq].map((seq) => ({ seq, reason: 'deleted' })))
  t.alike(log.entries.map((e) => e.record.type), ['member-cert', 'post', 'delete', 'delete', 'delete'])
  t.alike(log.entries[2].record, { type: 'delete', seq: post.seq, at: log.entries[2].record.at })

  t.alike(await m.call('post.delete', { to: post.ref }), { seq: d1.seq, ref: d1.ref, changed: false, deleted: [post.seq] })
  t.alike(await m.call('log.read'), log, 'nothing appended')
  t.alike(m.session.internal, [], 'no internal error')
})

test('post.delete and profile.delete refuse what the writer never deletes', async (t) => {
  const m = await member(t)
  await m.call('profile.set', { name: 'Ana' })
  const post = await m.call('post.create', { text: 'oi' })
  await m.call('follow.add', { key: OTHER })
  const d = await m.call('post.delete', { to: post.ref })
  const like = await m.call('like.set', { to: OTHER + ':1', on: true })
  const before = await m.call('log.read')
  const followSeq = before.entries.find((e) => e.record.type === 'follow').seq
  const ref = (seq) => m.publicKey + ':' + seq

  t.alike(await failure(m.call('post.delete', { to: OTHER + ':1' })), BAD_REF, 'another author')
  t.alike(await failure(m.call('post.delete', { to: ref(99) })), BAD_REF, 'past the diary length')
  t.alike(await failure(m.call('post.delete', { to: ref(0) })), { code: 'USAGE', message: 'parâmetro inválido: to' }, 'block 0')
  t.alike(await failure(m.call('profile.delete', { to: ref(0) })), { code: 'USAGE', message: 'parâmetro inválido: to' })
  t.alike(await failure(m.call('post.delete', { to: d.ref })), NOT_DELETABLE, 'a tombstone')
  t.alike(await failure(m.call('profile.delete', { to: d.ref })), NOT_DELETABLE)
  t.alike(await failure(m.call('post.delete', { to: ref(followSeq) })), NOT_DELETABLE, 'a follow')
  t.alike(await failure(m.call('post.delete', { to: ref(like.seq) })), NOT_DELETABLE, 'a like')
  t.alike(await failure(m.call('post.delete', { to: ref(1) })), { code: 'USAGE', message: 'o registro não é uma publicação' })
  const other = await m.call('post.create', { text: 'outro' })
  t.alike(await failure(m.call('profile.delete', { to: other.ref })), { code: 'USAGE', message: 'o registro não é um perfil' })
  const after = await m.call('log.read')
  t.is(after.entries.length, before.entries.length + 1, 'only the new post was written')
  t.alike(m.session.internal, [], 'no internal error')
})

test('profile.delete falls back to the previous version and then to no profile', async (t) => {
  const m = await member(t)
  const p1 = await m.call('profile.set', { name: 'Ana' })
  const p2 = await m.call('profile.set', { name: 'Bia', bio: 'oi' })
  const read = async () => (await m.call('profile.read', { authors: [m.publicKey] })).profiles[0]
  t.is((await read()).name, 'Bia')
  const r = await m.call('profile.delete', { to: m.publicKey + ':' + p2.seq })
  t.alike(r.deleted, [p2.seq])
  t.is(r.changed, true)
  t.is((await read()).name, 'Ana', 'previous version')
  await m.call('profile.delete', { to: m.publicKey + ':' + p1.seq })
  t.alike(await read(), { author: m.publicKey, name: null, bio: null, avatar: null, username: null }, 'no profile left')
  t.alike(m.session.internal, [], 'no internal error')
})

test('profile.delete deletes a compatibility pair as one version in one append', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const avatar = descriptor(CORE, 1, 2)
  const last = await appendDirect(m.dataDir, profileRecords({ name: 'Ana', avatar, at: AT }), true)
  const n = last - 1
  const before = (await m.call('log.read')).entries.length
  const r = await m.call('profile.delete', { to: m.publicKey + ':' + n })
  t.alike(r, { seq: last + 2, ref: m.publicKey + ':' + (last + 2), changed: true, deleted: [n, last] })
  const log = await m.call('log.read')
  t.is(log.entries.length + log.invalid.length, before + 2, 'one length jump of 2')
  const [first, second] = log.entries.slice(-2).map((e) => e.record)
  t.alike(first, { type: 'delete', seq: n, at: first.at }, 'the plain block frees no media')
  t.alike(second, { type: 'delete', seq: last, at: second.at, media: [{ core: CORE, start: 1, blocks: 2 }] })
  t.is(first.at, second.at, 'both tombstones of the pair carry one at')
  t.alike(await m.call('profile.delete', { to: m.publicKey + ':' + last }), { seq: r.seq, ref: r.ref, changed: false, deleted: [n, last] })
  t.alike(await m.call('profile.delete', { to: m.publicKey + ':' + n }), { seq: r.seq, ref: r.ref, changed: false, deleted: [n, last] })
  t.is((await m.call('log.read')).entries.length, log.entries.length, 'nothing appended')
})

test('two separate deletions of adjacent profiles answer apart once cleared', async (t) => {
  const m = await member(t)
  const p1 = await appendDirect(m.dataDir, [profileRecord({ name: 'Ana', at: AT })])
  const p2 = await appendDirect(m.dataDir, [profileRecord({ name: 'Bia', at: AT })])
  const ref = (seq) => m.publicKey + ':' + seq
  const r1 = await m.call('profile.delete', { to: ref(p1) })
  t.alike(r1, { seq: p2 + 1, ref: ref(p2 + 1), changed: true, deleted: [p1] })
  // A separate delete never shares the first one's `at`.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const r2 = await m.call('profile.delete', { to: ref(p2) })
  t.alike(r2, { seq: p2 + 2, ref: ref(p2 + 2), changed: true, deleted: [p2] })
  t.alike(await m.call('profile.delete', { to: ref(p1) }), { ...r1, changed: false })
  t.alike(await m.call('profile.delete', { to: ref(p2) }), { ...r2, changed: false })
  t.alike(m.session.internal, [], 'no internal error')
})

test('a half-deleted compatibility pair writes only the missing tombstone', async (t) => {
  noClear(t)
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const a = profileRecords({ name: 'Ana', avatar: descriptor(CORE, 1), at: AT })
  const b = profileRecords({ name: 'Bia', avatar: descriptor(CORE, 2), at: AT })
  const lastB = await appendDirect(m.dataDir, [...a, ...b])
  const [plainA, avatarA, plainB, avatarB] = [lastB - 3, lastB - 2, lastB - 1, lastB]
  const tombA = await appendDirect(m.dataDir, [deleteRecord({ seq: plainA, at: AT }), deleteRecord({ seq: avatarB, at: AT })])
  const ref = (seq) => m.publicKey + ':' + seq
  const before = await m.call('log.read')

  const r1 = await m.call('profile.delete', { to: ref(avatarA) })
  t.alike(r1, { seq: tombA + 1, ref: ref(tombA + 1), changed: true, deleted: [plainA, avatarA] })
  const r2 = await m.call('profile.delete', { to: ref(plainB) })
  t.alike(r2, { seq: tombA + 2, ref: ref(tombA + 2), changed: true, deleted: [plainB, avatarB] })
  const log = await m.call('log.read')
  t.is(log.entries.length + log.invalid.length, before.entries.length + before.invalid.length + 2, 'one tombstone each')
  t.alike(log.entries.slice(-2).map((e) => e.record.seq), [avatarA, plainB])
  t.alike(await m.call('profile.delete', { to: ref(plainA) }), { seq: r1.seq, ref: r1.ref, changed: false, deleted: [plainA, avatarA] })
  t.alike(await m.call('profile.delete', { to: ref(avatarB) }), { seq: r2.seq, ref: r2.ref, changed: false, deleted: [plainB, avatarB] })
  t.alike(m.session.internal, [], 'no internal error')
})

test('kind is checked before the already-deleted short-circuit', async (t) => {
  const restore = noClear(t)
  const m = await member(t)
  const p = await m.call('profile.set', { name: 'Ana' })
  const post = await m.call('post.create', { text: 'oi' })
  const ref = (seq) => m.publicKey + ':' + seq
  const dPost = await m.call('post.delete', { to: post.ref })
  const dProfile = await m.call('profile.delete', { to: ref(p.seq) })
  const before = await m.call('log.read')
  t.alike(await failure(m.call('profile.delete', { to: post.ref })), NOT_A_PROFILE, 'a deleted post is still a post')
  t.alike(await failure(m.call('post.delete', { to: ref(p.seq) })), NOT_A_POST, 'a deleted profile is still a profile')
  t.alike(await m.call('log.read'), before, 'nothing appended')
  // Once cleared, the kind can no longer be read: the tombstone answers.
  restore()
  t.alike(await m.call('log.read'), before)
  t.alike(await m.call('profile.delete', { to: post.ref }), { ...dPost, changed: false })
  t.alike(await m.call('post.delete', { to: ref(p.seq) }), { ...dProfile, changed: false })
  t.alike(await m.call('log.read'), before, 'nothing appended')
})

test('a delete before block 0 asks for the member certificate first', async (t) => {
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: OTHER, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  t.alike(await failure(link.call('post.delete', { to: publicKey + ':1' })), GENESIS)
  t.alike(await failure(link.call('profile.delete', { to: publicKey + ':1' })), GENESIS)
  t.alike(await failure(link.call('post.delete', { to: OTHER + ':1' })), GENESIS, 'before the ref checks')
})

test('a compatibility pair is a plain block followed by its avatar block, never the reverse', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const a = profileRecords({ name: 'Ana', avatar: descriptor(CORE, 1), at: AT })
  const b = profileRecords({ name: 'Ana', avatar: descriptor(CORE, 2), at: AT })
  const last = await appendDirect(m.dataDir, [...a, ...b])
  const [plainA, avatarA, plainB, avatarB] = [last - 3, last - 2, last - 1, last]
  const ref = (seq) => m.publicKey + ':' + seq
  t.alike((await m.call('profile.delete', { to: ref(plainB) })).deleted, [plainB, avatarB])
  t.alike((await m.call('profile.delete', { to: ref(avatarA) })).deleted, [plainA, avatarA])
})

test('a tombstone carries only media no surviving record overlaps, in a declared core', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const solo = await appendDirect(m.dataDir, [postRecord({ text: '', at: AT, media: [descriptor(CORE, 1), descriptor(UNDECLARED, 1)] })])
  const shared = await appendDirect(m.dataDir, [postRecord({ text: 'a', at: AT, media: [descriptor(CORE, 5, 2)] })])
  await appendDirect(m.dataDir, [postRecord({ text: 'b', at: AT, media: [descriptor(CORE, 6)] })])
  const record = async (seq) => (await m.call('log.read')).entries.find((e) => e.seq === seq).record

  const r1 = await m.call('post.delete', { to: m.publicKey + ':' + solo })
  t.alike((await record(r1.seq)).media, [{ core: CORE, start: 1, blocks: 1 }], 'undeclared core left out')
  const r2 = await m.call('post.delete', { to: m.publicKey + ':' + shared })
  t.is((await record(r2.seq)).media, undefined, 'a live post overlaps the range')
})

test('post.delete of a 10-photo post appends three tombstones of at most 4 ranges in one append', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const ten = Array.from({ length: 10 }, (_, i) => descriptor(CORE, 1 + i * 2, 2))
  const big = await appendDirect(m.dataDir, [postRecord({ text: '', at: AT, media: ten })])
  const four = await appendDirect(m.dataDir, [postRecord({ text: 'b', at: AT, media: Array.from({ length: 4 }, (_, i) => descriptor(CORE, 30 + i)) })])
  const before = (await m.call('log.read')).entries.length

  const r = await m.call('post.delete', { to: m.publicKey + ':' + big })
  t.alike(r, { seq: four + 3, ref: m.publicKey + ':' + (four + 3), changed: true, deleted: [big] })
  const log = await m.call('log.read')
  t.is(log.entries.length + log.invalid.length, before + 3, 'one length jump of 3')
  const tombs = log.entries.slice(-3)
  t.alike(tombs.map((e) => e.seq), [four + 1, four + 2, four + 3])
  for (const { seq, record } of tombs) {
    t.is(record.type, 'delete')
    t.is(record.seq, big, 'every tombstone targets the post')
    t.is(record.at, tombs[0].record.at, 'one at for the whole append')
    t.ok(record.media.length <= MAX_DELETE_RANGES, 'at most 4 ranges')
    t.is(validateRecord(record, seq), null, 'valid at its seq')
  }
  t.alike(tombs.flatMap((e) => e.record.media), ten.map((d) => ({ core: d.core, start: d.start, blocks: d.blocks })), 'together the ten ranges')

  t.alike(await m.call('post.delete', { to: m.publicKey + ':' + big }), { seq: r.seq, ref: r.ref, changed: false, deleted: [big] }, 'a repeat writes nothing')
  t.is((await m.call('log.read')).entries.length, log.entries.length, 'nothing appended')

  const r4 = await m.call('post.delete', { to: m.publicKey + ':' + four })
  t.is(r4.seq, r.seq + 1, 'a 4-photo post still gets one tombstone')
  const last = (await m.call('log.read')).entries.slice(-1)[0].record
  t.is(last.seq, four)
  t.is(last.media.length, 4)
})

test('log.read pages with before over a deleted slot', async (t) => {
  const m = await member(t)
  const a = await m.call('post.create', { text: 'a' })
  const b = await m.call('post.create', { text: 'b' })
  await m.call('post.delete', { to: b.ref })
  const page = await m.call('log.read', { limit: 1, before: b.seq + 1 })
  t.alike(page.entries, [])
  t.alike(page.invalid, [{ seq: b.seq, reason: 'deleted' }])
  const next = await m.call('log.read', { limit: 1, before: b.seq })
  t.alike(next.entries.map((e) => e.seq), [a.seq])
})

test('like and repost toggles still work next to a deleted post', async (t) => {
  const m = await member(t)
  const post = await m.call('post.create', { text: 'oi' })
  const like = await m.call('like.set', { to: OTHER + ':1', on: true })
  await m.call('post.delete', { to: post.ref })
  t.alike(await m.call('like.set', { to: OTHER + ':1', on: true }), { seq: like.seq, on: true, changed: false })
  const repost = await m.call('repost.set', { to: OTHER + ':2', on: true })
  t.is(repost.changed, true)
  t.alike(await m.call('engagement.read', { refs: [OTHER + ':1', OTHER + ':2'] }), { liked: [OTHER + ':1'], reposted: [OTHER + ':2'] })
})

test('a profile block written by profileRecord alone never pairs with a later plain block', async (t) => {
  const m = await member(t)
  const last = await appendDirect(m.dataDir, [profileRecord({ name: 'Ana', at: AT }), profileRecord({ name: 'Ana', at: AT })])
  t.alike((await m.call('profile.delete', { to: m.publicKey + ':' + last })).deleted, [last])
})

function thumb (core, start) {
  return { core, mime: 'image/jpeg', start, blocks: 1, bytes: 1000, sha256: 'e'.repeat(64), width: 64, height: 64 }
}

test('post.delete also tombstones the adjacent post-thumbs and its ranges in the same append', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const media = [descriptor(CORE, 1), descriptor(CORE, 2)]
  const post = await appendDirect(m.dataDir, [postRecord({ text: 'duas', at: AT, media })])
  const thumbs = [thumb(CORE, 3), thumb(CORE, 4)]
  const companion = await appendDirect(m.dataDir, [postThumbsRecord({ seq: post, thumbs, at: AT })])
  t.is(companion, post + 1)
  const keep = await m.call('post.create', { text: 'fica' })
  const before = (await m.call('log.read')).entries.length

  const r = await m.call('post.delete', { to: m.publicKey + ':' + post })
  t.alike(r.deleted, [post])
  const log = await m.call('log.read')
  t.is(log.entries.length + log.invalid.length, before + 2, 'one append of two tombstones')
  const [first, second] = log.entries.slice(-2).map((e) => e.record)
  t.alike([first.type, first.seq], ['delete', post])
  t.alike(first.media, media.map(({ core, start, blocks }) => ({ core, start, blocks })))
  t.alike([second.type, second.seq], ['delete', companion], 'the thumbnails record is tombstoned')
  t.alike(second.media, thumbs.map(({ core, start, blocks }) => ({ core, start, blocks })), 'with its ranges')
  t.is(first.at, second.at, 'one at for the append')
  const repeat = await m.call('post.delete', { to: m.publicKey + ':' + post })
  t.alike([repeat.changed, repeat.deleted], [false, [post]], 'a repeat writes nothing')
  t.is((await m.call('log.read')).entries.length, log.entries.length)
  t.is(keep.seq, companion + 1)
  t.alike(m.session.internal, [], 'no internal error')
})

test('post.delete of ten photos with ten thumbnails splits both per MAX_DELETE_RANGES in one append', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const media = Array.from({ length: 10 }, (_, i) => descriptor(CORE, 1 + i))
  const thumbs = Array.from({ length: 10 }, (_, i) => thumb(CORE, 11 + i))
  const post = await appendDirect(m.dataDir, [postRecord({ text: '', at: AT, media })])
  const companion = await appendDirect(m.dataDir, [postThumbsRecord({ seq: post, thumbs, at: AT })])
  const before = (await m.call('log.read')).entries.length

  await m.call('post.delete', { to: m.publicKey + ':' + post })
  const log = await m.call('log.read')
  t.is(log.entries.length + log.invalid.length, before + 6, 'three tombstones of the post and three of the thumbnails')
  const tombs = log.entries.slice(-6)
  t.alike(tombs.map((e) => e.record.seq), [post, post, post, companion, companion, companion])
  for (const { seq, record } of tombs) {
    t.ok(record.media.length <= MAX_DELETE_RANGES, 'at most 4 ranges')
    t.is(validateRecord(record, seq), null)
  }
  t.alike(tombs.slice(3).flatMap((e) => e.record.media), thumbs.map(({ core, start, blocks }) => ({ core, start, blocks })))
  t.alike(m.session.internal, [], 'no internal error')
})

test('a later delete tombstones up to four thumbnail records an older writer left, and a repeat finishes the rest', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const posts = []
  const companions = []
  for (let i = 0; i < 5; i++) {
    const p = await appendDirect(m.dataDir, [postRecord({ text: 'p' + i, at: AT, media: [descriptor(CORE, 1 + i * 2)] })])
    companions.push(await appendDirect(m.dataDir, [postThumbsRecord({ seq: p, thumbs: [thumb(CORE, 2 + i * 2)], at: AT })]))
    posts.push(p)
  }
  // An older writer deleted every post and left the companions live.
  await appendDirect(m.dataDir, posts.map((p, i) => deleteRecord({ seq: p, at: AT, media: [{ core: CORE, start: 1 + i * 2, blocks: 1 }] })))
  const fresh = await m.call('post.create', { text: 'novo' })

  const r = await m.call('post.delete', { to: fresh.ref })
  t.is(r.changed, true)
  const log = await m.call('log.read')
  const tombs = log.entries.filter((e) => e.record.type === 'delete' && e.seq > fresh.seq)
  t.alike(tombs.map((e) => e.record.seq), [fresh.seq, ...companions.slice(0, 4)], 'the post and four orphans')
  t.absent(tombs.some((e) => e.record.seq === companions[4]), 'the fifth waits')

  // Deleting an already-deleted post whose companion is live finishes it.
  const again = await m.call('post.delete', { to: m.publicKey + ':' + posts[4] })
  t.is(again.changed, true)
  const last = (await m.call('log.read')).entries.slice(-1)[0].record
  t.alike([last.type, last.seq], ['delete', companions[4]])
  const rest = await m.call('post.delete', { to: m.publicKey + ':' + posts[4] })
  t.is(rest.changed, false, 'nothing is left to tombstone')
  t.alike(m.session.internal, [], 'no internal error')
})

test('feed.read of the node session returns thumbs only with the opt-in and only for a live companion', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const media = [descriptor(CORE, 1), descriptor(CORE, 2)]
  const post = await appendDirect(m.dataDir, [postRecord({ text: 'duas', at: AT, media })])
  const thumbs = [thumb(CORE, 3), null]
  await appendDirect(m.dataDir, [postThumbsRecord({ seq: post, thumbs, at: AT })])
  const old = await appendDirect(m.dataDir, [postRecord({ text: 'antigo', at: AT, media: [descriptor(CORE, 4)] })])

  const plain = await m.call('feed.read', { limit: 20 })
  t.ok(plain.items.length >= 2 && plain.items.every((i) => !('thumbs' in i)), 'without the opt-in no item has thumbs')
  const feed = await m.call('feed.read', { limit: 20, thumbs: true })
  t.alike(feed.items.map((i) => i.seq), plain.items.map((i) => i.seq), 'same rows and order')
  t.alike(feed.items.find((i) => i.seq === post).thumbs, thumbs, 'a live companion returns its descriptors')
  t.absent('thumbs' in feed.items.find((i) => i.seq === old), 'a post without a companion has none')

  await m.call('post.delete', { to: m.publicKey + ':' + post })
  const after = await m.call('feed.read', { limit: 20, thumbs: true })
  t.absent(after.items.some((i) => i.seq === post), 'a deleted post and its previews are gone')
  t.alike(m.session.internal, [], 'no internal error')
})

test('post.delete tombstones the post-alt of [post, post-alt] and of [post, post-thumbs, post-alt] with no ranges, in the same append', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const first = await appendDirect(m.dataDir, [postRecord({ text: 'a', at: AT, media: [descriptor(CORE, 1), descriptor(CORE, 2)] })])
  const altOne = await appendDirect(m.dataDir, [postAltRecord({ seq: first, alt: ['um', null], at: AT })])
  t.is(altOne, first + 1)
  const second = await appendDirect(m.dataDir, [postRecord({ text: 'b', at: AT, media: [descriptor(CORE, 4), descriptor(CORE, 5)] })])
  const thumbsAt = await appendDirect(m.dataDir, [postThumbsRecord({ seq: second, thumbs: [thumb(CORE, 6), null], at: AT })])
  const altTwo = await appendDirect(m.dataDir, [postAltRecord({ seq: second, alt: [null, 'dois'], gap: 1, at: AT })])
  t.alike([thumbsAt, altTwo], [second + 1, second + 2])
  const feed = await m.call('feed.read', { limit: 20, alt: true })
  t.alike(feed.items.find((i) => i.seq === first).alt, ['um', null], 'live descriptions are read before the delete')
  t.alike(feed.items.find((i) => i.seq === second).alt, [null, 'dois'])

  const before = (await m.call('log.read')).entries.length
  const r = await m.call('post.delete', { to: m.publicKey + ':' + first })
  t.alike(r.deleted, [first], 'the answer names only the requested target')
  let log = await m.call('log.read')
  t.is(log.entries.length + log.invalid.length, before + 2, 'one append of two tombstones')
  const pair = log.entries.slice(-2).map((e) => e.record)
  t.alike(pair.map((x) => [x.type, x.seq]), [['delete', first], ['delete', altOne]])
  t.absent('media' in pair[1], 'the description tombstone carries no ranges')
  t.is(pair[0].at, pair[1].at, 'one at for the append')

  const mid = log.entries.length + log.invalid.length
  const r2 = await m.call('post.delete', { to: m.publicKey + ':' + second })
  t.alike(r2.deleted, [second])
  log = await m.call('log.read')
  t.is(log.entries.length + log.invalid.length, mid + 3, 'post, thumbnails and description')
  const trio = log.entries.slice(-3).map((e) => e.record)
  t.alike(trio.map((x) => [x.type, x.seq]), [['delete', second], ['delete', thumbsAt], ['delete', altTwo]], 'order: post, thumbnails, description')
  t.absent('media' in trio[2], 'the description tombstone carries no ranges')

  const repeat = await m.call('post.delete', { to: m.publicKey + ':' + second })
  t.is(repeat.changed, false, 'no live companion is left')
  const after = await m.call('feed.read', { limit: 20, alt: true })
  t.absent(after.items.some((i) => i.seq === first || i.seq === second))
  t.alike(m.session.internal, [], 'no internal error')
})

test('a repeat delete finishes a post-alt left live under a deleted post, and a later delete sweeps an orphan', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const orphanPost = await appendDirect(m.dataDir, [postRecord({ text: 'o', at: AT, media: [descriptor(CORE, 1)] })])
  const orphanAlt = await appendDirect(m.dataDir, [postAltRecord({ seq: orphanPost, alt: ['velho'], at: AT })])
  const half = await appendDirect(m.dataDir, [postRecord({ text: 'h', at: AT, media: [descriptor(CORE, 2)] })])
  const halfAlt = await appendDirect(m.dataDir, [postAltRecord({ seq: half, alt: ['meio'], at: AT })])
  // An older-style delete took both posts and left the descriptions live.
  await appendDirect(m.dataDir, [
    deleteRecord({ seq: orphanPost, at: AT, media: [{ core: CORE, start: 1, blocks: 1 }] }),
    deleteRecord({ seq: half, at: AT, media: [{ core: CORE, start: 2, blocks: 1 }] })
  ], true)
  const fresh = await m.call('post.create', { text: 'novo' })

  const r = await m.call('post.delete', { to: fresh.ref })
  t.is(r.changed, true)
  let log = await m.call('log.read')
  const tombs = log.entries.filter((e) => e.record.type === 'delete' && e.seq > fresh.seq)
  t.alike(tombs.map((e) => e.record.seq), [fresh.seq, orphanAlt, halfAlt], 'the post and both orphaned descriptions')
  t.ok(tombs.slice(1).every((e) => !('media' in e.record)), 'no ranges')

  const again = await m.call('post.delete', { to: m.publicKey + ':' + half })
  t.is(again.changed, false, 'nothing is left to tombstone')
  log = await m.call('log.read')
  t.is(log.entries.filter((e) => e.record.type === 'delete' && e.record.seq === halfAlt).length, 1, 'tombstoned once')
  t.alike(m.session.internal, [], 'no internal error')
})

test('a repeat delete tombstones a post-alt that an earlier append left live', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const post = await appendDirect(m.dataDir, [postRecord({ text: 'p', at: AT, media: [descriptor(CORE, 1)] })])
  const alt = await appendDirect(m.dataDir, [postAltRecord({ seq: post, alt: ['foto'], at: AT })])
  await appendDirect(m.dataDir, [deleteRecord({ seq: post, at: AT, media: [{ core: CORE, start: 1, blocks: 1 }] })])
  const again = await m.call('post.delete', { to: m.publicKey + ':' + post })
  t.is(again.changed, true)
  const last = (await m.call('log.read')).entries.slice(-1)[0].record
  t.alike([last.type, last.seq], ['delete', alt])
  t.is((await m.call('post.delete', { to: m.publicKey + ':' + post })).changed, false)
  t.alike(m.session.internal, [], 'no internal error')
})

test('feed.read of the node session returns alt only with the opt-in and only for a live, aligned description', async (t) => {
  const m = await member(t)
  await appendDirect(m.dataDir, [mediaCoreRecord({ key: CORE, at: AT })])
  const post = await appendDirect(m.dataDir, [postRecord({ text: 'duas', at: AT, media: [descriptor(CORE, 1), descriptor(CORE, 2)] })])
  await appendDirect(m.dataDir, [postAltRecord({ seq: post, alt: ['esquerda', null], at: AT })])
  const old = await appendDirect(m.dataDir, [postRecord({ text: 'antigo', at: AT, media: [descriptor(CORE, 3)] })])
  const plain = await m.call('feed.read', { limit: 20 })
  t.ok(plain.items.length >= 2 && plain.items.every((i) => !('alt' in i)), 'without the opt-in no item has alt')
  const feed = await m.call('feed.read', { limit: 20, alt: true })
  t.alike(feed.items.map((i) => i.seq), plain.items.map((i) => i.seq), 'same rows and order')
  t.alike(feed.items.find((i) => i.seq === post).alt, ['esquerda', null])
  t.absent('alt' in feed.items.find((i) => i.seq === old), 'a post without a description has none')
  t.alike(m.session.internal, [], 'no internal error')
})
