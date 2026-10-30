'use strict'
// The pure parts of worklet/web-node.js, apart so the Node tests reach them
// (web-node.js itself loads bare-fs, bare-crypto and bare-ws).

const { RpcError } = require('@varanda/rpc')

const CLOSED_MESSAGE = 'sessão encerrada'
const BAD_MEDIA = 'mídia inválida'
const BAD_MEDIA_FILE = 'arquivo de mídia inválido'
// The only file names media.uploadFile accepts (docs/rpc.md 5.41): what the
// host generates in its cache directory, so no separator, dot segment or
// link target can be named.
const MEDIA_NAME_RE = /^[0-9a-f]{32}\.bin$/

function isMediaName (v) {
  return typeof v === 'string' && MEDIA_NAME_RE.test(v)
}

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

// The read of media.uploadFile -> { file, bytes }. `fs` is promises-shaped
// (lstat, open -> handle with stat/read/close), `join` joins paths, `flags`
// opens read-only. The file is `name` directly under `cacheDir`, the
// directory given at worklet start: no caller path is resolved, so there is
// no check-then-use window on a path the caller chose. Every refusal is
// USAGE BAD_MEDIA_FILE (or BAD_MEDIA for the size) and names nothing: an fs
// error message carries the path.
async function readMediaFile ({ fs, join, cacheDir, name, max, flags }) {
  if (typeof cacheDir !== 'string' || cacheDir === '' || !isMediaName(name)) throw new RpcError('USAGE', BAD_MEDIA_FILE)
  const file = join(cacheDir, name)
  let handle = null
  try {
    // bare-fs has no O_NOFOLLOW: lstat refuses a link at the final
    // component, and the opened descriptor must be that same regular file
    // (dev and ino), so a swap between the two calls is refused.
    let before
    try {
      before = await fs.lstat(file)
      if (!before.isFile()) throw new Error('not a regular file')
      handle = await fs.open(file, flags)
    } catch {
      throw new RpcError('USAGE', BAD_MEDIA_FILE)
    }
    const st = await handle.stat()
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) throw new RpcError('USAGE', BAD_MEDIA_FILE)
    if (st.size < 1 || st.size > max) throw new RpcError('USAGE', BAD_MEDIA)
    const bytes = await readAll(handle, st.size, max)
    if (bytes === null) throw new RpcError('USAGE', BAD_MEDIA_FILE)
    return { file, bytes }
  } catch (err) {
    if (err instanceof RpcError) throw err
    throw new RpcError('USAGE', BAD_MEDIA_FILE)
  } finally {
    if (handle !== null) await handle.close().catch(() => {})
  }
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

// media.uploadFile after the read: read() -> { file, bytes }; the
// bytes go to session.mediaUpload only while the node is not closing, are
// zeroed once the session copied them, and the file is unlinked only after
// a successful upload.
async function uploadMedia ({ read, session, unlink, isClosing }, { mime, width, height }) {
  const { file, bytes } = await read()
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
  await Promise.resolve().then(() => unlink(file)).catch(() => {})
  return descriptor
}

module.exports = { readAll, readMediaFile, isMediaName, createLifecycle, uploadMedia, CLOSED_MESSAGE }
