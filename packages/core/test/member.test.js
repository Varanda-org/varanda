'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert } = require('@varanda/core/lib/cert')
const { postRecord, profileRecords, memberCertRecord, deleteRecord, followRecord } = require('@varanda/core/lib/records')
const storeLib = require('../lib/store')
const member = require('../lib/member')
const { foldFollowsFile } = require('../lib/follows-fold')
const { UsageError } = require('../lib/errors')
const { tmpDir } = require('./helpers/tmp')

const GENESIS_REQUIRED = 'grave o certificado de membro antes de publicar'

function association () {
  const kp = crypto.keyPair()
  return { kp, assocHex: b4a.toString(kp.publicKey, 'hex') }
}

async function rejectsWith (t, promise, message, code) {
  try {
    await promise
    t.fail('expected a rejection: ' + message)
  } catch (err) {
    t.is(err.message, message)
    t.is(err.code, code)
    if (code === 'USAGE') t.ok(err instanceof UsageError)
    t.ok(err instanceof Error)
  }
}

// A member data dir with an identity; with { cert: true } block 0 is written.
async function setup (t, { cert = false } = {}) {
  const dataDir = tmpDir(t)
  const { kp, assocHex } = association()
  const ctx = { dataDir, association: assocHex }
  const { publicKey } = await member.idCreate(ctx)
  let c = null
  if (cert) {
    c = createCert({ member: publicKey }, kp)
    t.alike(await member.certAdd(ctx, c), { seq: 0 })
  }
  return { ctx, dataDir, kp, assocHex, publicKey, cert: c }
}

test('deepEqual compares JSON values structurally', (t) => {
  const { deepEqual } = member
  t.ok(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), 'key order is ignored')
  t.ok(deepEqual({ a: [1, [2, { c: null }]] }, { a: [1, [2, { c: null }]] }), 'nested arrays')
  t.absent(deepEqual([1, 2], [2, 1]), 'array order matters')
  t.absent(deepEqual(null, {}), 'null vs {}')
  t.absent(deepEqual({}, null), '{} vs null')
  t.absent(deepEqual(1, '1'), '1 vs "1"')
  t.absent(deepEqual({ a: 1 }, { a: 1, b: 2 }), 'extra key')
  t.absent(deepEqual({ a: 1, b: undefined }, { a: 1, c: undefined }), 'different keys, same count')
  t.absent(deepEqual([], {}), 'array vs object')
  t.ok(deepEqual(true, true))
  t.absent(deepEqual(true, false))
  t.ok(deepEqual('x', 'x'))
  const withProto = JSON.parse('{"__proto__": {"x": 1}, "a": 1}')
  t.ok(deepEqual(withProto, JSON.parse('{"a": 1, "__proto__": {"x": 1}}')), '__proto__ key compared as data')
  t.absent(deepEqual(withProto, { a: 1 }), '__proto__ key is not ignored')
  t.absent(deepEqual(withProto, JSON.parse('{"__proto__": {"x": 2}, "a": 1}')))
})

test('idCreate and idShow', async (t) => {
  const dataDir = tmpDir(t)
  const { assocHex } = association()
  await rejectsWith(t, member.idCreate({ dataDir, association: null }), 'informe --association ou VARANDA_ASSOCIATION', 'USAGE')
  t.absent(fs.existsSync(path.join(dataDir, 'store')), 'fail fast: the store is not opened')
  await rejectsWith(t, member.idShow({ dataDir, association: null }), 'identidade não encontrada', undefined)

  const created = await member.idCreate({ dataDir, association: assocHex })
  t.ok(/^[0-9a-f]{64}$/.test(created.publicKey))
  t.is(created.association, assocHex)
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
  t.alike(config, { v: 1, role: 'member', association: assocHex })

  t.alike(await member.idCreate({ dataDir, association: null }), created, 'create again reads the config')
  t.alike(await member.idShow({ dataDir, association: null }), created)
  t.alike(await member.idShow({ dataDir, association: assocHex }), created)
  const other = association().assocHex
  await rejectsWith(t, member.idShow({ dataDir, association: other }), 'associação diferente da configurada', undefined)
  await rejectsWith(t, member.idCreate({ dataDir, association: other }), 'associação diferente da configurada', undefined)
  t.is(member.trustRoot({ dataDir, association: null }), assocHex)
})

test('certAdd', async (t) => {
  const { ctx, kp, publicKey } = await setup(t)
  await rejectsWith(t, member.postCreate(ctx, { text: 'oi' }), GENESIS_REQUIRED, undefined)

  const wrong = createCert({ member: publicKey }, crypto.keyPair())
  await rejectsWith(t, member.certAdd(ctx, wrong), 'certificado inválido (untrusted-association)', undefined)

  const c = createCert({ member: publicKey }, kp)
  t.alike(await member.certAdd(ctx, c), { seq: 0 })
  t.alike(await member.certAdd(ctx, c), { seq: 0 }, 'same cert twice')
  const reordered = {}
  for (const k of Object.keys(c).reverse()) reordered[k] = c[k]
  t.not(JSON.stringify(reordered), JSON.stringify(c))
  t.alike(await member.certAdd(ctx, reordered), { seq: 0 }, 'same cert with keys in another order')

  const different = createCert({ member: publicKey, date: '2026-01-01T00:00:00.000Z' }, kp)
  await rejectsWith(t, member.certAdd(ctx, different), 'certificado já gravado', undefined)

  const { entries } = await member.logRead(ctx, {})
  t.is(entries.length, 1)
  t.alike(entries[0].record, { type: 'member-cert', cert: c })
})

