'use strict'

// worklet/identity-install.js against web-member's memory node storage and a
// fake session: the passkey record is bound on success, a mismatch leaves
// the node locked, every secret buffer is zeroed, and the signedOut barrier
// is lifted only by sessionSaved after a non-resumed install.
const crypto = require('node:crypto')
const test = require('brittle')
const b4a = require('b4a')
const { memoryNodeStorage } = require('@varanda/web-member/lib/node-storage')
const { hkdfSha256 } = require('@varanda/web-member/lib/hkdf')
const passkey = require('@varanda/web-member/lib/passkey')
const { createIdentityHost } = require('../worklet/identity-install')
const { readAll, createLifecycle, uploadMedia } = require('../worklet/web-node-parts')

const hmac = (key, data) => new Uint8Array(crypto.createHmac('sha256', key).update(data).digest())
const hkdf = (ikm, salt, info, length) => hkdfSha256(ikm, salt, info, length, { hmac })
const randomBytes = (n) => new Uint8Array(crypto.randomBytes(n))

const PRF = 'a1'.repeat(32)
const OTHER_PRF = 'b2'.repeat(32)

// The session's host controls as the worklet uses them: pairs are copied
// synchronously, as lib/session.js setKeyPair does.
function fakeSession ({ diaryKey = null, legacy = false } = {}) {
  const s = {
    keyPair: null,
    media: null,
    resets: 0,
    received: [],
    setKeyPair (kp, { media } = {}) {
      s.received.push(kp, media)
      s.keyPair = { publicKey: new Uint8Array(kp.publicKey), secretKey: new Uint8Array(kp.secretKey) }
      s.media = media ? { publicKey: new Uint8Array(media.publicKey), secretKey: new Uint8Array(media.secretKey) } : null
      return Promise.resolve()
    },
    async clearKeyPair () {
      s.keyPair = null
      s.media = null
    },
    async identityStatus () {
      return {
        exists: diaryKey !== null,
        publicKey: diaryKey,
        legacy,
        unlocked: s.keyPair !== null,
        synced: false
      }
    },
    async reset () {
      s.resets++
      diaryKey = null
      s.keyPair = null
      s.media = null
    }
  }
  return s
}

// keys: lib/passkey.js, recording the prf buffer each derivation got.
function recordingKeys () {
  const seen = []
  return {
    seen,
    keyPairFromPrf (prf, opts) {
      seen.push(prf)
      return passkey.keyPairFromPrf(prf, opts)
    },
    mediaKeyPairFromPrf (prf, nonce, opts) {
      seen.push(prf)
      return passkey.mediaKeyPairFromPrf(prf, nonce, opts)
    }
  }
}

function setup (sessionOptions) {
  const session = fakeSession(sessionOptions)
  const storage = memoryNodeStorage()
  const keys = recordingKeys()
  const host = createIdentityHost({ session, storage, hkdf, randomBytes, keys })
  return { session, storage, keys, host }
}

function params (overrides = {}) {
  return { prf: PRF, credentialId: 'cred-1', userId: 'cd'.repeat(32), rpId: 'varanda.example', resumed: false, ...overrides }
}

const allZero = (buf) => buf.every((b) => b === 0)

async function expectedPublicKey (prfHex) {
  // WebCrypto HKDF (Node's), independent of the injected hmac path.
  const kp = await passkey.keyPairFromPrf(new Uint8Array(b4a.from(prfHex, 'hex')))
  return b4a.toString(kp.publicKey, 'hex')
}

test('a non-resumed install unlocks and binds the passkey record', async (t) => {
  const { session, storage, host } = setup()
  const out = await host.install(params())
  t.is(out.publicKey, await expectedPublicKey(PRF), 'the injected hkdf derives the WebCrypto key')
  t.is(out.resumed, false)
  t.ok(session.keyPair !== null && session.media !== null, 'both pairs installed')
  t.alike(await storage.readJson('passkey'), { v: 1, credentialId: 'cred-1', rpId: 'varanda.example', userId: 'cd'.repeat(32) })
  t.ok(await storage.readJson('mediaDevice'), 'the media nonce is drawn once')

  const status = await host.status()
  t.alike(status, {
    exists: false,
    publicKey: null,
    legacy: false,
    unlocked: true,
    synced: false,
    resumed: false,
    passkeyKnown: true,
    credentialId: 'cred-1',
    rpId: 'varanda.example',
    signedOut: false
  })
})

test('status reports no passkey with null credentialId and rpId', async (t) => {
  const { host } = setup()
  const status = await host.status()
  t.is(status.passkeyKnown, false)
  t.is(status.credentialId, null)
  t.is(status.rpId, null)
  t.is(status.unlocked, false)
})

