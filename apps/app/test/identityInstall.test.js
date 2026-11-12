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
const recovery = require('@varanda/web-member/lib/recovery')
const { createBrowserSession } = require('@varanda/web-member/lib/session')
const { createDmStore } = require('@varanda/web-member/lib/dm-store')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createIdentityHost, RECOVERY_PENDING_MS } = require('../worklet/identity-install')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readAll, readMediaFile, isMediaName, createLifecycle, uploadMedia, putDmMedia, putMomentMedia, clearReadDir, writeReadFile, readMediaToFile } = require('../worklet/web-node-parts')

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
    prf: null,
    resets: 0,
    received: [],
    receivedPrf: [],
    setKeyPair (kp, { media, prf } = {}) {
      s.received.push(kp, media)
      if (prf) s.receivedPrf.push(prf)
      s.keyPair = { publicKey: new Uint8Array(kp.publicKey), secretKey: new Uint8Array(kp.secretKey) }
      s.media = media ? { publicKey: new Uint8Array(media.publicKey), secretKey: new Uint8Array(media.secretKey) } : null
      if (s.prf !== null) s.prf.fill(0)
      s.prf = prf ? new Uint8Array(prf) : null
      return Promise.resolve()
    },
    async clearKeyPair () {
      s.keyPair = null
      s.media = null
      if (s.prf !== null) s.prf.fill(0)
      s.prf = null
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
    userId: 'cd'.repeat(32),
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

// With the PRF the session opens the direct message store under the
// passkey's key, and a store of another key is replaced by an empty one: a
// passkey of another identity must never reach the session.
test('a mismatch is refused before any pair or the prf reaches the session', async (t) => {
  const cases = [
    { diaryKey: await expectedPublicKey(OTHER_PRF) },
    { diaryKey: await expectedPublicKey(PRF), legacy: true }
  ]
  for (const opts of cases) {
    const { session, host } = setup(opts)
    let cleared = 0
    const clear = session.clearKeyPair
    session.clearKeyPair = function () {
      cleared++
      return clear.call(session)
    }
    await t.exception(host.install(params()), /passkey não corresponde ao diário guardado/)
    t.is(session.received.length, 0, 'no pair handed over')
    t.is(session.receivedPrf.length, 0, 'no prf handed over')
    t.is(cleared, 1, 'the node is locked')
  }
})

// The real session, as the worklet runs it (lib/node-store.js keeps the
// message store in the 'dm-local' core).
test('a passkey of another identity keeps the stored message store', async (t) => {
  const storage = memoryNodeStorage()
  const internal = []
  const session = createBrowserSession({
    storage,
    association: b4a.toString(generateAssociationKeyPair().publicKey, 'hex'),
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => null,
    writeGate: false,
    hkdf,
    onInternalError: (err) => internal.push(err)
  })
  const events = []
  session.attach((event, data) => events.push({ event, data }))
  t.teardown(() => session.close())
  const host = createIdentityHost({ session, storage, hkdf, randomBytes })
  const out = [await host.install(params())]
  out.push(await session.handlers['identity.create']({}))
  // One stored row: a folder op is filed locally before anything is sent.
  const peer = 'ef'.repeat(32)
  await session.handlers['dm.set']({ peer, state: 'accepted' }).catch(() => {})
  const refused = await host.install(params({ prf: OTHER_PRF })).catch((err) => err)
  t.is(refused.message, 'passkey não corresponde ao diário guardado')
  t.is((await session.identityStatus()).unlocked, false, 'locked')
  const reader = createDmStore({ storage })
  const localKey = await passkey.dmLocalKeyFromPrf(new Uint8Array(b4a.from(PRF, 'hex')), { hkdf })
  await reader.unlock(localKey)
  localKey.fill(0)
  t.alike(reader.snapshot().ops.map((r) => [r.op, r.peer]), [['accepted', peer]], 'the refused passkey left the stored rows in place')
  reader.lock()
  out.push(await host.install(params()))
  const list = await session.handlers['dm.list']({ folder: 'inbox' })
  t.alike(list.conversations, [], 'it opens again with the right passkey')
  out.push(list, await host.status())
  // docs/rpc.md 5.50: the PRF reaches no result, event, error or log.
  const seen = JSON.stringify({ out, events, refused: [refused.message, refused.stack], internal: internal.map((err) => String(err && err.stack)) })
  for (const hex of [PRF, OTHER_PRF]) t.absent(seen.includes(hex), 'no prf in any output')
})

test('the prf buffer and both pairs are zeroed after the call', async (t) => {
  const { session, keys, host } = setup()
  await host.install(params())
  t.ok(keys.seen.length >= 2)
  for (const prf of keys.seen) t.ok(allZero(prf), 'prf zeroed after success')
  for (const kp of session.received) {
    t.ok(allZero(kp.secretKey) && allZero(kp.publicKey), 'pair handed to the session zeroed')
  }
  t.is(session.receivedPrf.length, 1)
  for (const prf of session.receivedPrf) t.ok(allZero(prf), 'prf handed to the session zeroed by the worklet')

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

  // A resumed install refused by the barrier (a startup resume racing the
  // ceremony) changes nothing: the ceremony's save can still lift it.
  const third = setup()
  await third.host.forget()
  await third.host.install(params())
  err = await third.host.install(params({ resumed: true })).catch((e) => e)
  t.is(err.code, 'USAGE', 'the resumed install is refused')
  t.alike(await third.host.sessionSaved(), {}, 'sessionSaved still lifts the barrier')
  t.is((await third.host.status()).signedOut, false)
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

const MEDIA_NAME = '0123456789abcdef0123456789abcdef.bin'

function mediaDirs (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-media-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }), { force: true })
  const cacheDir = path.join(root, 'cache')
  fs.mkdirSync(cacheDir)
  return { root, cacheDir }
}

// fs.promises with every call recorded, to prove a refused name touches
// nothing.
function recordingFs () {
  const calls = []
  return {
    calls,
    lstat: (p) => { calls.push(['lstat', p]); return fs.promises.lstat(p) },
    open: (p, flags) => { calls.push(['open', p]); return fs.promises.open(p, flags) }
  }
}

function readMedia (fsApi, cacheDir, name, max = 4096) {
  return readMediaFile({ fs: fsApi, join: path.join, cacheDir, name, max, flags: fs.constants.O_RDONLY })
}

