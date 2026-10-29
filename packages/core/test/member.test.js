'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert } = require('@varanda/core/lib/cert')
const { postRecord, profileRecords, memberCertRecord } = require('@varanda/core/lib/records')
const storeLib = require('../lib/store')
const member = require('../lib/member')
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