test('certAdd without identity', async (t) => {
  const dataDir = tmpDir(t)
  await rejectsWith(t, member.certAdd({ dataDir, association: null }, {}), 'identidade não encontrada', undefined)
})

test('profileSet, postCreate and postReply', async (t) => {
  const { ctx, publicKey } = await setup(t, { cert: true })
  t.alike(await member.profileSet(ctx, { name: 'Ana', bio: undefined }), { seq: 1 })
  t.alike(await member.postCreate(ctx, { text: 'olá' }), { seq: 2, ref: publicKey + ':2' })
  t.alike(await member.postReply(ctx, { to: { author: publicKey, seq: 2 }, text: 'resposta' }), { seq: 3, ref: publicKey + ':3' })
  await rejectsWith(t, member.postReply(ctx, { to: { author: publicKey, seq: 0 }, text: 'x' }), 'referência inválida', 'USAGE')
  try {
    await member.postCreate(ctx, { text: '' })
    t.fail('empty text accepted')
  } catch (err) {
    t.ok(err.message.startsWith('registro inválido: '))
  }
  const { key, entries } = await member.logRead(ctx)
  t.is(key, publicKey)
  t.alike(entries.map((e) => e.seq), [0, 1, 2, 3])
  t.alike(entries[1].record.name, 'Ana')
  t.alike(entries[1].record.bio, '')
  t.alike(entries[3].record.replyTo, { author: publicKey, seq: 2 })
})

// The core node writes no media cores, so it must never drop a photo it
// cannot re-send.
test('profileSet refuses an avatar and keeps an existing photo', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t, { cert: true })
  const avatar = { core: 'ab'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: 'e'.repeat(64), width: 512, height: 512 }
  await rejectsWith(t, member.profileSet(ctx, { name: 'Ana', avatar }), 'mídia disponível só na versão web', 'USAGE')
  const s = await storeLib.openStore(dataDir)
  try {
    const diary = await storeLib.openDiary(s)
    for (const r of profileRecords({ name: 'Ana', avatar })) await storeLib.appendRecord(diary, r)
  } finally {
    await s.close()
  }
  t.alike((await member.profileRead(ctx, { authors: [publicKey] })).profiles[0].avatar, avatar)
  await rejectsWith(t, member.profileSet(ctx, { name: 'Bia' }), member.PROFILE_PHOTO_WEB_ONLY, 'USAGE')
  t.is((await member.logRead(ctx)).entries.length, 3, 'nothing appended')
  t.alike(await member.profileSet(ctx, { name: 'Bia', avatar: null }), { seq: 3 })
  const last = (await member.logRead(ctx)).entries[3].record
  t.alike(Object.keys(last).sort(), ['at', 'bio', 'name', 'type'])
  t.alike((await member.profileRead(ctx, { authors: [publicKey] })).profiles[0], { author: publicKey, name: 'Bia', bio: '', avatar: null, username: null })
  t.alike(await member.profileSet(ctx, { name: 'Cris' }), { seq: 4 }, 'no photo left: a plain change is allowed')
})

test('postDelete and profileDelete write a tombstone of the own block only', async (t) => {
  const { ctx, publicKey } = await setup(t, { cert: true })
  const bare = await setup(t)
  await rejectsWith(t, member.postDelete(bare.ctx, { to: { author: bare.publicKey, seq: 1 } }), GENESIS_REQUIRED, undefined)
  await rejectsWith(t, member.profileDelete(bare.ctx, { to: { author: 'ab'.repeat(32), seq: 1 } }), GENESIS_REQUIRED, undefined)
  const { seq } = await member.postCreate(ctx, { text: 'olá' })
  await rejectsWith(t, member.postDelete(ctx, { to: { author: 'ab'.repeat(32), seq } }), 'referência inválida', 'USAGE')
  await rejectsWith(t, member.profileDelete(ctx, { to: { author: publicKey, seq } }), 'o registro não é um perfil', 'USAGE')
  const r = await member.postDelete(ctx, { to: { author: publicKey, seq } })
  t.alike(r, { seq: seq + 1, ref: publicKey + ':' + (seq + 1), changed: true, deleted: [seq] })
  const { entries } = await member.logRead(ctx)
  t.alike(entries[seq], { seq, record: null, deleted: true })
  t.alike(Object.keys(entries[seq + 1].record).sort(), ['at', 'seq', 'type'])
  await rejectsWith(t, member.postDelete(ctx, { to: { author: publicKey, seq: seq + 1 } }), 'não é possível apagar este registro', 'USAGE')
  t.alike(await member.postDelete(ctx, { to: { author: publicKey, seq } }), { ...r, changed: false })
})