test('isMediaName accepts only the host-generated cache name', (t) => {
  const hex = MEDIA_NAME.slice(0, 32)
  t.ok(isMediaName(MEDIA_NAME))
  const bad = [
    '', null, 1, hex, hex + '.jpg', hex + '.BIN', hex.toUpperCase() + '.bin', hex.slice(1) + '.bin',
    hex + 'a.bin', '../' + hex.slice(3) + '.bin', '/' + hex.slice(1) + '.bin',
    hex.slice(0, 16) + '/' + hex.slice(17) + '.bin', '..', hex + '.bin/', hex + '.bin\n'
  ]
  for (const name of bad) t.absent(isMediaName(name), JSON.stringify(name))
})

test('readMediaFile reads the named file from cacheDir and returns its path', async (t) => {
  const { cacheDir } = mediaDirs(t)
  const data = new Uint8Array(300).map((_, i) => i % 256)
  fs.writeFileSync(path.join(cacheDir, MEDIA_NAME), data)
  const fsApi = recordingFs()
  const { file, bytes } = await readMedia(fsApi, cacheDir, MEDIA_NAME)
  t.is(file, path.join(cacheDir, MEDIA_NAME))
  t.alike(bytes, data)
  t.alike(fsApi.calls.map((c) => c[1]), [file, file], 'only the joined path is touched')
})

test('readMediaFile refuses a bad name without touching the file system', async (t) => {
  const { root, cacheDir } = mediaDirs(t)
  const outside = path.join(root, MEDIA_NAME)
  fs.writeFileSync(outside, 'secret')
  const fsApi = recordingFs()
  for (const name of ['../' + MEDIA_NAME, outside, MEDIA_NAME.toUpperCase(), 'a.bin', undefined]) {
    const err = await readMedia(fsApi, cacheDir, name).catch((e) => e)
    t.is(err.code, 'USAGE', String(name))
    t.is(err.message, 'arquivo de mídia inválido')
  }
  t.alike(fsApi.calls, [], 'no lstat or open')
  const err = await readMedia(fsApi, '', MEDIA_NAME).catch((e) => e)
  t.is(err.code, 'USAGE', 'no cacheDir')
})

test('readMediaFile refuses a link, a directory, a missing file and a bad size', async (t) => {
  const { root, cacheDir } = mediaDirs(t)
  const target = path.join(root, 'outside.bin')
  fs.writeFileSync(target, 'secret')
  const link = 'a'.repeat(32) + '.bin'
  fs.symlinkSync(target, path.join(cacheDir, link))
  const dir = 'b'.repeat(32) + '.bin'
  fs.mkdirSync(path.join(cacheDir, dir))
  const empty = 'c'.repeat(32) + '.bin'
  fs.writeFileSync(path.join(cacheDir, empty), '')
  const big = 'd'.repeat(32) + '.bin'
  fs.writeFileSync(path.join(cacheDir, big), new Uint8Array(11))
  const missing = 'e'.repeat(32) + '.bin'
  for (const name of [link, dir, missing]) {
    const err = await readMedia(fs.promises, cacheDir, name).catch((e) => e)
    t.is(err.message, 'arquivo de mídia inválido', name.slice(0, 1))
  }
  for (const name of [empty, big]) {
    const err = await readMedia(fs.promises, cacheDir, name, 10).catch((e) => e)
    t.is(err.message, 'mídia inválida', name.slice(0, 1))
  }
  t.is(fs.readFileSync(target, 'utf8'), 'secret')
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
    unlink: (file) => unlinked.push(file),
    isClosing: lifecycle.isClosing
  }, { mime: 'image/jpeg', width: 1, height: 1 }))

  const uploading = upload()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const closing = lifecycle.close()
  const bytes = new Uint8Array([1, 2, 3])
  finishRead({ file: '/cache/photo.jpg', bytes })
  const err = await uploading.catch((e) => e)
  t.is(err.code, 'LOCKED', 'the upload fails with the closed error')
  t.is(mediaUploads, 0, 'mediaUpload never started')
  t.alike(unlinked, [], 'a refused file is not unlinked')
  t.ok(bytes.every((b) => b === 0), 'the bytes are zeroed')
  const timeout = new Promise((resolve) => setTimeout(resolve, 1000, 'timeout'))
  t.is(await Promise.race([closing.then(() => 'closed'), timeout]), 'closed')
  t.ok(sessionClosed && storage.closed)
})

test('uploadMedia hands sealed to the session only when true', async (t) => {
  const seen = []
  const session = { mediaUpload: (args) => { seen.push(Object.keys(args)); return Promise.resolve({ ok: true }) } }
  const io = { read: async () => ({ file: '/cache/p.jpg', bytes: new Uint8Array(4) }), session, unlink: () => {}, isClosing: () => false }
  await uploadMedia(io, { mime: 'image/jpeg', width: 1, height: 1, sealed: true })
  await uploadMedia(io, { mime: 'image/jpeg', width: 1, height: 1, sealed: false })
  await uploadMedia(io, { mime: 'image/jpeg', width: 1, height: 1 })
  t.alike(seen, [['bytes', 'mime', 'width', 'height', 'sealed'], ['bytes', 'mime', 'width', 'height'], ['bytes', 'mime', 'width', 'height']])
})

