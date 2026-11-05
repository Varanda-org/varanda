'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert } = require('@varanda/core/lib/cert')
const { deleteRecord } = require('@varanda/core/lib/records')
const { latestDelegate } = require('../lib/page-lifecycle')
const { verifyPage } = require('../lib/page-proof')
const storeLib = require('../lib/store')
const member = require('../lib/member')
const { UsageError } = require('../lib/errors')
const { tmpDir } = require('./helpers/tmp')

const AT = '2026-01-01T00:00:00.000Z'
const INVALID = 'chave de página inválida'

async function setup (t, { cert = true } = {}) {
  const dataDir = tmpDir(t)
  const kp = crypto.keyPair()
  const assocHex = b4a.toString(kp.publicKey, 'hex')
  const ctx = { dataDir, association: assocHex }
  const { publicKey } = await member.idCreate(ctx)
  if (cert) await member.certAdd(ctx, createCert({ member: publicKey }, kp))
  return { ctx, dataDir, assocHex, publicKey }
}

function keyFile (dataDir) {
  return path.join(dataDir, 'private', 'page-actor.json')
}

async function rawEntries (dataDir) {
  const store = await storeLib.openStore(dataDir)
  try {
    return await storeLib.readRaw(await storeLib.openDiary(store))
  } finally {
    await store.close()
  }
}

async function append (dataDir, record) {
  const store = await storeLib.openStore(dataDir)
  try {
    return await storeLib.appendRecord(await storeLib.openDiary(store), record)
  } finally {
    await store.close()
  }
}

function writeKey (dataDir, pair) {
  fs.mkdirSync(path.join(dataDir, 'private'), { recursive: true, mode: 0o700 })
  storeLib.writeJsonAtomic(keyFile(dataDir), {
    v: 1,
    publicKey: b4a.toString(pair.publicKey, 'hex'),
    secretKey: b4a.toString(pair.secretKey, 'hex')
  }, 0o600)
}

async function rejectsUsage (t, promise, message) {
  try {
    await promise
    t.fail('expected a rejection: ' + message)
  } catch (err) {
    t.is(err.message, message)
    t.ok(err instanceof UsageError)
  }
}

test('pageRegister: a fresh delegate in private/page-actor.json (0600, dir 0700), named by the diary; a repeat appends nothing', async (t) => {
  const { ctx, dataDir } = await setup(t)
  const r = await member.pageRegister(ctx)
  t.alike(Object.keys(r), ['actor'], 'only the public key')
  t.ok(/^[0-9a-f]{64}$/.test(r.actor))
  const file = keyFile(dataDir)
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'key file 0600')
  t.is(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, 'private dir 0700')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.is(stored.publicKey, r.actor)
  t.absent(JSON.stringify(r).includes(stored.secretKey), 'the secret is not in the result')
  const before = await rawEntries(dataDir)
  t.is(latestDelegate(before), r.actor, 'the newest page-delegate names the stored key')
  t.alike(Object.keys(before[before.length - 1].record), ['type', 'actor', 'at'])

  t.alike(await member.pageRegister(ctx), r, 'same key again')
  t.is((await rawEntries(dataDir)).length, before.length, 'nothing appended')
  t.alike(member.readDelegate(ctx).publicKey, b4a.from(r.actor, 'hex'))
})

test('pageRegister: completes a partial write and replaces a delegate naming another key; a delete of the delegate has no effect', async (t) => {
  const { ctx, dataDir } = await setup(t)
  const pair = crypto.keyPair()
  const actor = b4a.toString(pair.publicKey, 'hex')
  writeKey(dataDir, pair) // the crash: the file saved, page-delegate not appended
  const n0 = (await rawEntries(dataDir)).length
  t.alike(await member.pageRegister(ctx), { actor })
  let raw = await rawEntries(dataDir)
  t.is(raw.length, n0 + 1, 'the missing page-delegate appended')
  t.is(latestDelegate(raw), actor)

  const other = b4a.toString(crypto.keyPair().publicKey, 'hex')
  await append(dataDir, { type: 'page-delegate', actor: other, at: AT })
  t.alike(await member.pageRegister(ctx), { actor })
  raw = await rawEntries(dataDir)
  t.is(latestDelegate(raw), actor, 'a newer delegate naming another key is superseded')

  // A delete never touches a page-* record (docs/protocol.md §12): the
  // newest page-delegate still names the stored actor, so nothing is added.
  await append(dataDir, deleteRecord({ seq: raw.length - 1, at: AT }))
  const n1 = (await rawEntries(dataDir)).length
  t.alike(await member.pageRegister(ctx), { actor })
  raw = await rawEntries(dataDir)
  t.is(raw.length, n1, 'a delete of the delegate has no effect: nothing is appended')
  t.is(latestDelegate(raw), actor)
  t.is(JSON.parse(fs.readFileSync(keyFile(dataDir), 'utf8')).publicKey, actor, 'the stored key is kept')
})

