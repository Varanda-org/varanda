'use strict'

// apps/cli/lib/account/page-keys.js: the sealed page secret table. No
// network; keys are made locally.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { openPageKeys, FILE } = require('../lib/account/page-keys')
const { tmpDir } = require('./helpers/net')

const KEY = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const NONCE = 'n'.repeat(43)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function env (value = KEY) {
  return { VARANDA_PAGE_KEYS: value }
}

function fullRow () {
  const page = crypto.keyPair()
  const media = crypto.keyPair()
  const writer = crypto.keyPair()
  const row = {
    secretKey: page.secretKey,
    mediaSecretKey: media.secretKey,
    boxSecretKey: nodeCrypto.randomBytes(32),
    groupBoxSecretKey: nodeCrypto.randomBytes(32),
    writers: { [hex(writer.publicKey)]: writer.secretKey }
  }
  return { pageKey: hex(page.publicKey), row }
}

function secretsOf (row) {
  const out = [row.secretKey, row.mediaSecretKey]
  if (row.boxSecretKey) out.push(row.boxSecretKey)
  if (row.groupBoxSecretKey) out.push(row.groupBoxSecretKey)
  for (const w of Object.keys(row.writers || {})) out.push(row.writers[w])
  return out.map((b) => b4a.from(b))
}

function fileHolds (file, secrets) {
  const raw = fs.readFileSync(file)
  return secrets.some((s) => raw.includes(s) || raw.includes(b4a.from(hex(s))) || raw.includes(b4a.from(s.toString('base64'))))
}

test('page-keys: disabled when VARANDA_PAGE_KEYS is unset or empty', async (t) => {
  const dir = tmpDir(t)
  for (const e of [{}, env('')]) {
    const keys = openPageKeys({ dir, env: e })
    t.is(keys.enabled, false)
    t.is(keys.get(OTHER), null)
    t.exception(() => keys.put(OTHER, {}), /desligado/)
    t.exception(() => keys.pending(NONCE), /desligado/)
    t.exception(() => keys.wipe(OTHER), /desligado/)
  }
  t.absent(fs.existsSync(path.join(dir, FILE)), 'nothing written')
})

test('page-keys: a malformed value is a usage error that never echoes it', async (t) => {
  const dir = tmpDir(t)
  for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32), ' ' + KEY, 'secret-value-123']) {
    try {
      openPageKeys({ dir, env: env(bad) })
      t.fail('accepted ' + bad.length)
    } catch (err) {
      t.is(err.code, 'USAGE')
      t.absent(err.message.includes(bad), 'value not in the message')
      t.absent(err.stack.includes(bad), 'value not in the stack')
    }
  }
})

test('page-keys: round trip with every field, file 0600 and sealed', async (t) => {
  const dir = tmpDir(t)
  const keys = openPageKeys({ dir, env: env() })
  t.is(keys.enabled, true)
  const { pageKey, row } = fullRow()
  keys.put(pageKey, row)
  const file = path.join(dir, FILE)
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  t.absent(fileHolds(file, secretsOf(row)), 'no secret in the clear')

  const again = openPageKeys({ dir, env: env() })
  const got = again.get(pageKey)
  t.alike(got.secretKey, row.secretKey)
  t.alike(got.mediaSecretKey, row.mediaSecretKey)
  t.alike(got.boxSecretKey, row.boxSecretKey)
  t.alike(got.groupBoxSecretKey, row.groupBoxSecretKey)
  t.alike(got.writers, row.writers)
  t.is(again.get(OTHER), null)

  got.secretKey.fill(0)
  t.alike(again.get(pageKey).secretKey, row.secretKey, 'get hands out a copy')

  const { pageKey: k2, row: r2 } = fullRow()
  t.exception.all(() => keys.put(k2, { ...r2, secretKey: row.secretKey }), /invalid/, 'secret of another key')
  t.exception.all(() => keys.put(k2, { ...r2, extra: 1 }), /invalid/, 'unknown field')
  t.exception.all(() => keys.put(k2, { ...r2, boxSecretKey: b4a.alloc(31) }), /invalid/, 'short box key')
  t.exception.all(() => keys.put(k2, { ...r2, writers: { [OTHER]: r2.secretKey } }), /invalid/, 'writer secret of another key')
  t.is(keys.get(k2), null, 'a refused put leaves nothing')
})

