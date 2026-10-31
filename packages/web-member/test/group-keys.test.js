// lib/group-keys.js and kv 'groupBoxDevice' (lib/node-store.js): the box key
// pair derived from the PRF and the device nonce, epoch keys held in memory
// only, everything zeroed on lock, signOut and close, and a late async step
// after one of them installs nothing.
const test = require('brittle')
const crypto = require('node:crypto')
const b4a = require('b4a')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const { UsageError } = require('@varanda/core/lib/errors')
const { boxKeyPairFromPrf } = require('../lib/passkey')
const { createGroupKeys, kidString } = require('../lib/group-keys')

const hex = (buf) => b4a.toString(b4a.from(buf.buffer, buf.byteOffset, buf.byteLength), 'hex')
const WRITER = 'ab'.repeat(32)
const KID = { writer: WRITER, seq: 3 }
const NONCE_HEX = 'cd'.repeat(32)

function prfBytes (fill = 9) {
  return new Uint8Array(32).fill(fill)
}

function epochKey () {
  return new Uint8Array(crypto.randomBytes(32))
}

// Every kv value the storage holds, as written.
async function kvDump (storage, keys) {
  const out = {}
  for (const k of keys) out[k] = await storage.readJson(k)
  return out
}

async function codeOf (fn) {
  try {
    await fn()
  } catch (err) {
    return err instanceof UsageError ? err.message : err.name
  }
  return null
}

test('kv groupBoxDevice: exactly { v: 1, nonce }, created once, never replaced', async (t) => {
  const storage = memoryNodeStorage()
  t.is(await store.readGroupBoxDevice(storage), null, 'absent at first')
  const [a, b] = await Promise.all([
    store.ensureGroupBoxDevice(storage, NONCE_HEX),
    store.ensureGroupBoxDevice(storage, 'ef'.repeat(32))
  ])
  t.is(a, NONCE_HEX)
  t.is(b, NONCE_HEX, 'a racing unlock reuses the first nonce')
  t.alike(await storage.readJson('groupBoxDevice'), { v: 1, nonce: NONCE_HEX }, 'exact shape')
  t.is(await store.ensureGroupBoxDevice(storage, 'ef'.repeat(32)), NONCE_HEX, 'never replaced')
  t.alike(await store.readGroupBoxDevice(storage), { v: 1, nonce: NONCE_HEX })

  await store.writeGroupBoxDevice(storage, 'AB'.repeat(32))
  t.alike(await storage.readJson('groupBoxDevice'), { v: 1, nonce: 'ab'.repeat(32) }, 'lowercased')
  for (const bad of ['ab'.repeat(31), 'zz'.repeat(32), null, 42]) {
    t.exception.all(() => store.writeGroupBoxDevice(storage, bad), 'bad nonce refused')
    await t.exception.all(store.ensureGroupBoxDevice(memoryNodeStorage(), bad), 'bad fresh nonce refused')
  }
  for (const bad of [{ v: 2, nonce: NONCE_HEX }, { v: 1, nonce: 'x' }, [1], 'x']) {
    await storage.writeJson('groupBoxDevice', bad)
    t.is(await store.readGroupBoxDevice(storage), null, 'malformed reads as absent')
  }
})

test('unlock: derives from PRF and the device nonce, nothing secret in storage', async (t) => {
  const storage = memoryNodeStorage()
  const keys = createGroupKeys({ randomHex: () => NONCE_HEX })
  const prf = prfBytes()
  const publicKey = await keys.unlock(storage, prf)
  prf.fill(0)
  const expected = await boxKeyPairFromPrf(prfBytes(), b4a.from(NONCE_HEX, 'hex'))
  t.is(hex(publicKey), hex(expected.publicKey), 'public key from PRF + stored nonce')
  t.is(hex(keys.boxKeyPair().secretKey), hex(expected.secretKey))
  t.is(hex(keys.boxPublicKey()), hex(expected.publicKey))
  t.ok(keys.unlocked)
  t.ok(keys.put(keys.token(), KID, epochKey()))

  const dump = await kvDump(storage, ['groupBoxDevice', 'groupWriters', 'groupCores', 'mediaDevice', 'config'])
  t.alike(dump.groupBoxDevice, { v: 1, nonce: NONCE_HEX })
  const text = JSON.stringify(dump)
  for (const secret of [expected.secretKey, prfBytes(), keys.get(KID)]) {
    t.absent(text.includes(hex(secret)), 'no secret in storage (hex)')
    t.absent(text.includes(b4a.toString(b4a.from(secret), 'base64')), 'no secret in storage (base64)')
  }

  const again = createGroupKeys({ randomHex: () => 'ef'.repeat(32) })
  t.is(hex(await again.unlock(storage, prfBytes())), hex(publicKey), 'same device nonce, same pair next session')
  t.is(again.size, 0, 'epoch keys are not carried over')
  const other = createGroupKeys()
  t.not(hex(await other.unlock(memoryNodeStorage(), prfBytes())), hex(publicKey), 'another device nonce, another pair')
  t.is(await codeOf(() => keys.unlock(storage, new Uint8Array(31))), 'TypeError', 'bad PRF refused')
})

