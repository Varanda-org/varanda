'use strict'
// The pure parts of worklet/web-node.js, apart so the Node tests reach them
// (web-node.js itself loads bare-fs, bare-crypto and bare-ws).

const { RpcError, mediaBounds } = require('@varanda/rpc')

const CLOSED_MESSAGE = 'sessão encerrada'
const BAD_MEDIA = 'mídia inválida'
const BAD_MEDIA_FILE = 'arquivo de mídia inválido'
const MEDIA_UNAVAILABLE = 'mídia indisponível'
// The only file names media.uploadFile accepts (docs/rpc.md 5.56): what the
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

// Sends the bytes of a cache file read() -> { file, bytes } to put(bytes)
// only while the node is not closing; the bytes are zeroed once put copied
// them and the file is unlinked only after a successful put.
async function sendFile ({ read, put, unlink, isClosing }) {
  const { file, bytes } = await read()
  let putting
  try {
    if (isClosing()) throw closedError()
    putting = put(bytes)
  } catch (err) {
    if (err instanceof RpcError) throw err
    // Synchronous validation (lib/session.js TypeError 'mídia inválida').
    throw new RpcError('USAGE', BAD_MEDIA)
  } finally {
    bytes.fill(0)
  }
  const result = await putting
  await Promise.resolve().then(() => unlink(file)).catch(() => {})
  return result
}

// media.uploadFile after the read. `sealed` must reach the session: dropping
// it would store a private group's photo in the clear (docs/rpc.md 5.56).
function uploadMedia ({ read, session, unlink, isClosing }, { mime, width, height, sealed }) {
  return sendFile({
    read,
    unlink,
    isClosing,
    put: (bytes) => session.mediaUpload(sealed === true ? { bytes, mime, width, height, sealed } : { bytes, mime, width, height })
  })
}

// dm.putMedia after the read (docs/rpc.md 5.88): the same file rules, the
// photo sealed and put on the blob channel by the session.
function putDmMedia ({ read, session, unlink, isClosing }, { mime, width, height }) {
  return sendFile({ read, unlink, isClosing, put: (bytes) => session.dmPutMedia({ bytes, mime, width, height }) })
}

// Removes every read file (a media name) directly under `dir` and makes
// sure the directory exists. Never throws: a file left here holds an opened
// image, so the next clear tries again.
async function clearReadDir ({ fs, join, dir }) {
  try { await fs.mkdir(dir, { recursive: true, mode: 0o700 }) } catch {}
  let names = []
  try { names = await fs.readdir(dir) } catch {}
  for (const name of names) {
    if (typeof name === 'string' && isMediaName(name)) await fs.unlink(join(dir, name)).catch(() => {})
  }
}

// Writes `bytes` to a fresh file under `dir` with mode 0600 (`flags`:
// O_CREAT | O_WRONLY, plus O_EXCL where the fs has it; bare-fs 4.8 exports
// none). Nothing that already exists is written through: the name must be
// absent (lstat) and the opened descriptor an empty regular file. -> the
// file name. A failed write leaves no file of ours.
async function writeReadFile ({ fs, join, dir, name, bytes, flags }) {
  if (!isMediaName(name)) throw new RpcError('INTERNAL', 'erro interno')
  const file = join(dir, name)
  let handle = null
  let created = false
  try {
    const existing = await fs.lstat(file).then(() => true, (err) => err === null || typeof err !== 'object' || err.code !== 'ENOENT')
    if (existing) throw new Error('exists')
    handle = await fs.open(file, flags, 0o600)
    created = true
    const st = await handle.stat()
    if (!st.isFile() || st.size !== 0) {
      created = false
      throw new Error('not a fresh file')
    }
    let at = 0
    while (at < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, at, bytes.byteLength - at, at)
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw new Error('short write')
      at += bytesWritten
    }
    await handle.close()
    handle = null
    return name
  } catch {
    if (handle !== null) await handle.close().catch(() => {})
    if (created) await Promise.resolve().then(() => fs.unlink(file)).catch(() => {})
    throw new RpcError('INTERNAL', 'erro interno')
  }
}

// media.readFile (docs/rpc.md 5.89): opens the chat item through the session
// and writes the plaintext with write(bytes) -> name. `generation()` changes
// on every lock: an image opened before a lock never stays on disk after it.
// -> { name, mime, w, h } (w, h measured from the bytes). The plaintext copy
// is zeroed once written, or refused (USAGE 'mídia indisponível').
async function readMediaToFile ({ session, write, unlink, generation, isClosing }, params) {
  const at = generation()
  let opened
  try {
    if (isClosing()) throw closedError()
    opened = params.kind === 'dm'
      ? session.dmReadMedia({ from: params.from, id: params.id, index: params.index })
      : session.groupReadMedia({ diary: params.diary, item: params.item })
  } catch (err) {
    if (err instanceof RpcError) throw err
    throw new RpcError('USAGE', BAD_MEDIA)
  }
  const got = await opened
  const bytes = got.bytes
  let name
  let w
  let h
  try {
    // The bytes decide, never the item's claimed size: an image past the
    // canvas or frame limits, or not the mime it says, is never written for
    // a native decoder to open.
    let b = null
    try { b = mediaBounds(bytes, got.mime) } catch {}
    if (b === null) throw new RpcError('USAGE', MEDIA_UNAVAILABLE)
    w = b.width
    h = b.height
    if (isClosing() || generation() !== at) throw closedError()
    name = await write(bytes)
  } finally {
    bytes.fill(0)
  }
  if (isClosing() || generation() !== at) {
    await Promise.resolve().then(() => unlink(name)).catch(() => {})
    throw closedError()
  }
  return { name, mime: got.mime, w, h }
}

module.exports = { readAll, readMediaFile, isMediaName, createLifecycle, uploadMedia, putDmMedia, clearReadDir, writeReadFile, readMediaToFile, CLOSED_MESSAGE }