test('page-keys: a row without the optional fields still opens; put replaces the whole row', async (t) => {
  const dir = tmpDir(t)
  const keys = openPageKeys({ dir, env: env() })
  const { pageKey, row } = fullRow()
  keys.put(pageKey, { secretKey: row.secretKey, mediaSecretKey: row.mediaSecretKey })
  const got = openPageKeys({ dir, env: env() }).get(pageKey)
  t.alike(Object.keys(got).sort(), ['mediaSecretKey', 'secretKey'])

  keys.put(pageKey, row)
  t.alike(Object.keys(openPageKeys({ dir, env: env() }).get(pageKey)).sort(), ['boxSecretKey', 'groupBoxSecretKey', 'mediaSecretKey', 'secretKey', 'writers'])
  keys.put(pageKey, { secretKey: row.secretKey, mediaSecretKey: row.mediaSecretKey })
  t.alike(Object.keys(openPageKeys({ dir, env: env() }).get(pageKey)).sort(), ['mediaSecretKey', 'secretKey'], 'replaced whole')
})

test('page-keys: another key fails closed and rewrites nothing', async (t) => {
  const dir = tmpDir(t)
  const keys = openPageKeys({ dir, env: env() })
  const { pageKey, row } = fullRow()
  keys.put(pageKey, row)
  const file = path.join(dir, FILE)
  const before = fs.readFileSync(file)
  try {
    openPageKeys({ dir, env: env(OTHER) })
    t.fail('opened with another key')
  } catch (err) {
    t.is(err.code, 'indisponivel')
    t.absent(err.message.includes(OTHER))
  }
  const tampered = JSON.parse(before)
  const data = Buffer.from(tampered.data, 'base64')
  data[0] ^= 1
  tampered.data = data.toString('base64')
  fs.writeFileSync(file, JSON.stringify(tampered))
  t.exception(() => openPageKeys({ dir, env: env() }), /indisponivel/, 'a tampered file fails closed')
  fs.writeFileSync(file, '{')
  t.exception(() => openPageKeys({ dir, env: env() }), /indisponivel/, 'a broken file fails closed')
  fs.writeFileSync(file, before)
  t.alike(openPageKeys({ dir, env: env() }).get(pageKey).secretKey, row.secretKey, 'the right key still opens it')
})

test('page-keys: symlinks are refused', async (t) => {
  const real = tmpDir(t)
  const parent = tmpDir(t)
  const link = path.join(parent, 'link')
  fs.symlinkSync(real, link)
  t.exception(() => openPageKeys({ dir: link, env: env() }), /link simbólico/)

  const dir = tmpDir(t)
  const target = path.join(real, 'target.json')
  fs.writeFileSync(target, '{}')
  fs.symlinkSync(target, path.join(dir, FILE))
  t.exception(() => openPageKeys({ dir, env: env() }), /indisponivel/)
})

test('page-keys: pending derives one pair per nonce, stores nothing, and the same pair after a put or a reopen', async (t) => {
  const dir = tmpDir(t)
  const keys = openPageKeys({ dir, env: env() })
  t.exception.all(() => keys.pending('short'), /invalid nonce/)
  const a = keys.pending(NONCE)
  const b = keys.pending(NONCE)
  t.is(a.key, b.key, 'same nonce, same key')
  t.alike(a.row.secretKey, b.row.secretKey)
  t.is(hex(a.row.secretKey.subarray(32)), a.key)
  t.not(keys.pending('m'.repeat(43)).key, a.key)
  t.is(keys.get(a.key), null, 'pending is not stored')
  t.absent(fs.existsSync(path.join(dir, FILE)), 'nothing written for a pending pair')
  keys.put(a.key, a.row)
  t.alike(keys.get(a.key).secretKey, a.row.secretKey)
  t.is(keys.pending(NONCE).key, a.key, 'the same nonce derives the same pair after a put (a resend recomputes it)')
  t.not(hex(a.row.mediaSecretKey.subarray(32)), a.key, 'a distinct media pair')
  const reopened = openPageKeys({ dir, env: env() })
  t.is(reopened.pending(NONCE).key, a.key, 'the same pair after a restart')
  const other = openPageKeys({ dir: tmpDir(t), env: { VARANDA_PAGE_KEYS: OTHER } })
  t.not(other.pending(NONCE).key, a.key, 'another file key derives another pair')
})

test('page-keys: pending has no shared table to fill (300 nonces, then any nonce still answers)', async (t) => {
  const dir = tmpDir(t)
  const keys = openPageKeys({ dir, env: env() })
  for (let i = 0; i < 300; i++) keys.pending(nodeCrypto.randomBytes(32).toString('base64url'))
  const p = keys.pending(NONCE)
  t.is(hex(p.row.secretKey.subarray(32)), p.key, 'the 301st nonce still gets its pair')
  t.absent(fs.existsSync(path.join(dir, FILE)), 'nothing written')
})

