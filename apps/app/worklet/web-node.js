'use strict'
// The `web` node kind of the worklet (worklet/main.js): the browser node's
// session (packages/web-member/lib/session.js, a compat Hypercore 10 diary
// whose key is the passkey-derived key) on file storage under
// <dataDir>/web-node, syncing with the installation's seeder over
// wss://<installation>/seeder (bare-ws). It answers the same handlers as
// the browser page's node plus the IPC-only host controls of docs/rpc.md
// 5.50 to 5.56 (./identity-install.js and media.uploadFile below).
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
const { readMediaFile, createLifecycle, uploadMedia } = require('./web-node-parts')

const MAX_MEDIA_ITEM_BYTES = MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES
// The browser entry's lease values (packages/web-member/web/node.js).
const LEASE_HOLD_MS = 8000
const LEASE_GAP_MS = 45000
const DATA_DIR_IN_USE = 'diretório de dados em uso'
const LOCK_UNAVAILABLE = 'trava do diretório indisponível'
const BAD_MEDIA_FILE = 'arquivo de mídia inválido'

function hmac (key, data) {
  return crypto.createHmac('sha256', key).update(data).digest()
}

function hkdf (ikm, salt, info, length) {
  return hkdfSha256(ikm, salt, info, length, { hmac })
}

function randomBytes (n) {
  return crypto.randomBytes(n)
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
    onInternalError
  })
  const identity = createIdentityHost({ session, storage, hkdf, randomBytes })

  const locking = storage.lock()
  locking.catch(() => {})
  const ready = () => locking.catch((err) => { throw lockRefusal(err) })

  const lifecycle = createLifecycle({ session, storage, locking })

  function uploadFile ({ name, mime, width, height }) {
    if (cacheDir === null) throw new RpcError('USAGE', BAD_MEDIA_FILE)
    return uploadMedia({
      read: () => readMediaFile({
        fs: fs.promises,
        join: path.join,
        cacheDir,
        name,
        max: MAX_MEDIA_ITEM_BYTES,
        flags: fs.constants.O_RDONLY
      }),
      session,
      unlink: (file) => fs.promises.unlink(file),
      isClosing: lifecycle.isClosing
    }, { mime, width, height })
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
    'identity.clear': () => identity.clear(),
    'identity.status': () => identity.status(),
    'identity.reset': () => identity.reset(),
    'identity.forget': () => identity.forget(),
    'identity.sessionSaved': () => identity.sessionSaved()
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

  return {
    handlers,
    attach: (emit) => session.attach(emit),
    detach: () => session.detach(),
    close: lifecycle.close
  }
}

module.exports = { createWebNode }