// The own diary as stored, read without withIdentity (which reconciles).
async function ownBlocks (dataDir, seqs) {
  const s = await storeLib.openStore(dataDir)
  try {
    const diary = await storeLib.openDiary(s)
    const has = []
    for (const seq of seqs) has.push(await diary.has(seq))
    return { has, fork: diary.fork, length: diary.length }
  } finally {
    await s.close()
  }
}

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

test('postDelete clears the deleted block and keeps the hole', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t, { cert: true })
  const { seq } = await member.postCreate(ctx, { text: 'apagar' })
  await member.postCreate(ctx, { text: 'fica' })
  const r = await member.postDelete(ctx, { to: { author: publicKey, seq } })
  t.alike(r, { seq: 3, ref: publicKey + ':3', changed: true, deleted: [seq] })
  t.alike(await ownBlocks(dataDir, [0, seq, 2, 3]), { has: [true, false, true, true], fork: 0, length: 4 })
  const { entries } = await member.logRead(ctx)
  t.is(entries.length, 4, 'readAll goes past the cleared block')
  t.alike(entries[seq], { seq, record: null, deleted: true })
  t.is(entries[2].record.text, 'fica')
  t.alike(await member.postDelete(ctx, { to: { author: publicKey, seq } }), { ...r, changed: false }, 'a cleared target answers with its tombstone')
  await rejectsWith(t, member.postDelete(ctx, { to: { author: publicKey, seq: 4 } }), 'referência inválida', 'USAGE')
  t.alike(await member.postCreate(ctx, { text: 'depois' }), { seq: 4, ref: publicKey + ':4' })
  t.alike(await ownBlocks(dataDir, [seq, 4]), { has: [false, true], fork: 0, length: 5 }, 'the hole survives a reopen')
  t.alike((await member.feedRead(ctx)).items.map((i) => i.text).sort(), ['depois', 'fica'])
})

test('profileDelete clears both blocks of a compat pair', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t, { cert: true })
  const avatar = { core: 'ab'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: 'e'.repeat(64), width: 512, height: 512 }
  await member.withIdentity(ctx, ({ diary }) => storeLib.appendRecords(diary, profileRecords({ name: 'Ana', avatar })))
  const r = await member.profileDelete(ctx, { to: { author: publicKey, seq: 2 } })
  t.alike(r, { seq: 4, ref: publicKey + ':4', changed: true, deleted: [1, 2] })
  t.alike((await ownBlocks(dataDir, [1, 2, 3, 4])).has, [false, false, true, true])
  t.alike(await member.profileDelete(ctx, { to: { author: publicKey, seq: 1 } }), { ...r, changed: false })
  t.alike(await member.profileDelete(ctx, { to: { author: publicKey, seq: 2 } }), { ...r, changed: false })
  t.alike(await member.postDelete(ctx, { to: { author: publicKey, seq: 2 } }), { seq: 4, ref: publicKey + ':4', changed: false, deleted: [2] })
})

test('two separate deletions of adjacent cleared profiles are never reported as one pair', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t, { cert: true })
  t.alike(await member.profileSet(ctx, { name: 'Ana' }), { seq: 1 })
  t.alike(await member.profileSet(ctx, { name: 'Bia' }), { seq: 2 })
  const first = await member.profileDelete(ctx, { to: { author: publicKey, seq: 1 } })
  t.alike(first, { seq: 3, ref: publicKey + ':3', changed: true, deleted: [1] })
  // A separate delete never shares the first one's `at`.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await member.profileDelete(ctx, { to: { author: publicKey, seq: 2 } })
  t.alike(second, { seq: 4, ref: publicKey + ':4', changed: true, deleted: [2] })
  t.alike((await ownBlocks(dataDir, [1, 2, 3, 4])).has, [false, false, true, true], 'fixture: both targets are cleared')
  t.alike(await member.profileDelete(ctx, { to: { author: publicKey, seq: 1 } }), { ...first, changed: false })
  t.alike(await member.profileDelete(ctx, { to: { author: publicKey, seq: 2 } }), { ...second, changed: false })
})

test('VARANDA_NO_CLEAR=1 keeps the bytes; the next open clears them', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t, { cert: true })
  const { seq } = await member.postCreate(ctx, { text: 'apagar' })
  const restore = noClear(t)
  const r = await member.postDelete(ctx, { to: { author: publicKey, seq } })
  t.alike(r, { seq: 2, ref: publicKey + ':2', changed: true, deleted: [seq] })
  t.alike(await ownBlocks(dataDir, [seq, 2]), { has: [true, true], fork: 0, length: 3 }, 'only the tombstone is written')
  const { entries } = await member.logRead(ctx)
  t.alike(entries[seq], { seq, record: null, deleted: true }, 'readers hide it all the same')
  t.alike((await ownBlocks(dataDir, [seq])).has, [true], 'an open under the kill switch clears nothing')
  t.alike(await member.postDelete(ctx, { to: { author: publicKey, seq } }), { ...r, changed: false })
  restore()
  t.alike((await member.logRead(ctx)).entries[seq], { seq, record: null, deleted: true })
  t.alike(await ownBlocks(dataDir, [0, seq, 2]), { has: [true, false, true], fork: 0, length: 3 }, 'the skipped clear is finished at open')
  t.alike(await member.postCreate(ctx, { text: 'depois' }), { seq: 3, ref: publicKey + ':3' })
})