test('page-keys: wipe leaves no secret bytes, get answers null, idempotent', async (t) => {
  const dir = tmpDir(t)
  const keys = openPageKeys({ dir, env: env() })
  const one = fullRow()
  const two = fullRow()
  keys.put(one.pageKey, one.row)
  keys.put(two.pageKey, two.row)
  t.is(keys.wipe(one.pageKey), true)
  t.is(keys.get(one.pageKey), null)
  t.is(keys.wipe(one.pageKey), false, 'idempotent')
  const file = path.join(dir, FILE)
  t.is(fs.statSync(file).mode & 0o777, 0o600)

  // The table itself, decrypted with the right key, no longer holds the row.
  const sealed = JSON.parse(fs.readFileSync(file, 'utf8'))
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', b4a.from(KEY, 'hex'), Buffer.from(sealed.iv, 'base64'), { authTagLength: 16 })
  decipher.setAAD(b4a.from('varanda-page-keys-v1'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()])
  for (const s of secretsOf(one.row)) {
    t.absent(plain.includes(b4a.from(hex(s))), 'wiped secret absent from the plaintext')
  }
  t.ok(plain.includes(b4a.from(hex(two.row.secretKey))), 'the other row is kept')
  for (const name of fs.readdirSync(dir)) {
    t.absent(fileHolds(path.join(dir, name), secretsOf(one.row)), name + ' holds no wiped secret')
  }
  const reopened = openPageKeys({ dir, env: env() })
  t.is(reopened.get(one.pageKey), null)
  t.alike(reopened.get(two.pageKey).secretKey, two.row.secretKey)
})

test('page-keys: wipe clears every field, so a later put of the same key starts empty', async (t) => {
  const dir = tmpDir(t)
  const keys = openPageKeys({ dir, env: env() })
  const one = fullRow()
  keys.put(one.pageKey, one.row)
  t.is(keys.wipe(one.pageKey), true)
  t.is(keys.wipe(one.pageKey), false, 'idempotent')
  keys.put(one.pageKey, { secretKey: one.row.secretKey, mediaSecretKey: one.row.mediaSecretKey })
  for (const k of ['boxSecretKey', 'groupBoxSecretKey', 'writers']) {
    t.is(keys.get(one.pageKey)[k], undefined, k + ' does not survive the wipe')
    t.is(openPageKeys({ dir, env: env() }).get(one.pageKey)[k], undefined, k + ' is not in the file')
  }
})

// Overwrites of the replaced file are the only all-zero writes page-keys
// makes, so the stub alters those alone.
function stubZeroWrites (t, behave) {
  const original = fs.writeSync
  fs.writeSync = function (fd, buf, offset, length, position) {
    if (buf instanceof Uint8Array && buf.byteLength > 0 && buf.every((b) => b === 0)) return behave(original, fd, buf, offset, length, position)
    return original.apply(fs, arguments)
  }
  t.teardown(() => { fs.writeSync = original })
  return () => { fs.writeSync = original }
}

test('page-keys: wipe zeroes the replaced file through short writes', async (t) => {
  const dir = tmpDir(t)
  const keys = openPageKeys({ dir, env: env() })
  const one = fullRow()
  keys.put(one.pageKey, one.row)
  const fd = fs.openSync(path.join(dir, FILE), 'r')
  t.teardown(() => fs.closeSync(fd))
  const restore = stubZeroWrites(t, (original, wfd, buf, offset, length, position) => original.call(fs, wfd, buf, offset, Math.min(length, 7), position))
  t.is(keys.wipe(one.pageKey), true)
  restore()
  const size = fs.fstatSync(fd).size
  const old = b4a.alloc(size)
  fs.readSync(fd, old, 0, size, 0)
  t.ok(size > 0 && old.every((b) => b === 0), 'every byte of the replaced file is zero')
})

test('page-keys: a failed overwrite makes wipe answer false and log a token', async (t) => {
  const dir = tmpDir(t)
  const logs = []
  const keys = openPageKeys({ dir, env: env(), log: (e) => logs.push(e) })
  const one = fullRow()
  keys.put(one.pageKey, one.row)
  const restore = stubZeroWrites(t, () => {
    const err = new Error('EIO')
    err.code = 'EIO'
    throw err
  })
  t.is(keys.wipe(one.pageKey), false)
  restore()
  t.is(keys.get(one.pageKey), null, 'the row is gone anyway')
  t.alike(logs, [{ event: 'page-keys-wipe', state: 'incompleto' }])
  t.absent(JSON.stringify(logs).includes(one.pageKey))
})

function sealRaw (inner) {
  const iv = nodeCrypto.randomBytes(12)
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', b4a.from(KEY, 'hex'), iv, { authTagLength: 16 })
  cipher.setAAD(b4a.from('varanda-page-keys-v1'))
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(inner))), cipher.final()])
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
}

