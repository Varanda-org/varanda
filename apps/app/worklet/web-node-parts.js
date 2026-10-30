'use strict'
// The pure parts of worklet/web-node.js, apart so the Node tests reach them
// (web-node.js itself loads bare-fs, bare-crypto and bare-ws).

const { RpcError } = require('@varanda/rpc')

const CLOSED_MESSAGE = 'sessão encerrada'
const BAD_MEDIA = 'mídia inválida'

function closedError () {
  return new RpcError('LOCKED', CLOSED_MESSAGE)
}

// Reads exactly `size` bytes from a bare-fs FileHandle-shaped `handle`
// (read(buffer, offset, length, position) -> { bytesRead }). -> the bytes,
// or null when size is outside 1..max or the file ends early (it changed
// under us). Never reads past `size`.
async function readAll (handle, size, max) {
  if (!Number.isSafeInteger(size) || size < 1 || size > max) return null
  const bytes = new Uint8Array(size)
  let at = 0
  while (at < size) {
    const { bytesRead } = await handle.read(bytes, at, size - at, at)
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > size - at) break
    at += bytesRead
  }
  if (at !== size) {
    bytes.fill(0)
    return null
  }
  return bytes
}

// The web node's shutdown order. close():
//   1. marks closing: guard() / guardUpload() refuse new work (LOCKED
//      'sessão encerrada', the session's own after-close error);
//   2. waits for the identity controls (short local writes that must land);
//   3. closes the session, which cancels a media upload already running
//      (an upload still reading its file never starts one: uploadMedia
//      checks isClosing() right before session.mediaUpload);
//   4. waits for the uploads, bounded now that the session is closed;
//   5. closes the storage, which releases the LOCK.
function createLifecycle ({ session, storage, locking = Promise.resolve() }) {
  const controls = new Set()
  const uploads = new Set()
  let closing = null

  function track (set, fn) {
    return (...args) => {
      if (closing !== null) return Promise.reject(closedError())
      const p = Promise.resolve().then(() => fn(...args))
      const settled = p.then(() => {}, () => {})
      set.add(settled)
      settled.then(() => set.delete(settled))
      return p
    }
  }

  async function drain (set) {
    while (set.size > 0) await Promise.all([...set])
  }

  function close () {
    if (closing !== null) return closing
    closing = (async () => {
      try {
        await drain(controls)
        await session.detach()
        await session.close()
        await drain(uploads)
      } finally {
        await locking.catch(() => {})
        await storage.close()
      }
    })()
    return closing
  }

  return {
    guard: (fn) => track(controls, fn),
    guardUpload: (fn) => track(uploads, fn),
    isClosing: () => closing !== null,
    close
  }
}

// media.uploadFile after the jailed read: read() -> { real, bytes }; the
// bytes go to session.mediaUpload only while the node is not closing, are
// zeroed once the session copied them, and the file is unlinked only after
// a successful upload.
async function uploadMedia ({ read, session, unlink, isClosing }, { mime, width, height }) {
  const { real, bytes } = await read()
  let uploading
  try {
    if (isClosing()) throw closedError()
    uploading = session.mediaUpload({ bytes, mime, width, height })
  } catch (err) {
    if (err instanceof RpcError) throw err
    // Synchronous validation (lib/session.js TypeError 'mídia inválida').
    throw new RpcError('USAGE', BAD_MEDIA)
  } finally {
    bytes.fill(0)
  }
  const descriptor = await uploading
  await Promise.resolve().then(() => unlink(real)).catch(() => {})
  return descriptor
}

module.exports = { readAll, createLifecycle, uploadMedia, CLOSED_MESSAGE }