test('a clear that skips an unreadable block is retried at the next open', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t, { cert: true })
  const { seq } = await member.postCreate(ctx, { text: 'apagar' })
  const original = storeLib.openStore
  let reads = 0
  // The second read of the target (the one clearDeleted makes after readRaw)
  // fails once; clearDeleted skips it without throwing.
  storeLib.openStore = async (...args) => {
    const s = await original(...args)
    const get = s.get.bind(s)
    s.get = (opts) => {
      const core = get(opts)
      if (opts && opts.name === 'diary') {
        const read = core.get.bind(core)
        core.get = (i, o) => {
          if (i === seq && ++reads === 2) return Promise.reject(new Error('read failed'))
          return read(i, o)
        }
      }
      return core
    }
    return s
  }
  t.teardown(() => { storeLib.openStore = original }, { force: true })
  t.is((await member.postDelete(ctx, { to: { author: publicKey, seq } })).changed, true)
  t.ok(reads >= 2, 'fixture: the failing read happened')
  t.alike((await ownBlocks(dataDir, [seq])).has, [true], 'the clear skipped the block')
  await member.logRead(ctx)
  t.alike((await ownBlocks(dataDir, [seq])).has, [false], 'the next open finishes it')
})

test('ctx.noClear keeps the bytes', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t, { cert: true })
  const { seq } = await member.postCreate(ctx, { text: 'apagar' })
  await member.postDelete({ ...ctx, noClear: true }, { to: { author: publicKey, seq } })
  t.alike((await ownBlocks(dataDir, [seq])).has, [true])
})

test('follows', async (t) => {
  const { ctx, publicKey } = await setup(t)
  const a = 'ab'.repeat(32)
  const b = 'cd'.repeat(32)
  t.alike(await member.followList(ctx), { follows: [] })
  await rejectsWith(t, member.followAdd(ctx, publicKey), 'não é possível seguir a própria chave', undefined)
  t.alike(await member.followAdd(ctx, b), { follows: [b], changed: true })
  t.alike(await member.followAdd(ctx, a), { follows: [a, b], changed: true })
  t.alike(await member.followAdd(ctx, a), { follows: [a, b], changed: false })
  t.alike(await member.followRemove(ctx, b), { follows: [a], changed: true })
  t.alike(await member.followRemove(ctx, b), { follows: [a], changed: false })
  t.alike(await member.followList(ctx), { follows: [a] })
  await rejectsWith(t, member.followList({ dataDir: tmpDir(t), association: null }), 'identidade não encontrada', undefined)
})

// Another device of the member appends `follow` records to the own diary; this
// node sees them once the diary has synced (#137).
async function otherDevice (ctx, ...records) {
  await member.withIdentity(ctx, async ({ diary }) => { for (const r of records) await storeLib.appendRecord(diary, r) })
}

test('follows from another device fold into follows.json', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t, { cert: true })
  const a = 'ab'.repeat(32)
  const b = 'cd'.repeat(32)
  const c = 'ef'.repeat(32)
  const file = () => storeLib.readFollows(dataDir)
  await member.followAdd(ctx, a)
  await otherDevice(ctx, followRecord({ key: b, on: true }), followRecord({ key: c, on: true }))
  t.alike(await member.followList(ctx), { follows: [a, b, c] }, 'follows made elsewhere show in follow list')
  t.alike(file(), [a, b, c], 'and are written to follows.json')
  await otherDevice(ctx, followRecord({ key: a, on: false }), followRecord({ key: b, on: false }))
  t.alike(await member.followList(ctx), { follows: [c] }, 'unfollows made elsewhere apply')
  t.alike(await member.followList(ctx), { follows: [c] }, 'folding again changes nothing')
  t.alike(await member.followAdd(ctx, c), { follows: [c], changed: false }, 'already followed through the diary')
  t.alike(await member.followAdd(ctx, a), { follows: [a, c], changed: true }, 'following again after an unfollow made elsewhere')
  await otherDevice(ctx, followRecord({ key: publicKey, on: true }))
  t.alike(await member.followList(ctx), { follows: [a, c] }, 'the own key is ignored')
})

test('a follow from before follow records stays and is never published by the fold', async (t) => {
  const { ctx, dataDir } = await setup(t, { cert: true })
  const old = 'aa'.repeat(32)
  const b = 'cd'.repeat(32)
  storeLib.writeFollows(dataDir, [old])
  t.alike(await member.followList(ctx), { follows: [old] }, 'a diary with no follow record leaves the list alone')
  await otherDevice(ctx, followRecord({ key: b, on: true }))
  t.alike(await member.followList(ctx), { follows: [old, b] }, 'the old follow stays beside the new one')
  const { entries } = await member.logRead(ctx, { author: (await member.idShow(ctx)).publicKey })
  t.absent(entries.some((e) => e.record && e.record.type === 'follow' && e.record.key === old), 'no follow record was appended for it')
  await otherDevice(ctx, followRecord({ key: old, on: false }))
  t.alike(await member.followList(ctx), { follows: [b] }, 'a record for it takes over')
})