test('a key mismatch leaves the node locked and binds nothing', async (t) => {
  const { session, storage, host } = setup({ diaryKey: await expectedPublicKey(OTHER_PRF) })
  await t.exception(host.install(params()), /passkey não corresponde ao diário guardado/)
  t.is(session.keyPair, null, 'locked')
  t.is(await storage.readJson('passkey'), null)
  const err = await host.install(params()).catch((e) => e)
  t.is(err.code, 'USAGE')
})

test('a legacy store is a mismatch too', async (t) => {
  const { session, host } = setup({ diaryKey: await expectedPublicKey(PRF), legacy: true })
  await t.exception(host.install(params()), /passkey não corresponde/)
  t.is(session.keyPair, null)
})

test('the prf buffer and both pairs are zeroed after the call', async (t) => {
  const { session, keys, host } = setup()
  await host.install(params())
  t.ok(keys.seen.length >= 2)
  for (const prf of keys.seen) t.ok(allZero(prf), 'prf zeroed after success')
  for (const kp of session.received) {
    t.ok(allZero(kp.secretKey) && allZero(kp.publicKey), 'pair handed to the session zeroed')
  }

  const failing = setup({ diaryKey: await expectedPublicKey(OTHER_PRF) })
  await failing.host.install(params()).catch(() => {})
  for (const prf of failing.keys.seen) t.ok(allZero(prf), 'prf zeroed after a mismatch')
})

test('a non-resumed success does not lift signedOut; sessionSaved does', async (t) => {
  const { storage, host } = setup()
  await host.forget()
  t.is((await host.status()).signedOut, true)
  await host.install(params())
  t.is((await host.status()).signedOut, true, 'install alone keeps the barrier')
  t.alike(await host.sessionSaved(), {})
  t.is((await host.status()).signedOut, false)
  t.is(await storage.readJson('signedOut'), null)
})

test('sessionSaved without a non-resumed install is refused', async (t) => {
  const { host, session } = setup()
  await host.forget()
  let err = await host.sessionSaved().catch((e) => e)
  t.is(err.code, 'USAGE', 'locked')

  // A resumed install (allowed: forget the barrier first) does not count.
  const second = setup()
  await second.host.install(params({ resumed: true }))
  err = await second.host.sessionSaved().catch((e) => e)
  t.is(err.code, 'USAGE', 'after a resumed install')

  // A non-resumed install followed by a lock does not count either.
  await host.install(params())
  await host.clear()
  t.is(session.keyPair, null)
  err = await host.sessionSaved().catch((e) => e)
  t.is(err.code, 'USAGE', 'after a lock')
  t.is((await host.status()).signedOut, true)

  // Nor a later failed install.
  const third = setup()
  await third.host.forget()
  await third.host.install(params())
  await third.host.install(params({ resumed: true })).catch(() => {})
  err = await third.host.sessionSaved().catch((e) => e)
  t.is(err.code, 'USAGE', 'after a refused install')
})

test('a resumed install is refused while signed out', async (t) => {
  const { session, keys, host } = setup()
  await host.forget()
  const err = await host.install(params({ resumed: true })).catch((e) => e)
  t.is(err.code, 'USAGE')
  t.is(session.keyPair, null, 'still locked')
  t.is(keys.seen.length, 0, 'nothing derived')

  await host.install(params())
  await host.sessionSaved()
  await host.clear()
  const out = await host.install(params({ resumed: true }))
  t.is(out.resumed, true, 'accepted once the barrier is lifted')
  t.is((await host.status()).resumed, true)
})

test('reset writes signedOut and clears the passkey record and nonce', async (t) => {
  const { session, storage, host } = setup()
  await host.install(params())
  t.alike(await host.reset(), {})
  t.is(session.resets, 1)
  t.is(session.keyPair, null)
  t.is(await storage.readJson('passkey'), null)
  t.is(await storage.readJson('mediaDevice'), null)
  t.alike(await storage.readJson('signedOut'), { v: 1 })
})

test('forget locks the node and keeps the passkey record', async (t) => {
  const { session, storage, host } = setup()
  await host.install(params())
  t.alike(await host.forget(), {})
  t.is(session.keyPair, null)
  t.ok(await storage.readJson('passkey'))
  t.alike(await storage.readJson('signedOut'), { v: 1 })
})

// worklet/web-node-parts.js: the media read loop and the shutdown order.

// A bare-fs FileHandle-shaped reader: read() resolves { bytesRead, buffer }.
function fakeHandle (data, chunk) {
  const calls = []
  return {
    calls,
    async read (buffer, offset, length, position) {
      calls.push({ offset, length, position })
      const n = Math.max(0, Math.min(chunk, length, data.byteLength - position))
      buffer.set(data.subarray(position, position + n), offset)
      return { bytesRead: n, buffer }
    }
  }
}

test('readAll reads every chunk of a bare-fs handle', async (t) => {
  const data = new Uint8Array(1000).map((_, i) => i % 251)
  const handle = fakeHandle(data, 300)
  const bytes = await readAll(handle, 1000, 4096)
  t.alike(bytes, data)
  t.alike(handle.calls.map((c) => c.offset), [0, 300, 600, 900])
})

