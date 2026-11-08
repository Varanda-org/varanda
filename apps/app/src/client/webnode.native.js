// Native, web kind: the handle of the in-app web node (the browser node's
// session inside the Bare worklet, src/client/native.js), shaped like
// connectBrowserNode's (src/client/browser.js; docs/rpc.md section 11) so
// src/node.js treats both alike. The host controls cross the IPC as the
// IPC-only methods of docs/rpc.md 5.50 to 5.56, 5.88, 5.89, and recovery's 5.91 to 5.94.
//
// The identity API is src/identity.native.js (the passkey ceremony on the
// device, the PRF output handed over by identity.install). The handle exists
// as soon as the connection is up, so node.passkey is non-null while locked,
// as on the web; the stored session is resumed right then, and status()
// waits for that attempt so the first read already reports it.

/* global crypto */

import { Directory, File, Paths } from 'expo-file-system'
import { rpIdOf, installationOrigin } from '../installation'
import { createNativeIdentity } from '../identity'
import { sweepVoiceCache } from '../media/audio'
import { uploadDirectory } from './native'

function rpIdOrNull () {
  try {
    return rpIdOf(installationOrigin())
  } catch {
    return null
  }
}

function randomName () {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex + '.bin'
}

function removeQuietly (file) {
  try { if (file.exists) file.delete() } catch {}
}

// media.readFile output: <dataDir>/media-read (worklet/web-node.js
// READ_DIR) under the hosted kind's data dir, <documents>/varanda
// (./native.js defaultDataDir).
const READ_NAME_RE = /^[0-9a-f]{32}\.bin$/

function readFileUri (name) {
  const base = Paths.document.uri.endsWith('/') ? Paths.document.uri : Paths.document.uri + '/'
  return base + 'varanda/media-read/' + name
}

// The read files this app process was handed and has not released yet.
const readFiles = new Set()

function deleteReadFile (name) {
  readFiles.delete(name)
  removeQuietly(new File(readFileUri(name)))
}

// The cache releases one image (eviction) or all of them; lock, sign-out
// and reset release all. The worklet sweeps the dir on start and on lock
// too, so a file missed here never outlives the next lock.
export function forgetReadFile (name) {
  if (typeof name === 'string' && READ_NAME_RE.test(name)) deleteReadFile(name)
}

export function clearReadFiles () {
  for (const name of [...readFiles]) deleteReadFile(name)
}

// A crash or force-quit while photos were open leaves plaintext behind:
// deleted here before any read, even if the worklet's own start sweep fails.
function sweepReadDir () {
  try {
    const dir = new Directory(readFileUri(''))
    if (!dir.exists) return
    for (const entry of dir.list()) {
      if (entry instanceof File && READ_NAME_RE.test(entry.name)) {
        readFiles.delete(entry.name)
        removeQuietly(entry)
      }
    }
  } catch {}
}

function progress (onProgress, value) {
  if (typeof onProgress !== 'function') return
  try { onProgress(value) } catch {}
}

// request(method, params): the connection's request (connect.native.js).
// The voice fields, only for a voice note: an image request keeps its exact
// four or five keys.
function voiceOf ({ ms, kind }) {
  return kind === 'voice' ? { ms, kind } : {}
}

export function webNodeHandle (request) {
  sweepReadDir()
  sweepVoiceCache()
  const native = createNativeIdentity({ request, rpId: rpIdOrNull })
  native.resume()
  const afterLock = (fn) => async (...args) => {
    try {
      return await fn(...args)
    } finally {
      clearReadFiles()
    }
  }
  const identity = {
    status: native.status,
    unlock: native.unlock,
    complete: native.complete,
    lock: afterLock(native.lock),
    signOut: afterLock(native.signOut),
    reset: afterLock(native.reset),
    unlockWrapped: native.unlockWrapped,
    unlockWithCode: native.unlockWithCode,
    cancelRecovery: native.cancelRecovery,
    finishRecovery: native.finishRecovery,
    addPasskey: native.addPasskey,
    bindPasskey: native.bindPasskey,
    makeRecoveryCode: native.makeRecoveryCode,
    confirm: native.confirm,
    enrolment: native.enrolment,
    dropEnrolment: native.dropEnrolment
  }

  // The bytes go through a file in the upload dir: one IPC request is capped
  // at 64 KiB (docs/rpc.md 5.56). Only its name crosses the IPC; the worklet
  // finds it under the cacheDir it was started with. The worklet deletes the
  // file after a successful upload; on any failure it is deleted here.
  async function sendFile (bytes, method, params, onProgress) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new TypeError('mídia inválida')
    const name = randomName()
    const file = new File(uploadDirectory(), name)
    try {
      file.create()
      file.write(bytes)
      progress(onProgress, 0.25)
      const result = await request(method, { name, ...params })
      progress(onProgress, 1)
      return result
    } catch (err) {
      removeQuietly(file)
      throw err
    }
  }

  // The answers come the other way through a file too: an opened photo is
  // far above MAX_MESSAGE (docs/rpc.md 5.89). ref: { kind: 'dm', from, id,
  // index }, { kind: 'group', diary, item } or { kind: 'moment', author,
  // seq } (5.103) -> { uri, mime, w, h }.
  const media = {
    // A voice note also carries its duration and kind (docs/rpc.md 5.56, 5.88).
    upload: ({ bytes, mime, width, height, sealed, ms, kind, onProgress } = {}) =>
      sendFile(bytes, 'media.uploadFile', { mime, width, height, ...voiceOf({ ms, kind }), ...(sealed === true ? { sealed } : {}) }, onProgress),
    // `to`, the destination, is required: it keys the sealed blob to one
    // conversation (5.97).
    putDm: async ({ bytes, mime, width, height, ms, kind, to } = {}) => {
      if (typeof to !== 'string' || !/^[0-9a-f]{64}$/.test(to)) throw new TypeError('mídia inválida')
      return sendFile(bytes, 'dm.putMedia', { to, mime, width, height, ...voiceOf({ ms, kind }) })
    },
    // A momento's photo: a fresh blob of its own (5.103), image only.
    putMoment: ({ bytes, mime, width, height } = {}) =>
      sendFile(bytes, 'moment.putMedia', { mime, width, height }),
    read: async (ref) => {
      if (ref === null || typeof ref !== 'object') throw new TypeError('mídia inválida')
      let params
      if (ref.kind === 'dm') params = { kind: 'dm', from: ref.from, id: ref.id, index: ref.index }
      else if (ref.kind === 'moment') params = { kind: 'moment', author: ref.author, seq: ref.seq }
      else params = { kind: 'group', diary: ref.diary, item: ref.item }
      const got = await request('media.readFile', params)
      const name = got !== null && typeof got === 'object' ? got.name : null
      if (typeof name !== 'string' || !READ_NAME_RE.test(name)) throw new Error('resposta inválida')
      readFiles.add(name)
      return { uri: readFileUri(name), mime: got.mime, w: got.w, h: got.h, ...(Number.isSafeInteger(got.ms) ? { ms: got.ms } : {}) }
    },
    forgetReadFile,
    clearReadFiles
  }

  // The in-app web node starts on fresh storage, so it never kept follows
  // from before follow records: nothing to confirm, and no follows IPC exists.
  const follows = {
    legacy: async () => ({ keys: [] }),
    confirmLegacy: async () => ({ published: 0 })
  }

  return { identity, media, follows }
}