test('follow records that are invalid or replayed do not change the list', async (t) => {
  const { ctx, dataDir } = await setup(t, { cert: true })
  const a = 'ab'.repeat(32)
  await otherDevice(ctx, followRecord({ key: a, on: true }), followRecord({ key: a, on: true }))
  t.alike(await member.followList(ctx), { follows: [a] }, 'a repeated record is one follow')
  await member.withIdentity(ctx, async ({ diary }) => {
    try { await storeLib.appendRecord(diary, { type: 'follow', key: 'zz', on: true, at: new Date().toISOString() }) } catch {}
  })
  t.alike(await member.followList(ctx), { follows: [a] }, 'an invalid record is ignored')
  fs.writeFileSync(path.join(dataDir, 'follows.json'), JSON.stringify({ v: 1, follows: [a, 123, 'XYZ', a.toUpperCase()] }))
  t.alike(await member.followList(ctx), { follows: [a] }, 'entries that are not keys and duplicates drop out once the diary has follow records')
})

test('the last record by seq wins even when it has an older at', async (t) => {
  const { ctx } = await setup(t, { cert: true })
  const a = 'ab'.repeat(32)
  await otherDevice(ctx,
    followRecord({ key: a, on: true, at: '2024-06-01T00:00:00.000Z' }),
    followRecord({ key: a, on: false, at: '2020-01-01T00:00:00.000Z' }))
  t.alike(await member.followList(ctx), { follows: [] }, 'the later seq unfollows although its at is older')
  await otherDevice(ctx, followRecord({ key: a, on: true, at: '2019-01-01T00:00:00.000Z' }))
  t.alike(await member.followList(ctx), { follows: [a] }, 'and the later seq follows again')
})

test('a diary read with a hole leaves follows.json as it is', async (t) => {
  const { ctx, dataDir } = await setup(t, { cert: true })
  const x = 'ab'.repeat(32)
  const y = 'cd'.repeat(32)
  await otherDevice(ctx, followRecord({ key: x, on: true }), followRecord({ key: y, on: true }))
  t.alike(await member.followList(ctx), { follows: [x, y] })
  await member.withIdentity(ctx, async ({ diary }) => { await diary.clear(diary.length - 1, diary.length) })
  const view = await member.withIdentity(ctx, async ({ diary }) => ({ length: diary.length, contiguous: diary.contiguousLength }))
  t.ok(view.contiguous < view.length, 'fixture: the diary has a hole')
  t.alike(await member.followRemove(ctx, x), { follows: [y], changed: true }, 'a local unfollow after the hole')
  t.alike(await member.followList(ctx), { follows: [y] }, 'the older record before the hole does not bring it back')
  t.alike(storeLib.readFollows(dataDir), [y])
})

test('follow list answers from follows.json while the data dir is locked', async (t) => {
  const { ctx, dataDir } = await setup(t, { cert: true })
  const a = 'ab'.repeat(32)
  await member.followAdd(ctx, a)
  const held = await storeLib.openStore(dataDir)
  try {
    t.alike(await member.followList(ctx), { follows: [a] })
    await rejectsWith(t, member.followList({ dataDir: tmpDir(t), association: null }), 'identidade não encontrada', undefined)
  } finally {
    await held.close()
  }
})

test('the fold keeps the keys with a record before the old ones when it cuts at max', async (t) => {
  const dataDir = tmpDir(t)
  const own = 'ee'.repeat(32)
  const old = 'aa'.repeat(32)
  const b = 'bb'.repeat(32)
  const c = 'cc'.repeat(32)
  storeLib.writeFollows(dataDir, [old])
  const entries = [b, c].map((key, i) => ({ seq: i + 1, record: followRecord({ key, on: true }) }))
  const result = foldFollowsFile(dataDir, entries, own, 2, entries.length)
  t.alike(result.follows, [b, c], 'the old follow gives way')
  storeLib.writeFollows(dataDir, [old])
  const kept = foldFollowsFile(dataDir, entries, own, 3, entries.length)
  t.alike(kept.follows, [old, b, c], 'it stays when there is room')
  storeLib.writeFollows(dataDir, [old])
  t.alike(foldFollowsFile(dataDir, entries, own, 3, entries.length + 1).changed, false, 'a hole leaves the file alone')
})

test('logRead with an author', async (t) => {
  const { ctx, publicKey } = await setup(t, { cert: true })
  const own = await member.logRead(ctx, { author: publicKey })
  t.is(own.key, publicKey)
  t.is(own.entries.length, 1)
  await rejectsWith(t, member.logRead(ctx, { author: 'ef'.repeat(32) }), 'sem dados locais para este diário', undefined)
  await rejectsWith(t, member.logRead(ctx, { author: 'zz' }), 'sem dados locais para este diário', undefined)
})