test('pageRegister: a malformed, inconsistent or linked key file is USAGE without its bytes, mints and appends nothing', async (t) => {
  const { ctx, dataDir } = await setup(t)
  const n0 = (await rawEntries(dataDir)).length
  const file = keyFile(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const secretish = 'ab'.repeat(32) + 'cd'.repeat(32)
  const bad = [
    'not json ' + secretish,
    JSON.stringify({ v: 1, publicKey: 'ab'.repeat(32), secretKey: secretish }), // the halves disagree
    JSON.stringify({ v: 2, publicKey: 'ab'.repeat(32), secretKey: secretish }),
    JSON.stringify({ v: 1, publicKey: 'AB'.repeat(32), secretKey: secretish })
  ]
  for (const text of bad) {
    fs.writeFileSync(file, text, { mode: 0o600 })
    try {
      await member.pageRegister(ctx)
      t.fail('expected a rejection')
    } catch (err) {
      t.ok(err instanceof UsageError)
      t.is(err.message, INVALID)
      t.absent(String(err.stack).includes(secretish), 'no secret bytes in the error')
    }
    t.is(fs.readFileSync(file, 'utf8'), text, 'the file is untouched')
  }
  fs.rmSync(file)
  const target = path.join(dataDir, 'elsewhere.json')
  writeKey(dataDir, crypto.keyPair())
  fs.renameSync(file, target)
  fs.symlinkSync(target, file)
  await rejectsUsage(t, member.pageRegister(ctx), INVALID)
  t.ok(fs.lstatSync(file).isSymbolicLink(), 'the link is not replaced')
  t.is((await rawEntries(dataDir)).length, n0, 'nothing appended')
})

test('pageRegister: before the member certificate nothing is minted', async (t) => {
  const { ctx, dataDir } = await setup(t, { cert: false })
  try {
    await member.pageRegister(ctx)
    t.fail('expected a rejection')
  } catch (err) {
    t.is(err.message, 'grave o certificado de membro antes de publicar')
  }
  t.absent(fs.existsSync(keyFile(dataDir)), 'no key file')
})

test('pageSign: signs as the delegate, never the diary key; without the file USAGE and nothing opened', async (t) => {
  const { ctx, dataDir, assocHex, publicKey } = await setup(t)
  const page = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const params = { action: 'post', nonce: 'n'.repeat(43), page, op: { text: 'oi' } }
  const entries = fs.readdirSync(dataDir)
  t.exception(() => member.pageSign(ctx, params), /chave de página não registrada/)
  t.alike(fs.readdirSync(dataDir), entries, 'nothing created')

  const { actor } = await member.pageRegister(ctx)
  const r = member.pageSign(ctx, params)
  const { opHash } = require('../lib/page-proof')
  const fields = { action: 'post', nonce: params.nonce, member: actor, page, association: assocHex, opHash: opHash(params.op) }
  t.alike(verifyPage(fields, r.signature), { ok: true }, 'verifies under the delegate')
  t.is(verifyPage({ ...fields, member: publicKey }, r.signature).ok, false, 'not under the diary key')

  const close = member.pageSign(ctx, { action: 'close', nonce: 'c'.repeat(43), page, op: { gen: 2, at: AT, nonce: 'k'.repeat(43) } })
  t.is(close.record.actor, actor, 'a record names the delegate as actor')
  t.is(close.record.association, assocHex)
  await rejectsUsage(t, (async () => member.pageSign(ctx, { ...params, action: 'close', op: { gen: 2 } }))(), 'operação de página inválida')
  t.absent(JSON.stringify(close).includes(JSON.parse(fs.readFileSync(keyFile(dataDir), 'utf8')).secretKey), 'no secret in the result')
})

test('pageSign terms: a statement and a terms signature, both under the delegate', async (t) => {
  const { verifyTerms, TERMS_VERSION } = require('../lib/terms')
  const { opHash } = require('../lib/page-proof')
  const { ctx, assocHex, publicKey } = await setup(t)
  const { actor } = await member.pageRegister(ctx)
  const nonce = 't'.repeat(43)
  const op = { version: TERMS_VERSION, diary: publicKey }
  const r = member.pageSign(ctx, { action: 'terms', nonce, page: '', op })
  t.alike(Object.keys(r).sort(), ['signature', 'termsSignature'])
  const fields = { action: 'terms', nonce, member: actor, page: '', association: assocHex, opHash: opHash(op) }
  t.alike(verifyPage(fields, r.signature), { ok: true }, 'the statement verifies under the delegate')
  t.alike(verifyTerms({ nonce, member: actor, association: assocHex, version: TERMS_VERSION }, r.termsSignature), { ok: true }, 'the terms signature verifies under the delegate')
  t.is(verifyTerms({ nonce, member: publicKey, association: assocHex, version: TERMS_VERSION }, r.termsSignature).ok, false, 'not under the diary key')
  t.ok(/^[0-9a-f]{128}$/.test(r.termsSignature))
  await rejectsUsage(t, (async () => member.pageSign(ctx, { action: 'terms', nonce, page: '', op: { version: 0, diary: publicKey } }))(), 'operação de página inválida')
  await rejectsUsage(t, (async () => member.pageSign(ctx, { action: 'terms', nonce, page: '', op: { version: TERMS_VERSION } }))(), 'operação de página inválida')
  const post = member.pageSign(ctx, { action: 'post', nonce, page: publicKey, op: { text: 'oi' } })
  t.absent('termsSignature' in post, 'only terms carries a terms signature')
})
