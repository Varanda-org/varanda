'use strict'

// The core node's Conversas pieces that need no engine: the seed file that
// stands in for the passkey PRF, the dm-key in the diary, the diary signer
// handed to the DM engine and the page delegate's actor box.
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const crypto = require('hypercore-crypto')
const { createCert } = require('@varanda/core/lib/cert')
const { followRecord, memberCertRecord } = require('../lib/records')
const { isDiaryOfSigner } = require('../lib/diary-signer')
const { verifyActorBox } = require('../lib/page-secrets')
const storeLib = require('../lib/store')
const member = require('../lib/member')
const { UsageError } = require('../lib/errors')
const { tmpDir } = require('./helpers/tmp')

function seedFile (dataDir) {
  return path.join(dataDir, 'private', 'dm-seed.json')
}

function boxHex () {
  const pk = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const sk = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_keypair(pk, sk)
  return b4a.toString(pk, 'hex')
}

async function setup (t, { cert = true } = {}) {
  const dataDir = tmpDir(t)
  const kp = crypto.keyPair()
  const ctx = { dataDir, association: b4a.toString(kp.publicKey, 'hex') }
  const { publicKey } = await member.idCreate(ctx)
  if (cert) await member.certAdd(ctx, createCert({ member: publicKey }, kp))
  return { ctx, dataDir, publicKey }
}

async function rejects (t, promise, message, Kind = Error) {
  try {
    await promise
    t.fail('expected a rejection: ' + message)
  } catch (err) {
    t.is(err.message, message)
    t.ok(err instanceof Kind)
  }
}

test('dm seed: created once in private/dm-seed.json (0600, dir 0700), read back unchanged', (t) => {
  const dataDir = tmpDir(t)
  t.is(storeLib.readDmSeed(dataDir), null, 'absent before')
  t.absent(fs.existsSync(path.join(dataDir, 'private')), 'a read creates nothing')
  const a = storeLib.ensureDmSeed(dataDir)
  t.is(a.byteLength, 32)
  const file = seedFile(dataDir)
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'file 0600')
  t.is(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, 'dir 0700')
  const before = fs.readFileSync(file, 'utf8')
  t.alike(JSON.parse(before), { v: 1, seed: b4a.toString(a, 'hex') })
  t.alike(storeLib.ensureDmSeed(dataDir), a, 'second call returns the same seed')
  t.alike(storeLib.readDmSeed(dataDir), a)
  t.is(fs.readFileSync(file, 'utf8'), before, 'file unchanged')
  t.alike(fs.readdirSync(path.dirname(file)), ['dm-seed.json'], 'no temp file left')
  t.unlike(storeLib.ensureDmSeed(tmpDir(t)), a, 'another data dir has its own seed')
})

test('dm seed: an empty, malformed or wrong-shape file is refused, never regenerated, and the error carries no bytes', (t) => {
  const dataDir = tmpDir(t)
  const good = b4a.toString(storeLib.ensureDmSeed(dataDir), 'hex')
  const file = seedFile(dataDir)
  const cases = [
    '',
    'not json{',
    'null',
    '[]',
    JSON.stringify({ v: 2, seed: good }),
    JSON.stringify({ v: 1, seed: good.slice(2) }),
    JSON.stringify({ v: 1, seed: good.toUpperCase() }),
    JSON.stringify({ v: 1, seed: good, extra: 1 }),
    JSON.stringify({ v: 1 })
  ]
  for (const raw of cases) {
    fs.writeFileSync(file, raw)
    for (const fn of [storeLib.readDmSeed, storeLib.ensureDmSeed]) {
      try {
        fn(dataDir)
        t.fail('accepted ' + JSON.stringify(raw))
      } catch (err) {
        t.is(err.code, 'DM_SEED_INVALID', JSON.stringify(raw))
        t.absent(err.message.includes(good.slice(0, 16)) || err.message.includes(good.slice(-16).toUpperCase()), 'no seed bytes in the error')
      }
    }
    t.is(fs.readFileSync(file, 'utf8'), raw, 'file left as it is')
  }
})