test('feedRead reports warnings through onWarn', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t, { cert: true })
  await member.postCreate(ctx, { text: 'agora' })
  await member.withIdentity(ctx, ({ diary }) => storeLib.appendRecord(diary, postRecord({ text: 'depois', at: '2999-01-01T00:00:00.000Z' })))
  const missing = 'cd'.repeat(32)
  fs.writeFileSync(path.join(dataDir, 'follows.json'), JSON.stringify({ v: 1, follows: [123, missing, publicKey] }))

  const lines = []
  const result = await member.feedRead(ctx, { onWarn: (line) => lines.push(line) })
  t.alike(lines, [
    'aviso: entrada inválida em follows.json ignorada (123)',
    'aviso: diário cdcdcdcd ignorado (no-cert)',
    'aviso: publicação ' + publicKey + ':2 ignorada (future)'
  ])
  t.is(result.items.length, 1)
  t.is(result.items[0].text, 'agora')
  t.is(result.items[0].seq, 1)
  t.alike(result.skipped, [{ key: missing, reason: 'no-cert' }])
  t.alike(result.future, [publicKey + ':2'])
  t.alike(result.incomplete, [], 'the missing follow stays no-cert, not incomplete')

  const quiet = await member.feedRead(ctx)
  t.alike(quiet, result, 'onWarn is optional')
  await member.postCreate(ctx, { text: 'mais' })
  const limited = await member.feedRead(ctx, { limit: 1 })
  t.alike(limited.items.map((i) => i.text), ['mais'])
})

// A 6-block diary (certificate, profile, four posts) in its own store, and a
// helper that replicates chosen blocks of it in-process into the member's
// store: the follow ends up with holes, as after an interrupted sync.
async function sourceDiary (t, kp) {
  const srcDir = tmpDir(t)
  const src = await storeLib.openStore(srcDir)
  try {
    const core = src.get({ name: 'diary', valueEncoding: 'json' })
    await core.ready()
    const key = b4a.toString(core.key, 'hex')
    await core.append(memberCertRecord(createCert({ member: key }, kp)))
    await core.append(profileRecords({ name: 'Fonte', bio: '' })[0])
    for (let i = 1; i <= 4; i++) {
      await core.append(postRecord({ text: 'post ' + i, at: '2020-01-0' + i + 'T00:00:00.000Z' }))
    }
    return { srcDir, key }
  } finally {
    await src.close()
  }
}

async function fetchBlocks ({ srcDir, key }, dataDir, indexes) {
  const src = await storeLib.openStore(srcDir)
  const dst = await storeLib.openStore(dataDir)
  try {
    const s1 = src.replicate(true)
    const s2 = dst.replicate(false)
    s1.pipe(s2).pipe(s1)
    const core = src.get({ name: 'diary', valueEncoding: 'json' })
    await core.ready()
    const replica = dst.get({ key: core.key, valueEncoding: 'json' })
    await replica.ready()
    for (const i of indexes) await replica.get(i)
    await replica.update()
    s1.destroy()
    s2.destroy()
    return { length: replica.length, contiguousLength: replica.contiguousLength }
  } finally {
    await dst.close()
    await src.close()
  }
}

test('feedRead reports a shown diary with holes as incomplete', async (t) => {
  const { ctx, dataDir, kp } = await setup(t, { cert: true })
  const diary = await sourceDiary(t, kp)
  const partial = await fetchBlocks(diary, dataDir, [0, 1, 2])
  t.alike(partial, { length: 6, contiguousLength: 3 }, 'fixture: blocks 3-5 are missing')
  await member.followAdd(ctx, diary.key)

  const lines = []
  const half = await member.feedRead(ctx, { onWarn: (line) => lines.push(line) })
  t.alike(half.incomplete, [diary.key])
  t.alike(half.skipped, [])
  t.alike(half.items.map((i) => i.text), ['post 1'], 'only the block fetched so far')
  t.alike(lines, [], 'no new warning line')

  const full = await fetchBlocks(diary, dataDir, [3, 4, 5])
  t.alike(full, { length: 6, contiguousLength: 6 })
  const done = await member.feedRead(ctx)
  t.alike(done.incomplete, [])
  t.alike(done.items.map((i) => i.text), ['post 1', 'post 2', 'post 3', 'post 4'])
})

test('feedRead does not report a cleared deleted block as a hole', async (t) => {
  const { ctx, dataDir, kp } = await setup(t, { cert: true })
  const diary = await sourceDiary(t, kp)
  const src = await storeLib.openStore(diary.srcDir)
  try {
    const core = src.get({ name: 'diary', valueEncoding: 'json' })
    await core.ready()
    await core.append(deleteRecord({ seq: 3 }))
  } finally {
    await src.close()
  }
  t.alike(await fetchBlocks(diary, dataDir, [0, 1, 2, 3, 4, 5, 6]), { length: 7, contiguousLength: 7 })
  const dst = await storeLib.openStore(dataDir)
  try {
    const replica = await storeLib.openReplica(dst, diary.key)
    await replica.clear(3, 4)
    t.is(replica.contiguousLength, 3, 'fixture: the deleted block is cleared')
  } finally {
    await dst.close()
  }
  await member.followAdd(ctx, diary.key)
  const feed = await member.feedRead(ctx)
  t.alike(feed.incomplete, [])
  t.alike(feed.items.map((i) => i.text), ['post 1', 'post 3', 'post 4'])
})