test('a voice note carries its duration and kind to the session; an image never does', async (t) => {
  const seen = []
  const session = {
    mediaUpload: (args) => { seen.push(['upload', Object.keys(args), args.ms, args.kind]); return Promise.resolve({ ok: true }) },
    dmPutMedia: (args) => { seen.push(['dm', Object.keys(args), args.ms, args.kind]); return Promise.resolve({ ok: true }) }
  }
  const io = { read: async () => ({ file: '/cache/v.bin', bytes: new Uint8Array(4) }), session, unlink: () => {}, isClosing: () => false }
  await uploadMedia(io, { mime: 'audio/mp4', width: 0, height: 0, ms: 2500, kind: 'voice', sealed: true })
  await putDmMedia(io, { mime: 'audio/mp4', width: 0, height: 0, ms: 2500, kind: 'voice', to: 'ef'.repeat(32) })
  await uploadMedia(io, { mime: 'image/jpeg', width: 1, height: 1, ms: 5, kind: 'other' })
  t.alike(seen[0], ['upload', ['bytes', 'mime', 'width', 'height', 'ms', 'kind', 'sealed'], 2500, 'voice'])
  t.alike(seen[1], ['dm', ['bytes', 'mime', 'width', 'height', 'ms', 'kind', 'to'], 2500, 'voice'])
  t.alike(seen[2], ['upload', ['bytes', 'mime', 'width', 'height'], undefined, undefined], 'an image keeps its exact keys')
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
    read: async () => ({ file: '/cache/p.jpg', bytes: new Uint8Array(4) }),
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

// Recovery controls (docs/rpc.md 5.91 to 5.94).

const WRAP_PRF = 'c3'.repeat(32)
const NEW_PRF = 'd4'.repeat(32)
const MARK_HEX = b4a.toString(recovery.WRAP_MARK, 'hex')
const MARKED_USER = 'ab'.repeat(16) + MARK_HEX
// src/identity.native.js UNKNOWN_WRAP_USER_ID: a recovery passkey with no handle.
const UNKNOWN_WRAP_USER = '00'.repeat(16) + MARK_HEX
const bytesOf = (hex) => new Uint8Array(b4a.from(hex, 'hex'))

function recoverySetup ({ clock = { t: 1000 } } = {}) {
  const session = fakeSession()
  const storage = memoryNodeStorage()
  const host = createIdentityHost({ session, storage, hkdf, randomBytes, now: () => clock.t })
  return { session, storage, host, clock }
}

async function blobFor (rootHex, secret, kind, member) {
  const { lookupId, wrapKey } = await recovery.deriveRecoveryKeys(secret, kind, { hkdf })
  const blob = recovery.wrapRoot({ root: bytesOf(rootHex), member, kind, wrapKey, randomBytes })
  return { lookupId, blob }
}

test('recoveryLookup + recoveryOpen of a passkey blob return the original root', async (t) => {
  const { host, session } = recoverySetup()
  const member = await expectedPublicKey(PRF)
  const made = await blobFor(PRF, bytesOf(WRAP_PRF), 'passkey', member)
  const { lookupId } = await host.recoveryLookup({ kind: 'passkey', secret: WRAP_PRF })
  t.is(lookupId, made.lookupId)
  const out = await host.recoveryOpen({ blob: made.blob, member })
  t.alike(out, { prf: PRF })
  t.is(session.keyPair, null, 'open installs nothing')
  await t.exception(host.recoveryOpen({ blob: made.blob, member }), /entrada de recuperação inválida/, 'the pending key is consumed')
})

test('recoveryLookup + recoveryOpen of a code blob return the root once', async (t) => {
  const { host } = recoverySetup()
  const member = await expectedPublicKey(PRF)
  const secret = randomBytes(recovery.CODE_BYTES)
  const code = recovery.encodeCode(secret)
  const made = await blobFor(PRF, secret, 'code', member)
  const { lookupId } = await host.recoveryLookup({ kind: 'code', code: code.toUpperCase().replace(/-/g, ' ') })
  t.is(lookupId, made.lookupId)
  t.alike(await host.recoveryOpen({ blob: made.blob, member }), { prf: PRF })
})

test('recoveryLookup refuses a bad code', async (t) => {
  const { host } = recoverySetup()
  const err = await host.recoveryLookup({ kind: 'code', code: '0000-0000' }).catch((e) => e)
  t.is(err.code, 'USAGE')
  t.is(err.message, 'código de recuperação inválido')
})

test('recoveryOpen without a pending key, expired, or of another kind is refused', async (t) => {
  const { host, clock } = recoverySetup()
  const member = await expectedPublicKey(PRF)
  const made = await blobFor(PRF, bytesOf(WRAP_PRF), 'passkey', member)
  const missing = await host.recoveryOpen({ blob: made.blob, member }).catch((e) => e)
  t.is(missing.code, 'USAGE')
  t.is(missing.message, 'entrada de recuperação inválida')

  await host.recoveryLookup({ kind: 'passkey', secret: WRAP_PRF })
  clock.t += RECOVERY_PENDING_MS + 1
  await t.exception(host.recoveryOpen({ blob: made.blob, member }), /entrada de recuperação inválida/, 'expired')

  const code = recovery.encodeCode(randomBytes(recovery.CODE_BYTES))
  await host.recoveryLookup({ kind: 'code', code })
  await t.exception(host.recoveryOpen({ blob: made.blob, member }), /entrada de recuperação inválida/, 'a code key never opens a passkey blob')
})

test('a bad blob or another member is refused with the fixed message and installs nothing', async (t) => {
  const { host, session, storage } = recoverySetup()
  const member = await expectedPublicKey(PRF)
  const made = await blobFor(PRF, bytesOf(WRAP_PRF), 'passkey', member)

  await host.recoveryLookup({ kind: 'passkey', secret: WRAP_PRF })
  const tampered = { ...made.blob, ciphertext: (made.blob.ciphertext[0] === '0' ? '1' : '0') + made.blob.ciphertext.slice(1) }
  const err = await host.recoveryOpen({ blob: tampered, member }).catch((e) => e)
  t.is(err.code, 'USAGE')
  t.is(err.message, 'entrada de recuperação inválida')
  await t.exception(host.recoveryOpen({ blob: made.blob, member }), /entrada de recuperação inválida/, 'a failure clears the pending key')

  await host.recoveryLookup({ kind: 'passkey', secret: WRAP_PRF })
  await t.exception(host.recoveryOpen({ blob: made.blob, member: 'ee'.repeat(32) }), /entrada de recuperação inválida/, 'another member')

  // Sealed with a member key that is not the root's own.
  const liar = await blobFor(PRF, bytesOf(WRAP_PRF), 'passkey', 'ee'.repeat(32))
  await host.recoveryLookup({ kind: 'passkey', secret: WRAP_PRF })
  await t.exception(host.recoveryOpen({ blob: liar.blob, member: 'ee'.repeat(32) }), /entrada de recuperação inválida/, 'member must derive from the root')

  t.is(session.keyPair, null)
  t.is(await storage.readJson('passkey'), null)
})

test('recoveryWrap output opens with lib/recovery to the same root', async (t) => {
  const { host } = recoverySetup()
  const { publicKey } = await host.install(params())

  const pk = await host.recoveryWrap({ kind: 'passkey', secret: WRAP_PRF })
  const pkKeys = await recovery.deriveRecoveryKeys(bytesOf(WRAP_PRF), 'passkey', { hkdf })
  t.is(pk.lookupId, pkKeys.lookupId)
  t.is(pk.code, undefined)
  const opened = recovery.openRoot(pk.blob, pkKeys.wrapKey, { member: publicKey })
  t.is(b4a.toString(opened.root, 'hex'), PRF)

  const cd = await host.recoveryWrap({ kind: 'code' })
  t.ok(/^([0-9a-z]{4}-){8}[0-9a-z]{4}$/.test(cd.code))
  const secret = recovery.decodeCode(cd.code)
  const cdKeys = await recovery.deriveRecoveryKeys(secret, 'code', { hkdf })
  t.is(cd.lookupId, cdKeys.lookupId)
  const openedCode = recovery.openRoot(cd.blob, cdKeys.wrapKey, { member: publicKey })
  t.is(b4a.toString(openedCode.root, 'hex'), PRF)
})

test('recoveryWrap is LOCKED without a root; clear, forget, reset and close drop it', async (t) => {
  const { host } = recoverySetup()
  const locked = await host.recoveryWrap({ kind: 'code' }).catch((e) => e)
  t.is(locked.code, 'USAGE')
  t.is(locked.message, 'identidade bloqueada: entre com a passkey')

  for (const drop of ['clear', 'forget', 'reset', 'close']) {
    await host.install(params())
    await host.recoveryWrap({ kind: 'code' })
    await host[drop]()
    await t.exception(host.recoveryWrap({ kind: 'code' }), /identidade bloqueada/, drop + ' drops the root')
    await t.exception(host.recoveryBind({ credentialId: 'cred-2', userId: MARKED_USER }), /identidade bloqueada/, drop + ': bind needs the root')
  }
})

test('a failed install drops the root', async (t) => {
  const { session, host } = recoverySetup()
  await host.install(params())
  await host.install(params({ prf: 'zz' })).catch(() => {})
  t.ok(session.keyPair !== null, 'the earlier pairs stay')
  await t.exception(host.recoveryWrap({ kind: 'code' }), /identidade bloqueada/)
})

test('the root, the secret and the pending key are zeroed', async (t) => {
  const { host } = recoverySetup()
  const fills = []
  const realFill = Uint8Array.prototype.fill
  await host.install(params())
  const member = await expectedPublicKey(PRF)
  const made = await blobFor(PRF, bytesOf(WRAP_PRF), 'passkey', member)
  // Record what every 32-byte buffer held when it was zeroed during lookup,
  // open and clear.
  // A spy on fill: the held root and the pending key are not reachable otherwise.
  Uint8Array.prototype.fill = function (v, ...rest) { // eslint-disable-line no-extend-native
    if (v === 0 && this.length === 32) fills.push({ buf: this, was: b4a.toString(b4a.from(this), 'hex') })
    return realFill.call(this, v, ...rest)
  }
  try {
    await host.recoveryLookup({ kind: 'passkey', secret: WRAP_PRF })
    await host.recoveryOpen({ blob: made.blob, member })
    await host.clear()
  } finally {
    Uint8Array.prototype.fill = realFill // eslint-disable-line no-extend-native
  }
  const pkKeys = await recovery.deriveRecoveryKeys(bytesOf(WRAP_PRF), 'passkey', { hkdf })
  const was = fills.map((f) => f.was)
  t.ok(was.includes(WRAP_PRF), 'the wrapping secret is zeroed')
  t.ok(was.includes(b4a.toString(pkKeys.wrapKey, 'hex')), 'the pending wrap key is zeroed')
  t.ok(was.filter((h) => h === PRF).length >= 2, 'the opened root and the held root are zeroed')
  t.ok(fills.every((f) => allZero(f.buf)))
})

// Without the PRF the session never unlocks the direct message store or the
// private group box keys: the in-app node showed no conversations.
test('setKeyPair receives the media pair and the prf, as the browser entry', async (t) => {
  const session = fakeSession()
  const storage = memoryNodeStorage()
  const calls = []
  const orig = session.setKeyPair
  session.setKeyPair = function (kp, opts) {
    calls.push({ keys: Object.keys(opts).sort(), prf: opts.prf ? b4a.toString(b4a.from(opts.prf), 'hex') : null })
    return orig.call(session, kp, opts)
  }
  const host = createIdentityHost({ session, storage, hkdf, randomBytes })
  await host.install(params())
  t.alike(calls, [{ keys: ['media', 'prf'], prf: PRF }])
  t.is(b4a.toString(b4a.from(session.prf), 'hex'), PRF, 'the session keeps its own copy')
  await host.clear()
  t.is(session.prf, null, 'clear drops the session copy')
})

test('recoveryBind rebinds the passkey record and status reports userId', async (t) => {
  const { host, storage } = recoverySetup()
  await host.install(params())
  t.alike(await host.recoveryBind({ credentialId: 'cred-2', userId: MARKED_USER }), {})
  t.alike(await storage.readJson('passkey'), { v: 1, credentialId: 'cred-2', rpId: 'varanda.example', userId: MARKED_USER })
  const status = await host.status()
  t.is(status.credentialId, 'cred-2')
  t.is(status.userId, MARKED_USER)
  await host.recoveryBind({ credentialId: 'cred-3', userId: UNKNOWN_WRAP_USER })
  t.is((await host.status()).userId, UNKNOWN_WRAP_USER)
})

test('recoveryBind refuses a user id without the wrap mark', async (t) => {
  const { host, storage } = recoverySetup()
  await host.install(params())
  for (const userId of ['', 'ab'.repeat(32), MARK_HEX + 'ab'.repeat(16), 'zz', undefined]) {
    const err = await host.recoveryBind({ credentialId: 'cred-2', userId }).catch((e) => e)
    t.is(err.code, 'USAGE', String(userId))
    t.is(err.message, 'passkey de recuperação inválida')
  }
  t.is((await storage.readJson('passkey')).credentialId, 'cred-1', 'the record is unchanged')
})

test('a recovery passkey with no handle is bound marked and status says so', async (t) => {
  const { host } = recoverySetup()
  await host.install(params({ credentialId: 'cred-r', userId: UNKNOWN_WRAP_USER }))
  const status = await host.status()
  t.is(status.credentialId, 'cred-r')
  t.is(status.userId, UNKNOWN_WRAP_USER)
  t.ok(recovery.isWrapUserId(status.userId))
})

test('a failed install drops the pending wrap key and the root', async (t) => {
  const member = await expectedPublicKey(PRF)
  const made = await blobFor(PRF, bytesOf(WRAP_PRF), 'passkey', member)

  // MISMATCH: the stored diary is another identity.
  const session = fakeSession({ diaryKey: 'ee'.repeat(32) })
  const storage = memoryNodeStorage()
  const host = createIdentityHost({ session, storage, hkdf, randomBytes })
  await host.recoveryLookup({ kind: 'passkey', secret: WRAP_PRF })
  const mismatch = await host.install(params()).catch((e) => e)
  t.is(mismatch.message, 'passkey não corresponde ao diário guardado')
  await t.exception(host.recoveryOpen({ blob: made.blob, member }), /entrada de recuperação inválida/, 'MISMATCH dropped the pending key')
  await t.exception(host.recoveryWrap({ kind: 'code' }), /identidade bloqueada/)

  // The passkey record cannot be written.
  const { host: host2, storage: storage2 } = recoverySetup()
  const write = storage2.writeJson.bind(storage2)
  storage2.writeJson = async (key, value) => {
    if (key === 'passkey' && value !== null) throw new Error('disk full')
    return write(key, value)
  }
  await host2.recoveryLookup({ kind: 'passkey', secret: WRAP_PRF })
  await t.exception(host2.install(params()), /disk full/)
  await t.exception(host2.recoveryOpen({ blob: made.blob, member }), /entrada de recuperação inválida/, 'a record failure dropped the pending key')
  await t.exception(host2.recoveryWrap({ kind: 'code' }), /identidade bloqueada/)
})

test('a recovered root installs the same identity', async (t) => {
  const { host } = recoverySetup()
  const member = await expectedPublicKey(NEW_PRF)
  const made = await blobFor(NEW_PRF, bytesOf(WRAP_PRF), 'passkey', member)
  await host.recoveryLookup({ kind: 'passkey', secret: WRAP_PRF })
  const { prf } = await host.recoveryOpen({ blob: made.blob, member })
  const out = await host.install(params({ prf }))
  t.is(out.publicKey, member)
})

test('putDmMedia hands the photo to dmPutMedia, zeroes it and unlinks after success', async (t) => {
  const seen = []
  const unlinked = []
  const bytes = new Uint8Array([1, 2, 3])
  const session = { dmPutMedia: (args) => { seen.push({ ...args, copy: new Uint8Array(args.bytes) }); return Promise.resolve({ id: 'x' }) } }
  const io = { read: async () => ({ file: '/cache/p.bin', bytes }), session, unlink: (f) => unlinked.push(f), isClosing: () => false }
  const dest = 'ef'.repeat(32)
  t.alike(await putDmMedia(io, { mime: 'image/png', width: 2, height: 3, sealed: true, to: dest }), { id: 'x' })
  t.alike(Object.keys(seen[0]), ['bytes', 'mime', 'width', 'height', 'to', 'copy'], 'no sealed on the blob channel')
  t.alike(seen[0].copy, new Uint8Array([1, 2, 3]))
  t.ok(bytes.every((b) => b === 0), 'the bytes are zeroed')
  t.alike(unlinked, ['/cache/p.bin'])

  await putDmMedia({ ...io, read: async () => ({ file: '/cache/r.bin', bytes: new Uint8Array([4]) }) }, { mime: 'image/png', width: 2, height: 3, to: dest })
  t.is(seen[1].to, dest, 'the destination reaches the session (rpc 5.97)')
  await putDmMedia({ ...io, read: async () => ({ file: '/cache/s.bin', bytes: new Uint8Array([5]) }) }, { mime: 'image/png', width: 2, height: 3 })
  t.ok('to' in seen[2] && seen[2].to === undefined, 'a missing destination still reaches the session, which refuses it')

  const failing = { ...io, read: async () => ({ file: '/cache/q.bin', bytes: new Uint8Array(1) }), session: { dmPutMedia: () => { throw new TypeError('mídia inválida') } } }
  const err = await putDmMedia(failing, { mime: 'image/png', width: 1, height: 1, to: dest }).catch((e) => e)
  t.is(err.code, 'USAGE')
  t.alike(unlinked, ['/cache/p.bin', '/cache/r.bin', '/cache/s.bin'], 'a refused file is not unlinked')
  const closing = await putDmMedia({ ...io, isClosing: () => true }, { mime: 'image/png', width: 1, height: 1, to: dest }).catch((e) => e)
  t.is(closing.code, 'LOCKED')
})

test('putMomentMedia hands the photo to momentPutMedia with only the image fields', async (t) => {
  const seen = []
  const unlinked = []
  const bytes = new Uint8Array([1, 2, 3])
  const session = { momentPutMedia: (args) => { seen.push({ ...args, copy: new Uint8Array(args.bytes) }); return Promise.resolve({ id: 'm' }) } }
  const io = { read: async () => ({ file: '/cache/m.bin', bytes }), session, unlink: (f) => unlinked.push(f), isClosing: () => false }
  t.alike(await putMomentMedia(io, { mime: 'image/jpeg', width: 2, height: 3, to: 'ef'.repeat(32), ms: 5, kind: 'voice', sealed: true }), { id: 'm' })
  t.alike(Object.keys(seen[0]), ['bytes', 'mime', 'width', 'height', 'copy'], 'no destination, voice or sealed fields')
  t.alike(seen[0].copy, new Uint8Array([1, 2, 3]))
  t.ok(bytes.every((b) => b === 0), 'the bytes are zeroed')
  t.alike(unlinked, ['/cache/m.bin'])

  const failing = { ...io, read: async () => ({ file: '/cache/n.bin', bytes: new Uint8Array(1) }), session: { momentPutMedia: () => { throw new TypeError('mídia inválida') } } }
  const err = await putMomentMedia(failing, { mime: 'image/jpeg', width: 1, height: 1 }).catch((e) => e)
  t.is(err.code, 'USAGE')
  t.is(err.message, 'mídia inválida')
  t.alike(unlinked, ['/cache/m.bin'], 'a refused file is not unlinked')
  const closing = await putMomentMedia({ ...io, isClosing: () => true }, { mime: 'image/jpeg', width: 1, height: 1 }).catch((e) => e)
  t.is(closing.code, 'LOCKED')
})

test('a video upload and a video momento carry mime, sides, duration and kind to the session', async (t) => {
  const seen = []
  const session = {
    mediaUpload: (args) => { seen.push(['upload', { ...args, bytes: undefined }, Object.keys(args)]); return Promise.resolve({ ok: true }) },
    momentPutMedia: (args) => { seen.push(['moment', { ...args, bytes: undefined }, Object.keys(args)]); return Promise.resolve({ id: 'm' }) },
    dmPutMedia: (args) => { seen.push(['dm', { ...args, bytes: undefined }, Object.keys(args)]); return Promise.resolve({ id: 'd' }) }
  }
  const io = { read: async () => ({ file: '/cache/v.bin', bytes: new Uint8Array(4) }), session, unlink: () => {}, isClosing: () => false }
  await uploadMedia(io, { mime: 'video/mp4', width: 360, height: 640, ms: 12000, kind: 'video', sealed: false })
  await putMomentMedia(io, { mime: 'video/mp4', width: 720, height: 1280, ms: 9000, kind: 'video', sealed: true, to: 'ef'.repeat(32) })
  await putDmMedia(io, { mime: 'video/mp4', width: 360, height: 640, ms: 12000, kind: 'video', to: 'ef'.repeat(32) })
  t.alike(seen[0][2], ['bytes', 'mime', 'width', 'height', 'ms', 'kind'])
  t.alike({ mime: seen[0][1].mime, width: seen[0][1].width, height: seen[0][1].height, ms: seen[0][1].ms, kind: seen[0][1].kind }, { mime: 'video/mp4', width: 360, height: 640, ms: 12000, kind: 'video' })
  t.alike(seen[1][2], ['bytes', 'mime', 'width', 'height', 'ms', 'kind'], 'a video momento: no destination or sealed field')
  t.alike({ mime: seen[1][1].mime, width: seen[1][1].width, height: seen[1][1].height, ms: seen[1][1].ms, kind: seen[1][1].kind }, { mime: 'video/mp4', width: 720, height: 1280, ms: 9000, kind: 'video' })
  t.alike(seen[2][2], ['bytes', 'mime', 'width', 'height', 'to'], 'a DM carries voice fields only, never a video kind')
})

test('writeReadFile creates the file exclusively with mode 0600; clearReadDir removes read files only', async (t) => {
  const { root } = mediaDirs(t)
  const dir = path.join(root, 'media-read')
  await clearReadDir({ fs: fs.promises, join: path.join, dir })
  t.ok(fs.statSync(dir).isDirectory(), 'the dir is created')
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
  const bytes = new Uint8Array(70000).map((_, i) => i % 251)
  t.is(await writeReadFile({ fs: fs.promises, join: path.join, dir, name: MEDIA_NAME, bytes, flags }), MEDIA_NAME)
  const file = path.join(dir, MEDIA_NAME)
  t.alike(new Uint8Array(fs.readFileSync(file)), bytes)
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  const again = await writeReadFile({ fs: fs.promises, join: path.join, dir, name: MEDIA_NAME, bytes: new Uint8Array(1), flags }).catch((e) => e)
  t.is(again.code, 'INTERNAL', 'an existing name is never written through')
  t.alike(new Uint8Array(fs.readFileSync(file)), bytes, 'and is left as it was')
  const linked = '1'.repeat(32) + '.bin'
  fs.writeFileSync(path.join(root, 'target'), 'secret')
  fs.symlinkSync(path.join(root, 'target'), path.join(dir, linked))
  const noExcl = fs.constants.O_WRONLY | fs.constants.O_CREAT
  const viaLink = await writeReadFile({ fs: fs.promises, join: path.join, dir, name: linked, bytes, flags: noExcl }).catch((e) => e)
  t.is(viaLink.code, 'INTERNAL', 'a planted link is refused without O_EXCL too')
  t.is(fs.readFileSync(path.join(root, 'target'), 'utf8'), 'secret')
  fs.unlinkSync(path.join(dir, linked))
  const bad = await writeReadFile({ fs: fs.promises, join: path.join, dir, name: '../x.bin', bytes, flags }).catch((e) => e)
  t.is(bad.code, 'INTERNAL')
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x')
  await clearReadDir({ fs: fs.promises, join: path.join, dir })
  t.alike(fs.readdirSync(dir), ['keep.txt'])
})

test('readMediaToFile opens a DM or group item through the session and writes it', async (t) => {
  const written = []
  // A 3x2 PNG that mediaBounds accepts.
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAAAAAC4HznGAAAAC0lEQVR4nGNggAAAAAgAAbdYc5UAAAAASUVORK5CYII=', 'base64'))
  const calls = []
  const session = {
    dmReadMedia: async (args) => { calls.push(['dm', args]); return { bytes: new Uint8Array(png), mime: 'image/png' } },
    groupReadMedia: async (args) => { calls.push(['group', args]); return { bytes: new Uint8Array(png), mime: 'image/png', w: 4, h: 6 } }
  }
  let gen = 0
  const io = {
    session,
    write: async (bytes) => { written.push(new Uint8Array(bytes)); return MEDIA_NAME },
    unlink: () => {},
    generation: () => gen,
    isClosing: () => false
  }
  const dm = await readMediaToFile(io, { kind: 'dm', from: 'a', id: 'b', index: 0 })
  t.alike(calls[0], ['dm', { from: 'a', id: 'b', index: 0 }])
  t.alike(dm, { name: MEDIA_NAME, mime: 'image/png', w: 3, h: 2 })
  t.alike(written[0], png)
  const g = await readMediaToFile(io, { kind: 'group', diary: 'd', item: { x: 1 } })
  t.alike(calls[1], ['group', { diary: 'd', item: { x: 1 } }])
  t.alike(g, { name: MEDIA_NAME, mime: 'image/png', w: 3, h: 2 }, 'the size comes from the bytes, not the item')
  t.alike(await readMediaToFile(io, { kind: 'dm', from: 'a', id: 'b', index: 'card' }), dm)
  t.alike(calls[2], ['dm', { from: 'a', id: 'b', index: 'card' }])

  const momentSession = {
    momentReadMedia: async (args) => { calls.push(['moment', args]); return { bytes: new Uint8Array(png), mime: 'image/png', w: 9, h: 9 } }
  }
  const m = await readMediaToFile({ ...io, session: momentSession }, { kind: 'moment', author: 'k', seq: 4 })
  t.alike(calls[3], ['moment', { author: 'k', seq: 4 }], 'only the moment fields reach the session')
  t.alike(m, { name: MEDIA_NAME, mime: 'image/png', w: 3, h: 2 }, 'the size comes from the bytes')
  const badMoment = await readMediaToFile({ ...io, session: { momentReadMedia: () => { throw new TypeError('x') } } }, { kind: 'moment' }).catch((e) => e)
  t.is(badMoment.code, 'USAGE')
  t.is(badMoment.message, 'mídia inválida')
  const gone = Object.assign(new Error('foto indisponível'), { code: 'NOT_FOUND' })
  const missing = await readMediaToFile({ ...io, session: { momentReadMedia: async () => { throw gone } } }, { kind: 'moment', author: 'k', seq: 4 }).catch((e) => e)
  t.is(missing, gone, 'a gone blob keeps the session error')

  const unlinked = []
  const racing = {
    ...io,
    write: async () => { gen++; return MEDIA_NAME },
    unlink: (name) => unlinked.push(name)
  }
  const err = await readMediaToFile(racing, { kind: 'dm', from: 'a', id: 'b', index: 0 }).catch((e) => e)
  t.is(err.code, 'LOCKED', 'a lock during the read keeps nothing')
  t.alike(unlinked, [MEDIA_NAME])

  const refused = await readMediaToFile({ ...io, session: { dmReadMedia: () => { throw new TypeError('x') } } }, { kind: 'dm' }).catch((e) => e)
  t.is(refused.code, 'USAGE')
  const closed = await readMediaToFile({ ...io, isClosing: () => true }, { kind: 'dm' }).catch((e) => e)
  t.is(closed.code, 'LOCKED')
})

test('readMediaToFile refuses bytes mediaBounds rejects: nothing written, plaintext zeroed', async (t) => {
  const written = []
  const handed = []
  const huge = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xff, 0xff, 0xff, 0xff, 0, 0, 0])
  const answers = [
    { bytes: huge, mime: 'image/gif' },
    { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), mime: 'image/png', w: 3, h: 2 },
    { bytes: new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAAAAAC4HznGAAAAC0lEQVR4nGNggAAAAAgAAbdYc5UAAAAASUVORK5CYII=', 'base64')), mime: 'image/gif' }
  ]
  for (const answer of answers) {
    handed.push(answer.bytes)
    const io = {
      session: { dmReadMedia: async () => answer },
      write: async (bytes) => { written.push(bytes); return MEDIA_NAME },
      unlink: () => {},
      generation: () => 0,
      isClosing: () => false
    }
    const err = await readMediaToFile(io, { kind: 'dm', from: 'a', id: 'b', index: 0 }).catch((e) => e)
    t.is(err.code, 'USAGE')
    t.is(err.message, 'mídia indisponível')
  }
  t.is(written.length, 0, 'no plaintext file is written')
  t.ok(handed.every((b) => b.every((x) => x === 0)), 'the refused plaintext is zeroed')
})