test('dm seed: a symlinked file or private dir is refused; a non-directory private is refused', (t) => {
  const dataDir = tmpDir(t)
  const elsewhere = tmpDir(t)
  const target = path.join(elsewhere, 'seed.json')
  fs.writeFileSync(target, JSON.stringify({ v: 1, seed: 'ab'.repeat(32) }))
  fs.mkdirSync(path.join(dataDir, 'private'), { mode: 0o700 })
  fs.symlinkSync(target, seedFile(dataDir))
  t.exception(() => storeLib.readDmSeed(dataDir), /dm-seed\.json inutilizável/)
  t.exception(() => storeLib.ensureDmSeed(dataDir), /dm-seed\.json inutilizável/)

  const linked = tmpDir(t)
  fs.symlinkSync(elsewhere, path.join(linked, 'private'))
  t.exception(() => storeLib.readDmSeed(linked), /private\/ não é um diretório/)
  t.exception(() => storeLib.ensureDmSeed(linked), /private\/ não é um diretório/)
  t.alike(fs.readdirSync(elsewhere), ['seed.json'], 'nothing written through the link')

  const plain = tmpDir(t)
  fs.writeFileSync(path.join(plain, 'private'), '')
  t.exception(() => storeLib.ensureDmSeed(plain), /private\/ não é um diretório/)
})

test('dm seed: a failed write leaves nothing; a creator that loses the race returns the winner', (t) => {
  const dataDir = tmpDir(t)
  const real = fs.writeFileSync
  fs.writeFileSync = () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) }
  try {
    t.exception(() => storeLib.ensureDmSeed(dataDir), /não foi possível criar/)
  } finally {
    fs.writeFileSync = real
  }
  t.alike(fs.readdirSync(path.join(dataDir, 'private')), [], 'no partial file or temp left')

  const winner = 'cd'.repeat(32)
  const realLink = fs.linkSync
  fs.linkSync = (tmp, file) => {
    real(file, JSON.stringify({ v: 1, seed: winner }), { mode: 0o600 })
    throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
  }
  let got
  try {
    got = storeLib.ensureDmSeed(dataDir)
  } finally {
    fs.linkSync = realLink
  }
  t.is(b4a.toString(got, 'hex'), winner, 'the existing seed wins')
  t.alike(fs.readdirSync(path.join(dataDir, 'private')), ['dm-seed.json'], 'temp removed')
})

test('dm-key: published in the own diary, read back by dmLookup, refreshed only when old or changed', async (t) => {
  const { ctx, dataDir, publicKey } = await setup(t)
  const box = boxHex()
  t.alike(await member.dmLookup(ctx, publicKey), { box: null, gen: null }, 'own diary without a dm-key')
  t.is(await member.dmKeyStale(ctx, { box, gen: 1 }), true)
  const first = await member.dmKeyEnsure(ctx, { box, gen: 1 })
  t.is(first.box, box)
  t.is(first.gen, 1)
  t.ok(first.seq > 0)
  t.is(await member.dmKeyStale(ctx, { box, gen: 1 }), false)
  t.alike(await member.dmKeyEnsure(ctx, { box, gen: 1 }), { box, gen: 1, seq: null }, 'a repeat appends nothing')
  t.alike(await member.dmLookup(ctx, publicKey), { box, gen: 1 })
  t.alike(await member.dmLookup(ctx, publicKey.toUpperCase()), { box, gen: 1 }, 'key case ignored')

  const { entries } = await member.logRead(ctx)
  t.alike(entries.find((e) => e.seq === first.seq).record, { type: 'dm-key', box, gen: 1, at: entries.find((e) => e.seq === first.seq).record.at })

  // Past DM_KEY_REFRESH_BLOCKS newer blocks the same key is appended again.
  const store = await storeLib.openStore(dataDir)
  try {
    const diary = await storeLib.openDiary(store)
    const followed = b4a.toString(crypto.keyPair().publicKey, 'hex')
    for (let i = 0; i < member.DM_KEY_REFRESH_BLOCKS; i += 8) {
      const batch = []
      for (let j = 0; j < 8; j++) batch.push(followRecord({ key: followed, on: (i + j) % 2 === 0 }))
      await storeLib.appendRecords(diary, batch)
    }
  } finally {
    await store.close()
  }
  t.is(await member.dmKeyStale(ctx, { box, gen: 1 }), true, 'old dm-key is stale')
  const refreshed = await member.dmKeyEnsure(ctx, { box, gen: 1 })
  t.ok(refreshed.seq > first.seq, 'refreshed')
  t.is(await member.dmKeyStale(ctx, { box, gen: 1 }), false)

  const box2 = boxHex()
  t.is(await member.dmKeyStale(ctx, { box: box2, gen: 2 }), true, 'another box is stale')
  await member.dmKeyEnsure(ctx, { box: box2, gen: 2 })
  t.alike(await member.dmLookup(ctx, publicKey), { box: box2, gen: 2 }, 'highest gen wins')
})

