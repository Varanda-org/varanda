'use strict'

// post.delete and profile.delete of the node session (lib/session.js)
// through a real dispatcher + client pair.
const test = require('brittle')
const path = require('node:path')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure } = require('./helpers/net')
const { initAssociation, issueCertificate } = require('../lib/assoc')
const storeLib = require('../lib/store')
const { profileRecord, profileRecords, postRecord, mediaCoreRecord, deleteRecord } = require('../lib/records')

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