test('lock, signOut and close zero the box key and every epoch key', async (t) => {
  for (const how of ['lock', 'signOut', 'close']) {
    const keys = createGroupKeys()
    await keys.unlock(memoryNodeStorage(), prfBytes())
    const pair = keys.boxKeyPair()
    const tok = keys.token()
    const given = [epochKey(), epochKey()]
    t.ok(keys.put(tok, KID, given[0]))
    t.ok(keys.put(tok, WRITER + ':7', given[1]))
    t.alike(keys.get(KID), given[0], 'held as given')
    t.not(keys.get(KID), given[0], 'a copy is held')
    given[0].fill(0)
    t.ok(keys.get(KID).some((x) => x !== 0), 'caller zeroing its buffer does not touch the held key')
    const held = [keys.get(KID), keys.get({ writer: WRITER, seq: 7 })]
    t.is(keys.size, 2)

    keys[how]()
    t.ok(pair.secretKey.every((x) => x === 0), how + ': box secret zeroed')
    t.ok(pair.publicKey.every((x) => x === 0), how + ': box public zeroed')
    for (const k of held) t.ok(k.every((x) => x === 0), how + ': epoch key zeroed')
    t.is(keys.size, 0, how + ': holder empty')
    t.is(keys.get(KID), null)
    t.is(keys.boxKeyPair(), null)
    t.is(keys.boxPublicKey(), null)
    t.absent(keys.unlocked)
    t.absent(keys.put(tok, KID, epochKey()), how + ': a stale token installs nothing')
    t.absent(keys.put(keys.token(), KID, epochKey()), how + ': no epoch key without a box key')
    t.is(keys.size, 0)
  }
  const closed = createGroupKeys()
  closed.close()
  t.is(await codeOf(() => closed.unlock(memoryNodeStorage(), prfBytes())), 'chaves de grupo encerradas', 'no unlock after close')
})

test('a step resolved after signOut does not restore a key', async (t) => {
  // An unlock whose nonce read resolves after signOut: nothing is installed.
  const storage = memoryNodeStorage()
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const slow = {
    readJson: async (k) => { await gate; return storage.readJson(k) },
    writeJson: (k, v) => storage.writeJson(k, v)
  }
  const keys = createGroupKeys()
  const pending = keys.unlock(slow, prfBytes())
  keys.signOut()
  release()
  t.is(await codeOf(() => pending), store.LOCKED, 'late unlock refused as locked')
  t.is(keys.boxKeyPair(), null, 'no box key installed')
  t.absent(keys.unlocked)

  // An unlock overtaken by a later one: only the later pair stays.
  let release2 = null
  const gate2 = new Promise((resolve) => { release2 = resolve })
  const slow2 = {
    readJson: async (k) => { await gate2; return storage.readJson(k) },
    writeJson: (k, v) => storage.writeJson(k, v)
  }
  const first = keys.unlock(slow2, prfBytes(1))
  const second = await keys.unlock(storage, prfBytes(2))
  release2()
  t.is(await codeOf(() => first), store.LOCKED, 'overtaken unlock refused')
  t.is(hex(keys.boxPublicKey()), hex(second), 'the later pair stays')

  // An epoch key opened before signOut, put after it: dropped.
  const tok = keys.token()
  const opened = Promise.resolve().then(() => epochKey())
  keys.signOut()
  t.absent(keys.put(tok, KID, await opened), 'late epoch key not installed')
  t.is(keys.size, 0)
  await keys.unlock(storage, prfBytes(2))
  t.absent(keys.put(tok, KID, epochKey()), 'a token from before the new unlock stays stale')
  t.is(keys.get(KID), null)
})

test('kid: { writer, seq } ref or its canonical string', (t) => {
  t.is(kidString(KID), WRITER + ':3')
  t.is(kidString(WRITER + ':0'), WRITER + ':0')
  for (const bad of [null, 3, 'x', WRITER + ':01', WRITER + ':-1', WRITER.toUpperCase() + ':1',
    { writer: WRITER }, { writer: WRITER, seq: -1 }, { writer: WRITER, seq: 1.5 }, { writer: 'ab', seq: 1 }]) {
    t.is(kidString(bad), null)
  }
  const keys = createGroupKeys()
  t.exception.all(() => keys.put(keys.token(), 'bad', epochKey()), 'bad kid refused')
  t.exception.all(() => keys.put(keys.token(), KID, new Uint8Array(31)), 'bad key refused')
  t.is(keys.get('bad'), null)
})
