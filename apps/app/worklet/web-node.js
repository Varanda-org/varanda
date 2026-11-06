'use strict'
// The `web` node kind of the worklet (worklet/main.js): the browser node's
// session (packages/web-member/lib/session.js, a compat Hypercore 10 diary
// whose key is the passkey-derived key) on file storage under
// <dataDir>/web-node, syncing with the installation's seeder over
// wss://<installation>/seeder (bare-ws). It answers the same handlers as
// the browser page's node plus the IPC-only host controls of docs/rpc.md
// 5.50 to 5.56, 5.88 and 5.89 (./identity-install.js, media.uploadFile,
// dm.putMedia and media.readFile below), and recovery's 5.91 to 5.94
// (./identity-install.js).
//
// The storage's exclusive LOCK (fileNodeStorage lock(), fs-native-extensions)
// is taken before anything is opened, and every handler waits for it: a
// held lock (another worklet of the fixed NODE_WORKLET_ID still alive,
// src/client/native.js) or a lock that cannot be taken refuses every
// request with LOCKED and the storage is never touched. Building the
// session opens nothing (lib/session.js only checks its configuration).
//
// The web session has no suspend/resume: its lease redials when needed.
const fs = require('bare-fs')
const path = require('bare-path')
const crypto = require('bare-crypto')
const { Socket } = require('bare-ws')
const { RpcError } = require('@varanda/rpc')
const { fileNodeStorage } = require('@varanda/web-member/lib/file-storage')
const { createBrowserSession } = require('@varanda/web-member/lib/session')
const { duplexSocket } = require('@varanda/web-member/lib/duplex-socket')
const { hkdfSha256 } = require('@varanda/web-member/lib/hkdf')
const { MAX_MEDIA_ITEM_BLOCKS, MEDIA_BLOCK_BYTES } = require('@varanda/core/lib/records')
const { createIdentityHost } = require('./identity-install')
const { createBareFetch } = require('./bare-fetch')
const { readMediaFile, createLifecycle, uploadMedia, putDmMedia, clearReadDir, writeReadFile, readMediaToFile } = require('./web-node-parts')

const MAX_MEDIA_ITEM_BYTES = MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES
// The browser entry's lease values (packages/web-member/web/node.js).
const LEASE_HOLD_MS = 8000
const LEASE_GAP_MS = 45000
const DATA_DIR_IN_USE = 'diretório de dados em uso'
const LOCK_UNAVAILABLE = 'trava do diretório indisponível'
const BAD_MEDIA_FILE = 'arquivo de mídia inválido'
// media.readFile output (docs/rpc.md 5.89), inside the data dir. The host
// computes the same path (src/client/webnode.native.js).
const READ_DIR = 'media-read'

function hmac (key, data) {
  return crypto.createHmac('sha256', key).update(data).digest()
}

function hkdf (ikm, salt, info, length) {
  return hkdfSha256(ikm, salt, info, length, { hmac })
}

function randomBytes (n) {
  return crypto.randomBytes(n)
}