test('dm-key: invalid box or gen refused before anything is written; a diary without its certificate refuses', async (t) => {
  const { ctx } = await setup(t)
  const box = boxHex()
  for (const bad of [{ box: '00'.repeat(32), gen: 1 }, { box: box.toUpperCase(), gen: 1 }, { box: box.slice(2), gen: 1 }, { box, gen: 0 }, { box, gen: 1.5 }, { box: null, gen: 1 }]) {
    await rejects(t, member.dmKeyEnsure(ctx, bad), 'chave de caixa inválida', UsageError)
    await rejects(t, member.dmKeyStale(ctx, bad), 'chave de caixa inválida', UsageError)
  }
  const bare = await setup(t, { cert: false })
  t.is(await member.dmKeyStale(bare.ctx, { box, gen: 1 }), false, 'nothing to refresh in an empty diary')
  await rejects(t, member.dmKeyEnsure(bare.ctx, { box, gen: 1 }), member.GENESIS_REQUIRED)
})

test('dmLookup: an unknown diary is not known here (null) and no core is created; a bad key is refused', async (t) => {
  const { ctx, dataDir } = await setup(t)
  const other = b4a.toString(crypto.keyPair().publicKey, 'hex')
  t.is(await member.dmLookup(ctx, other), null)
  const store = await storeLib.openStore(dataDir)
  try {
    t.absent(await storeLib.replicaStored(store, other), 'no core created')
  } finally {
    await store.close()
  }
  for (const bad of ['zz'.repeat(32), 'ab', null, 42]) {
    await rejects(t, member.dmLookup(ctx, bad), 'chave inválida', UsageError)
  }
})

test('dmSigner: a copy of the diary signer pair, whose manifest is the diary key', async (t) => {
  const { ctx, publicKey } = await setup(t)
  const s = await member.dmSigner(ctx)
  t.alike(Object.keys(s), ['diary', 'keyPair'])
  t.is(s.diary, publicKey)
  const signer = b4a.toString(s.keyPair.publicKey, 'hex')
  t.ok(isDiaryOfSigner(s.diary, signer), 'the diary key is the hash of the signer manifest')
  const msg = b4a.from('varanda test')
  t.ok(crypto.verify(msg, crypto.sign(msg, s.keyPair.secretKey), s.keyPair.publicKey), 'the pair signs for the signer')
  s.keyPair.secretKey.fill(0)
  const again = await member.dmSigner(ctx)
  t.absent(again.keyPair.secretKey.every((b) => b === 0), 'zeroing a copy leaves the diary key intact')
  again.keyPair.secretKey.fill(0)
})

test('dmActorBox: the page delegate signs the node box; no delegate or a bad box is refused', async (t) => {
  const { ctx } = await setup(t)
  const box = boxHex()
  await rejects(t, (async () => member.dmActorBox(ctx, { box, gen: 1 }))(), 'chave de página não registrada', UsageError)
  const { actor } = await member.pageRegister(ctx)
  const r = member.dmActorBox(ctx, { box, gen: 1 })
  t.alike(Object.keys(r).sort(), ['actor', 'at', 'box', 'gen', 'sig'])
  t.is(r.actor, actor)
  t.is(r.box, box)
  t.is(r.gen, 1)
  t.ok(verifyActorBox({ actor: r.actor, box: r.box, gen: r.gen, at: r.at }, r.sig), 'verifies under the actor')
  t.absent(verifyActorBox({ actor: r.actor, box: boxHex(), gen: r.gen, at: r.at }, r.sig), 'bound to the box')
  for (const bad of [{ box: '00'.repeat(32), gen: 1 }, { box, gen: 0 }, { box: 'x', gen: 1 }]) {
    await rejects(t, (async () => member.dmActorBox(ctx, bad))(), 'chave de caixa inválida', UsageError)
  }
})