test('readAll enforces the cap and a short file', async (t) => {
  const data = new Uint8Array(100).fill(7)
  const over = fakeHandle(data, 64)
  t.is(await readAll(over, 100, 99), null, 'over the cap')
  t.is(over.calls.length, 0, 'nothing read over the cap')
  t.is(await readAll(fakeHandle(data, 64), 0, 99), null, 'empty')
  t.is(await readAll(fakeHandle(data, 64), 150, 4096), null, 'file shorter than its size')
})

// A storage whose writeJson resolves only when released.
function blockingStorage () {
  const base = memoryNodeStorage()
  const s = {
    pending: [],
    closed: false,
    core: base.core,
    hasCore: base.hasCore,
    deleteCore: base.deleteCore,
    readJson: base.readJson,
    writeJson (key, value) {
      return new Promise((resolve) => {
        s.pending.push(() => base.writeJson(key, value).then(resolve))
      })
    },
    async close () { s.closed = true }
  }
  return s
}

test('close waits for a pending identity write before releasing the storage', async (t) => {
  const session = fakeSession()
  let sessionClosed = false
  session.detach = async () => {}
  session.close = async () => { sessionClosed = true }
  const storage = blockingStorage()
  const host = createIdentityHost({ session, storage, hkdf, randomBytes })
  const lifecycle = createLifecycle({ session, storage })
  const forget = lifecycle.guard(() => host.forget())

  const forgetting = forget()
  await new Promise((resolve) => setTimeout(resolve, 10))
  t.is(storage.pending.length, 1, 'the signedOut write is pending')

  let closed = false
  const closing = lifecycle.close().then(() => { closed = true })
  const late = await forget().catch((e) => e)
  t.is(late.code, 'LOCKED', 'new work refused once closing')
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.is(closed, false, 'close waits for the write')
  t.is(storage.closed, false, 'the storage (and its LOCK) is still held')
  t.is(sessionClosed, false, 'the session is not closed yet')

  storage.pending.shift()()
  await forgetting
  await closing
  t.ok(closed)
  t.ok(sessionClosed && storage.closed)
  t.alike(await storage.readJson('signedOut'), { v: 1 }, 'the write landed before the close')
})

test('an upload still reading at close never reaches mediaUpload; close does not wait on a sync', async (t) => {
  let mediaUploads = 0
  let sessionClosed = false
  const session = {
    // A sync against an unresponsive seeder: never settles.
    mediaUpload () {
      mediaUploads++
      return new Promise(() => {})
    },
    detach: async () => {},
    close: async () => { sessionClosed = true }
  }
  const storage = { closed: false, async close () { storage.closed = true } }
  const lifecycle = createLifecycle({ session, storage })
  let finishRead
  const unlinked = []
  const upload = lifecycle.guardUpload(() => uploadMedia({
    read: () => new Promise((resolve) => { finishRead = resolve }),
    session,
    unlink: (real) => unlinked.push(real),
    isClosing: lifecycle.isClosing
  }, { mime: 'image/jpeg', width: 1, height: 1 }))

  const uploading = upload()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const closing = lifecycle.close()
  const bytes = new Uint8Array([1, 2, 3])
  finishRead({ real: '/cache/photo.jpg', bytes })
  const err = await uploading.catch((e) => e)
  t.is(err.code, 'LOCKED', 'the upload fails with the closed error')
  t.is(mediaUploads, 0, 'mediaUpload never started')
  t.alike(unlinked, [], 'a refused file is not unlinked')
  t.ok(bytes.every((b) => b === 0), 'the bytes are zeroed')
  const timeout = new Promise((resolve) => setTimeout(resolve, 1000, 'timeout'))
  t.is(await Promise.race([closing.then(() => 'closed'), timeout]), 'closed')
  t.ok(sessionClosed && storage.closed)
})

test('close cancels a running upload by closing the session first', async (t) => {
  let rejectUpload
  const order = []
  const session = {
    mediaUpload () {
      return new Promise((resolve, reject) => { rejectUpload = reject })
    },
    detach: async () => {},
    close: async () => {
      order.push('session')
      // lib/session.js close() aborts the sync the upload waits on.
      rejectUpload(new Error('aborted'))
    }
  }
  const storage = { async close () { order.push('storage') } }
  const lifecycle = createLifecycle({ session, storage })
  const upload = lifecycle.guardUpload(() => uploadMedia({
    read: async () => ({ real: '/cache/p.jpg', bytes: new Uint8Array(4) }),
    session,
    unlink: () => {},
    isClosing: lifecycle.isClosing
  }, { mime: 'image/jpeg', width: 1, height: 1 }))
  const uploading = upload().catch((e) => e)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await lifecycle.close()
  t.alike(order, ['session', 'storage'])
  t.ok(await uploading instanceof Error)
})