test('readMediaToFile checks a voice note as audio: a sound-only MPEG-4 passes, a video track does not', async (t) => {
  const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  const ascii = (str) => Array.from(str, (c) => c.charCodeAt(0))
  const box = (type, ...parts) => { const body = parts.flat(); return [...be32(8 + body.length), ...ascii(type), ...body] }
  const minf = box('minf', box('dinf', box('dref', [0, 0, 0, 0], be32(1), box('url ', [0, 0, 0, 1]))), box('stbl', box('stsd', [0, 0, 0, 0], be32(1), box('mp4a', new Array(28).fill(0), box('esds', [0, 0, 0, 0], [3, 25, 0, 1, 0, 4, 17, 64, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 2, 18, 16, 6, 1, 2]))), box('stts', [0, 0, 0, 0], be32(1), be32(2500), be32(1)), box('stsz', [0, 0, 0, 0], be32(1), be32(2500)), box('stsc', [0, 0, 0, 0], be32(1), be32(1), be32(2500), be32(1)), box('stco', [0, 0, 0, 0], be32(1), be32(0))))
  const trak = (handler) => box('trak', box('tkhd', new Array(84).fill(0)), box('mdia', box('mdhd', new Array(12).fill(0), be32(1000), be32(0), [0, 0, 0, 0]), box('hdlr', [0, 0, 0, 0], be32(0), ascii(handler), be32(0), be32(0), be32(0), [0]), minf))
  const m4a = (tracks) => new Uint8Array([...box('ftyp', ascii('M4A '), be32(0), ascii('M4A '), ascii('isom')), ...box('moov', box('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(2500), new Array(80).fill(0)), ...tracks.map(trak)), ...box('mdat', new Array(2504).fill(1))])
  let serve = m4a(['soun'])
  const written = []
  const io = {
    // The session's ms is a claim: the answer carries the container's.
    session: { dmReadMedia: async () => ({ bytes: new Uint8Array(serve), mime: 'audio/mp4', ms: 1 }), groupReadMedia: async () => ({ bytes: new Uint8Array(serve), mime: 'audio/mp4' }) },
    write: async (bytes) => { written.push(bytes.length); return MEDIA_NAME },
    unlink: () => {},
    generation: () => 0,
    isClosing: () => false
  }
  t.alike(await readMediaToFile(io, { kind: 'dm', from: 'a', id: 'b', index: 0 }), { name: MEDIA_NAME, mime: 'audio/mp4', w: 0, h: 0, ms: 2500 }, 'the container duration')
  serve = m4a(['soun', 'vide'])
  const err = await readMediaToFile(io, { kind: 'group', diary: 'd', item: { x: 1 } }).then(() => null, (e) => e)
  t.ok(err !== null && err.code === 'USAGE', 'a container with a video track is refused')
  t.is(written.length, 1, 'nothing written for the refused one')
})

// A synthetic H.264 MP4 with no binary fixture, as
// packages/rpc/test/video-bounds.test.js builds it: one video track of 90
// samples of 100 ticks at 3000 a second (3 s), coded 640x360, turned 90
// degrees when `turn`.
function mp4Video ({ turn = false, moovExtra = [] } = {}) {
  const be16 = (v) => [(v >>> 8) & 0xff, v & 0xff]
  const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  const ascii = (str) => Array.from(str, (c) => c.charCodeAt(0))
  const zeros = (n) => new Array(n).fill(0)
  const box = (type, ...parts) => { const body = parts.flat(); return [...be32(8 + body.length), ...ascii(type), ...body] }
  const ONE = 0x10000
  const matrix = turn ? [0, ONE, 0, -ONE, 0, 0, 0, 0, 0x40000000] : [ONE, 0, 0, 0, ONE, 0, 0, 0, 0x40000000]
  const tkhd = box('tkhd', [0, 0, 0, 7], be32(7), be32(9), be32(1), be32(0), be32(3000), zeros(16), ...matrix.map((v) => be32(v >>> 0)), be32(640 * ONE), be32(360 * ONE))
  const avcC = box('avcC', [1, 100, 0, 40, 0xff, 0xe1], be16(6), [0x67, 100, 0, 40, 0xac, 0xd9], [1], be16(4), [0x68, 0xeb, 0xe3, 0xcb])
  const avc1 = box('avc1', zeros(6), be16(1), zeros(16), be16(640), be16(360), be32(0x480000), be32(0x480000), be32(0), be16(1), [4, ...ascii('x264'), ...zeros(27)], be16(0x18), be16(0xffff), avcC)
  const moovAt = (offset) => box('moov',
    box('mvhd', [0, 0, 0, 0], be32(7), be32(9), be32(1000), be32(3000), zeros(80)),
    box('trak', tkhd, box('mdia',
      box('mdhd', [0, 0, 0, 0], be32(7), be32(9), be32(3000), be32(9000), [0x55, 0xc4, 0, 0]),
      box('hdlr', [0, 0, 0, 0], be32(0), ascii('vide'), zeros(12), ascii('VideoHandler'), [0]),
      box('minf', box('vmhd', [0, 0, 0, 1], zeros(8)), box('dinf', box('dref', [0, 0, 0, 0], be32(1), box('url ', [0, 0, 0, 1]))),
        box('stbl', box('stsd', [0, 0, 0, 0], be32(1), avc1), box('stts', [0, 0, 0, 0], be32(1), be32(90), be32(100)),
          box('stsc', [0, 0, 0, 0], be32(1), be32(1), be32(90), be32(1)), box('stsz', [0, 0, 0, 0], be32(0), be32(90), ...new Array(90).fill(be32(10))),
          box('stco', [0, 0, 0, 0], be32(1), be32(offset)))))),
    ...moovExtra)
  const ftyp = box('ftyp', ascii('isom'), be32(0x200), ascii('isom'), ascii('avc1'))
  const offset = ftyp.length + moovAt(0).length + 8
  return new Uint8Array([...ftyp, ...moovAt(offset), ...box('mdat', new Array(900).fill(1))])
}

test('readMediaToFile measures a video strictly: duration and display size from the bytes', async (t) => {
  const written = []
  // The session's ms, w and h are claims: the answer carries the container's.
  const session = {
    momentReadMedia: async () => ({ bytes: mp4Video({ turn: true }), mime: 'video/mp4', w: 1, h: 1, ms: 1 }),
    groupReadMedia: async () => ({ bytes: mp4Video(), mime: 'video/mp4' })
  }
  const io = {
    session,
    write: async (bytes) => { written.push(new Uint8Array(bytes)); return MEDIA_NAME },
    unlink: () => {},
    generation: () => 0,
    isClosing: () => false
  }
  t.alike(await readMediaToFile(io, { kind: 'moment', author: 'k', seq: 2 }), { name: MEDIA_NAME, mime: 'video/mp4', w: 360, h: 640, ms: 3000 }, 'a turned video answers its display size')
  t.alike(written[0], mp4Video({ turn: true }), 'the bytes are written as they came')
  t.alike(await readMediaToFile(io, { kind: 'group', diary: 'd', item: { x: 1 } }), { name: MEDIA_NAME, mime: 'video/mp4', w: 640, h: 360, ms: 3000 })
})

test('readMediaToFile refuses a video the strict check rejects: nothing written, plaintext zeroed', async (t) => {
  const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  // A camera's place box: only the sender's own file may carry metadata.
  const udta = [...be32(16), 0x75, 0x64, 0x74, 0x61, ...be32(8), 0x66, 0x72, 0x65, 0x65]
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAAAAAC4HznGAAAAC0lEQVR4nGNggAAAAAgAAbdYc5UAAAAASUVORK5CYII=', 'base64'))
  const answers = [
    { bytes: mp4Video({ moovExtra: [udta] }), mime: 'video/mp4', w: 640, h: 360, ms: 3000 },
    { bytes: mp4Video().slice(0, 300), mime: 'video/mp4', w: 640, h: 360, ms: 3000 },
    { bytes: png, mime: 'video/mp4', w: 3, h: 2, ms: 3000 },
    { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), mime: 'video/mp4' }
  ]
  const written = []
  for (const answer of answers) {
    const io = {
      session: { momentReadMedia: async () => answer },
      write: async (bytes) => { written.push(bytes); return MEDIA_NAME },
      unlink: () => {},
      generation: () => 0,
      isClosing: () => false
    }
    const err = await readMediaToFile(io, { kind: 'moment', author: 'k', seq: 2 }).catch((e) => e)
    t.is(err.code, 'USAGE')
    t.is(err.message, 'mídia indisponível')
  }
  t.is(written.length, 0, 'no plaintext file is written')
  t.ok(answers.every((a) => a.bytes.every((x) => x === 0)), 'the refused plaintext is zeroed')
})

test('a video file named with a path is refused before any read', async (t) => {
  const { cacheDir: cache } = mediaDirs(t)
  fs.writeFileSync(path.join(cache, 'clip.mp4'), mp4Video())
  const sent = []
  const session = { mediaUpload: (args) => { sent.push(args); return Promise.resolve({ ok: true }) }, momentPutMedia: (args) => { sent.push(args); return Promise.resolve({ ok: true }) } }
  for (const name of ['clip.mp4', '../' + MEDIA_NAME, 'sub/' + MEDIA_NAME, path.join(cache, MEDIA_NAME)]) {
    const read = () => readMediaFile({ fs: fs.promises, join: path.join, cacheDir: cache, name, max: 1 << 23, flags: fs.constants.O_RDONLY })
    const io = { read, session, unlink: () => {}, isClosing: () => false }
    const up = await uploadMedia(io, { mime: 'video/mp4', width: 640, height: 360, ms: 3000, kind: 'video' }).catch((e) => e)
    t.is(up.code, 'USAGE', 'upload ' + name)
    t.is(up.message, 'arquivo de mídia inválido')
    const mo = await putMomentMedia(io, { mime: 'video/mp4', width: 640, height: 360, ms: 3000, kind: 'video' }).catch((e) => e)
    t.is(mo.code, 'USAGE', 'momento ' + name)
  }
  t.is(sent.length, 0, 'nothing reached the session')
})