function hex (bytes) {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

function lockRefusal (err) {
  const code = err !== null && typeof err === 'object' ? err.code : null
  if (code === 'LOCKED') return new RpcError('LOCKED', DATA_DIR_IN_USE)
  if (code === 'LOCK_UNAVAILABLE') return new RpcError('LOCKED', LOCK_UNAVAILABLE)
  return new RpcError('INTERNAL', 'erro interno')
}

// args: the worklet's start argument ({ dataDir, cacheDir, association,
// seederUrl }). -> { handlers, attach, detach, close }; throws on an
// invalid configuration (nothing opened then).
function createWebNode (args, { onInternalError } = {}) {
  if (typeof args.dataDir !== 'string' || args.dataDir === '') throw new TypeError('dataDir required')
  const cacheDir = typeof args.cacheDir === 'string' && args.cacheDir !== '' ? args.cacheDir : null
  const storage = fileNodeStorage(path.join(args.dataDir, 'web-node'))
  const session = createBrowserSession({
    storage,
    association: args.association,
    seederUrl: args.seederUrl,
    createSocket: (url) => duplexSocket(new Socket(url)),
    leaseHoldMs: LEASE_HOLD_MS,
    leaseGapMs: LEASE_GAP_MS,
    // Bare has no globalThis.fetch: group and DM media download through this.
    fetchMedia: createBareFetch({ http: require('bare-http1'), https: require('bare-https') }),
    onInternalError
  })
  const identity = createIdentityHost({ session, storage, hkdf, randomBytes })

  const locking = storage.lock()
  locking.catch(() => {})
  const ready = () => locking.catch((err) => { throw lockRefusal(err) })

  const lifecycle = createLifecycle({ session, storage, locking })

  function readCacheFile (name) {
    return readMediaFile({
      fs: fs.promises,
      join: path.join,
      cacheDir,
      name,
      max: MAX_MEDIA_ITEM_BYTES,
      flags: fs.constants.O_RDONLY
    })
  }

  const unlink = (file) => fs.promises.unlink(file)

  function uploadFile ({ name, mime, width, height, sealed, ms, kind }) {
    if (cacheDir === null) throw new RpcError('USAGE', BAD_MEDIA_FILE)
    return uploadMedia({ read: () => readCacheFile(name), session, unlink, isClosing: lifecycle.isClosing }, { mime, width, height, sealed, ms, kind })
  }

  function putMedia ({ name, mime, width, height, ms, kind, to }) {
    if (cacheDir === null) throw new RpcError('USAGE', BAD_MEDIA_FILE)
    return putDmMedia({ read: () => readCacheFile(name), session, unlink, isClosing: lifecycle.isClosing }, { mime, width, height, ms, kind, to })
  }

  // Opened chat images on disk: cleared at start, on every lock and at
  // close, so none outlives the unlocked session that opened it. Only once
  // the LOCK is ours: a held lock means another worklet owns that dir.
  const readDir = path.join(args.dataDir, READ_DIR)
  let lockGeneration = 0
  const clearReads = () => clearReadDir({ fs: fs.promises, join: path.join, dir: readDir })
  const clearing = locking.then(clearReads, () => {})

  function readFile (params) {
    return readMediaToFile({
      session,
      write: async (bytes) => {
        await clearing
        return writeReadFile({
          fs: fs.promises,
          join: path.join,
          dir: readDir,
          name: hex(randomBytes(16)) + '.bin',
          bytes,
          flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_EXCL || 0)
        })
      },
      unlink: (name) => fs.promises.unlink(path.join(readDir, name)),
      generation: () => lockGeneration,
      isClosing: lifecycle.isClosing
    }, params)
  }

  async function afterLock (fn) {
    lockGeneration++
    try {
      return await fn()
    } finally {
      await clearReads()
    }
  }

  const handlers = {}
  for (const [name, fn] of Object.entries(session.handlers)) {
    handlers[name] = async (params) => {
      await ready()
      return fn(params)
    }
  }
  // The identity controls write to the storage outside the session's
  // chain: close() drains them before the session and the LOCK go. Uploads
  // are drained after the session closed (it cancels their sync).
  const controls = {
    'identity.install': (params) => identity.install(params),
    'identity.clear': () => afterLock(() => identity.clear()),
    'identity.status': () => identity.status(),
    'identity.reset': () => afterLock(() => identity.reset()),
    'identity.forget': () => afterLock(() => identity.forget()),
    'identity.sessionSaved': () => identity.sessionSaved(),
    'identity.recoveryLookup': (params) => identity.recoveryLookup(params),
    'identity.recoveryOpen': (params) => identity.recoveryOpen(params),
    'identity.recoveryWrap': (params) => identity.recoveryWrap(params),
    'identity.recoveryBind': (params) => identity.recoveryBind(params)
  }
  for (const [name, fn] of Object.entries(controls)) {
    handlers[name] = lifecycle.guard(async (params) => {
      await ready()
      return fn(params)
    })
  }
  handlers['media.uploadFile'] = lifecycle.guardUpload(async (params) => {
    await ready()
    return uploadFile(params)
  })
  handlers['dm.putMedia'] = lifecycle.guardUpload(async (params) => {
    await ready()
    return putMedia(params)
  })
  handlers['media.readFile'] = lifecycle.guardUpload(async (params) => {
    await ready()
    return readFile(params)
  })

  return {
    handlers,
    attach: (emit) => session.attach(emit),
    detach: () => session.detach(),
    // The held root and any pending wrap key go before and after the drain
    // (a control still running could set them again); the read files go
    // once any lock in flight settled.
    close: async () => {
      identity.close()
      lockGeneration++
      try {
        return await lifecycle.close()
      } finally {
        identity.close()
        await locking.then(clearReads, () => {})
      }
    }
  }
}

module.exports = { createWebNode }