test('page-keys: a false guard or fail() refuses put, wipe and pending and writes nothing', async (t) => {
  const dir = tmpDir(t)
  let owned = true
  const keys = openPageKeys({ dir, env: env(), guard: () => owned })
  const one = fullRow()
  keys.put(one.pageKey, one.row)
  const file = path.join(dir, FILE)
  const before = fs.readFileSync(file)
  owned = false
  const two = fullRow()
  t.exception(() => keys.put(two.pageKey, two.row), /indisponivel/, 'put refused')
  t.exception(() => keys.wipe(one.pageKey), /indisponivel/, 'wipe refused')
  t.exception(() => keys.pending(NONCE), /indisponivel/, 'pending refused')
  t.alike(fs.readFileSync(file), before, 'file bytes unchanged')
  t.is(keys.get(two.pageKey), null)
  t.alike(keys.get(one.pageKey).secretKey, one.row.secretKey, 'the table is unchanged')

  // The guard is asked again right before the file is replaced.
  let calls = 0
  const late = openPageKeys({ dir, env: env(), guard: () => ++calls < 2 })
  t.exception(() => late.put(two.pageKey, two.row), /indisponivel/)
  t.is(calls, 2)
  t.is(late.get(two.pageKey), null, 'a refused put leaves nothing')
  t.alike(fs.readFileSync(file), before)

  owned = true
  keys.fail()
  t.exception(() => keys.put(two.pageKey, two.row), /indisponivel/, 'put refused after fail()')
  t.exception(() => keys.wipe(one.pageKey), /indisponivel/, 'wipe refused after fail()')
  t.alike(fs.readFileSync(file), before)
  t.ok(openPageKeys({ dir, env: env() }).get(one.pageKey) !== null, 'the row is still on disk')
  t.execution(() => openPageKeys({ dir, env: {} }).fail(), 'a disabled table has fail() too')
})

test('page-keys: a row with a malformed writer secret fails closed, never a TypeError', async (t) => {
  const dir = tmpDir(t)
  const good = fullRow()
  const bad = fullRow()
  const goodJson = { secretKey: hex(good.row.secretKey), mediaSecretKey: hex(good.row.mediaSecretKey) }
  const badJson = { secretKey: hex(bad.row.secretKey), mediaSecretKey: hex(bad.row.mediaSecretKey), writers: { [Object.keys(bad.row.writers)[0]]: 'zz' } }
  for (const rows of [{ [bad.pageKey]: badJson }, { [good.pageKey]: goodJson, [bad.pageKey]: badJson }]) {
    fs.writeFileSync(path.join(dir, FILE), sealRaw({ v: 1, rows }))
    try {
      openPageKeys({ dir, env: env() })
      t.fail('opened')
    } catch (err) {
      t.absent(err instanceof TypeError, 'not a TypeError')
      t.is(err.code, 'indisponivel')
    }
  }
})

test('page-keys: the box secret is legacy only, read when present and never created', async (t) => {
  const dir = tmpDir(t)
  const keys = openPageKeys({ dir, env: env() })
  const { key, row } = keys.pending(NONCE)
  t.absent(row.boxSecretKey, 'a new page has no box secret')
  t.absent(row.groupBoxSecretKey)
  keys.put(key, row)
  const legacy = fullRow()
  keys.put(legacy.pageKey, legacy.row)
  const again = openPageKeys({ dir, env: env() })
  const got = again.get(key)
  t.absent(got.boxSecretKey, 'a restore does not create one')
  const old = again.get(legacy.pageKey)
  t.alike(old.boxSecretKey, legacy.row.boxSecretKey, 'a legacy secret is read back')
  delete old.boxSecretKey
  again.put(legacy.pageKey, old)
  t.absent(openPageKeys({ dir, env: env() }).get(legacy.pageKey).boxSecretKey, 'and stays gone once removed')
})

test('page-keys: the group box secret is legacy only, read when present and never created', async (t) => {
  const dir = tmpDir(t)
  const keys = openPageKeys({ dir, env: env() })
  const { key, row } = keys.pending(NONCE)
  t.absent(row.groupBoxSecretKey, 'a new page has no group box secret')
  keys.put(key, row)
  const legacy = fullRow()
  keys.put(legacy.pageKey, legacy.row)
  // A start of the service (a fresh open) and a restore never regenerate it.
  const again = openPageKeys({ dir, env: env() })
  t.absent(again.get(key).groupBoxSecretKey, 'a start does not create one')
  const old = again.get(legacy.pageKey)
  t.alike(old.groupBoxSecretKey, legacy.row.groupBoxSecretKey, 'a legacy group box secret is read back')
  delete old.groupBoxSecretKey
  again.put(legacy.pageKey, old)
  const third = openPageKeys({ dir, env: env() })
  t.absent(third.get(legacy.pageKey).groupBoxSecretKey, 'and stays gone once removed')
  t.ok(third.get(legacy.pageKey).boxSecretKey, 'the other fields are kept')
})