test('storeOptions reach openStore', async (t) => {
  const dataDir = tmpDir(t)
  const { assocHex } = association()
  const storeOptions = { marker: true }
  const original = storeLib.openStore
  const calls = []
  storeLib.openStore = (dir, opts) => {
    calls.push([dir, opts])
    return original(dir)
  }
  t.teardown(() => { storeLib.openStore = original }, { force: true })
  const ctx = { dataDir, association: assocHex, storeOptions }
  const { publicKey } = await member.idCreate(ctx)
  await member.idShow(ctx)
  await member.logRead(ctx, { author: publicKey })
  t.is(calls.length, 3)
  for (const [dir, opts] of calls) {
    t.is(dir, dataDir)
    t.is(opts, storeOptions)
  }
  calls.length = 0
  await member.idShow({ dataDir, association: null })
  t.alike(calls, [[dataDir, undefined]], 'no storeOptions passes undefined')
})

test('core post writers keep text previews and refuse thumbnails before opening', async (t) => {
  const { ctx, publicKey } = await setup(t, { cert: true })
  const preview = { url: 'https://example.org/post', host: 'example.org', title: 'Título', desc: 'Descrição', image: null }
  for (const method of ['postCreate', 'postReply', 'postQuote']) {
    const args = { text: 'link', to: { author: publicKey, seq: 1 }, preview }
    const sent = await member[method](ctx, args)
    t.alike((await member.logRead(ctx)).entries.find(e => e.seq === sent.seq).record.preview, preview)
    await rejectsWith(t, member[method]({}, { ...args, preview: { ...preview, image: {} } }), 'mídia disponível só na versão web', 'USAGE')
  }
  await rejectsWith(t, member.groupPost({}, { group: publicKey, text: 'link', card: { ...preview, image: {} } }), 'mídia disponível só na versão web', 'USAGE')
})

test('deleting a preview post lists its thumbnail in the tombstone', async (t) => {
  const { ctx, publicKey } = await setup(t, { cert: true })
  const image = { core: 'ab'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 10, sha256: 'cd'.repeat(32), width: 4, height: 4 }
  const preview = { url: 'https://example.org/post', host: 'example.org', title: 'Título', desc: 'Descrição', image: null }
  preview.image = image
  await member.withIdentity(ctx, async ({ diary }) => {
    await storeLib.appendRecord(diary, { type: 'media-core', key: image.core, at: new Date().toISOString() })
    await storeLib.appendRecord(diary, postRecord({ text: 'link', preview }))
  })
  const result = await member.postDelete(ctx, { to: { author: publicKey, seq: 2 } })
  t.alike((await member.logRead(ctx)).entries.find(e => e.seq === result.seq).record.media, [{ core: image.core, start: 1, blocks: 1 }])
})

test('deleting a shared post tombstones its live covers with their ranges', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t, { cert: true })
  const { postShareRecord, postCoverRecord } = require('@varanda/core/lib/records')
  const core = 'ab'.repeat(32)
  const cover = (start) => ({ core, mime: 'image/jpeg', start, blocks: 1, bytes: 10, sha256: 'cd'.repeat(32), width: 4, height: 4 })
  await member.withIdentity(ctx, async ({ diary }) => {
    await storeLib.appendRecord(diary, { type: 'media-core', key: core, at: new Date().toISOString() })
    await storeLib.appendRecord(diary, postRecord({ text: 'pública' }))
    await storeLib.appendRecord(diary, postShareRecord({ seq: 2 }))
    await storeLib.appendRecord(diary, postCoverRecord({ seq: 2, image: cover(1) }))
    await storeLib.appendRecord(diary, deleteRecord({ seq: 4 }))
    await storeLib.appendRecord(diary, postCoverRecord({ seq: 2, image: cover(2) }))
    await storeLib.appendRecord(diary, postRecord({ text: 'outra' }))
    await storeLib.appendRecord(diary, postCoverRecord({ seq: 7, image: cover(3) }))
  })
  const r = await member.postDelete(ctx, { to: { author: publicKey, seq: 2 } })
  t.alike(r, { seq: 10, ref: publicKey + ':10', changed: true, deleted: [2] }, 'the answer still names the post only')
  const { entries } = await member.logRead(ctx)
  const tombs = entries.slice(9).map((e) => e.record)
  t.alike(tombs.map((x) => x.seq), [2, 6], 'the post and its one live cover, not the other post\'s')
  t.is(tombs[0].media, undefined, 'a post without media frees nothing')
  t.alike(tombs[1].media, [{ core, start: 2, blocks: 1 }], 'the cover tombstone carries its range')
  t.alike((await ownBlocks(dataDir, [2, 6, 8])).has, [false, false, true], 'the cover block is cleared, the other post\'s is kept')
  t.alike(await member.postDelete(ctx, { to: { author: publicKey, seq: 2 } }), { seq: 9, ref: publicKey + ':9', changed: false, deleted: [2] }, 'a repeat writes nothing and answers the post\'s tombstone')
})