// A diary of someone else, written in its own store and replicated block by
// block into the member's store, as an interrupted sync leaves it.
const certLib = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')

const MOD_DATE = '2026-01-01T00:00:00.000Z'

async function trustRoot (t) {
  const dataDir = tmpDir(t)
  const kp = crypto.keyPair()
  const ctx = { dataDir, association: b4a.toString(kp.publicKey, 'hex') }
  await member.idCreate(ctx)
  return { ctx, dataDir, kp }
}

function dmKey (box, gen) {
  return { type: 'dm-key', box, gen, at: '2026-01-01T00:00:00.000Z' }
}

async function otherDiary (t, makeCert, records, { truncateTo = null, after = [] } = {}) {
  const srcDir = tmpDir(t)
  const src = await storeLib.openStore(srcDir)
  try {
    const core = src.get({ name: 'diary', valueEncoding: 'json' })
    await core.ready()
    const key = b4a.toString(core.key, 'hex')
    await core.append(memberCertRecord(makeCert(key)))
    for (const r of records) await core.append(r)
    if (truncateTo !== null) {
      await core.truncate(truncateTo)
      for (const r of after) await core.append(r)
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
    return { length: replica.length, contiguousLength: replica.contiguousLength, fork: replica.fork }
  } finally {
    await dst.close()
    await src.close()
  }
}

test('dmLookup: a partial replica is not known here, even with an older dm-key in its prefix', async (t) => {
  const { ctx, dataDir, kp } = await trustRoot(t)
  const box1 = boxHex()
  const box2 = boxHex()
  const filler = followRecord({ key: b4a.toString(crypto.keyPair().publicKey, 'hex'), on: true })
  const diary = await otherDiary(t, (key) => certLib.createCert({ member: key }, kp), [dmKey(box1, 1), filler, filler, dmKey(box2, 2)])
  const partial = await fetchBlocks(diary, dataDir, [0, 1])
  t.alike(partial, { length: 5, contiguousLength: 2, fork: 0 }, 'fixture: the newer dm-key is not stored')
  t.is(await member.dmLookup(ctx, diary.key), null, 'the stale gen 1 is not answered')
  await fetchBlocks(diary, dataDir, [2, 3, 4])
  t.alike(await member.dmLookup(ctx, diary.key), { box: box2, gen: 2 }, 'whole replica answers its newest')
})

test('dmLookup: a replica certified by a revoked issuer is not known here', async (t) => {
  const { ctx, dataDir, kp } = await trustRoot(t)
  const issuerKp = crypto.keyPair()
  const issuerHex = b4a.toString(issuerKp.publicKey, 'hex')
  const issuerCert = certLib.createIssuerCert({ issuer: issuerHex }, kp)
  const box = boxHex()
  const diary = await otherDiary(t, (key) => certLib.createIssuedCert({ member: key }, issuerKp, issuerCert), [dmKey(box, 1)])
  await fetchBlocks(diary, dataDir, [0, 1])
  t.alike(await member.dmLookup(ctx, diary.key), { box, gen: 1 }, 'answered before the revocation')
  const modKp = crypto.keyPair()
  const modCert = certLib.createModeratorCert({ moderator: b4a.toString(modKp.publicKey, 'hex'), date: MOD_DATE }, kp)
  storeLib.writeBlocklist(dataDir, createSnapshot({ seq: 1, date: MOD_DATE, revokedIssuers: [issuerHex] }, modKp, modCert))
  t.is(await member.dmLookup(ctx, diary.key), null)
})

test('dmLookup: a forked replica is not known here', async (t) => {
  const { ctx, dataDir, kp } = await trustRoot(t)
  const box1 = boxHex()
  const box2 = boxHex()
  const diary = await otherDiary(t, (key) => certLib.createCert({ member: key }, kp), [dmKey(box1, 1)], { truncateTo: 1, after: [dmKey(box2, 2)] })
  const replica = await fetchBlocks(diary, dataDir, [0, 1])
  t.is(replica.fork, 1, 'fixture: the replica carries the fork')
  t.is(await member.dmLookup(ctx, diary.key), null)
})