test('a repeat postDelete of a cleared post tombstones the covers an older writer left live', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t, { cert: true })
  const { postShareRecord, postCoverRecord } = require('@varanda/core/lib/records')
  const core = 'ab'.repeat(32)
  const image = { core, mime: 'image/jpeg', start: 1, blocks: 1, bytes: 10, sha256: 'cd'.repeat(32), width: 4, height: 4 }
  await member.withIdentity(ctx, async ({ diary }) => {
    await storeLib.appendRecord(diary, { type: 'media-core', key: core, at: new Date().toISOString() })
    await storeLib.appendRecord(diary, postRecord({ text: 'pública' }))
    await storeLib.appendRecord(diary, postShareRecord({ seq: 2 }))
    await storeLib.appendRecord(diary, postCoverRecord({ seq: 2, image }))
    await storeLib.appendRecord(diary, deleteRecord({ seq: 2 }))
  })
  const s = await storeLib.openStore(dataDir)
  try {
    const diary = await storeLib.openDiary(s)
    await diary.clear(2, 3)
  } finally {
    await s.close()
  }
  const r = await member.postDelete(ctx, { to: { author: publicKey, seq: 2 } })
  t.alike(r, { seq: 6, ref: publicKey + ':6', changed: true, deleted: [2] })
  const tomb = (await member.logRead(ctx)).entries[6].record
  t.alike([tomb.type, tomb.seq, tomb.media], ['delete', 4, [{ core, start: 1, blocks: 1 }]], 'the leftover cover with its range')
  t.alike((await ownBlocks(dataDir, [4])).has, [false], 'the cover block is cleared')
  t.alike(await member.postDelete(ctx, { to: { author: publicKey, seq: 2 } }), { seq: 5, ref: publicKey + ':5', changed: false, deleted: [2] }, 'with no cover left the repeat writes nothing')
})

test('postDelete of a 10-photo post with many live covers fits one append; repeats finish the covers oldest first', async (t) => {
  const { ctx, publicKey } = await setup(t, { cert: true })
  const { postShareRecord, postCoverRecord } = require('@varanda/core/lib/records')
  const core = 'ab'.repeat(32)
  const image = (start) => ({ core, mime: 'image/jpeg', start, blocks: 1, bytes: 10, sha256: 'cd'.repeat(32), width: 4, height: 4 })
  // 1 media-core, 2 the post (10 photos: 3 tombstones), 3 its share, 4 to
  // 17 fourteen live covers another writer left.
  await member.withIdentity(ctx, async ({ diary }) => {
    await storeLib.appendRecord(diary, { type: 'media-core', key: core, at: new Date().toISOString() })
    await storeLib.appendRecord(diary, postRecord({ text: 'dez fotos', media: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(image) }))
    await storeLib.appendRecord(diary, postShareRecord({ seq: 2 }))
    for (let i = 0; i < 14; i++) await storeLib.appendRecord(diary, postCoverRecord({ seq: 2, image: image(11 + i) }))
  })
  const to = { author: publicKey, seq: 2 }
  const tombsFrom = async (from) => (await member.logRead(ctx)).entries.filter((e) => e.seq >= from).map((e) => [e.record.type, e.record.seq])
  t.alike(await member.postDelete(ctx, { to }), { seq: 25, ref: publicKey + ':25', changed: true, deleted: [2] }, 'one append of 8')
  const first = await tombsFrom(18)
  t.alike(first, [['delete', 2], ['delete', 2], ['delete', 2], ['delete', 4], ['delete', 5], ['delete', 6], ['delete', 7], ['delete', 8]], 'the post\'s three tombstones, then the oldest covers in the room left')
  const ranges = (await member.logRead(ctx)).entries.filter((e) => e.seq >= 18 && e.seq <= 20).flatMap((e) => e.record.media.map((m) => m.start))
  t.alike(ranges.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'every photo range freed by the post\'s own tombstones')

  t.alike(await member.postDelete(ctx, { to }), { seq: 33, ref: publicKey + ':33', changed: true, deleted: [2] }, 'a repeat takes at most 8 leftover covers')
  t.alike((await tombsFrom(26)).map(([, seq]) => seq), [9, 10, 11, 12, 13, 14, 15, 16], 'oldest first')
  t.alike(await member.postDelete(ctx, { to }), { seq: 34, ref: publicKey + ':34', changed: true, deleted: [2] }, 'the next repeat finishes')
  const last = (await member.logRead(ctx)).entries.find((e) => e.seq === 34).record
  t.alike([last.seq, last.media], [17, [{ core, start: 24, blocks: 1 }]], 'the newest cover, with its range')
  t.alike(await member.postDelete(ctx, { to }), { seq: 20, ref: publicKey + ':20', changed: false, deleted: [2] }, 'nothing left: the post\'s tombstone answers')
})
