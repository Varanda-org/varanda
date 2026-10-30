// Native, web kind: the handle of the in-app web node (the browser node's
// session inside the Bare worklet, src/client/native.js), shaped like
// connectBrowserNode's (src/client/browser.js; docs/rpc.md section 11) so
// src/node.js treats both alike. The host controls cross the IPC as the
// IPC-only methods of docs/rpc.md 5.50 to 5.56.
//
// The identity API is src/identity.native.js (the passkey ceremony on the
// device, the PRF output handed over by identity.install). The handle exists
// as soon as the connection is up, so node.passkey is non-null while locked,
// as on the web; the stored session is resumed right then, and status()
// waits for that attempt so the first read already reports it.

/* global crypto */

import { File } from 'expo-file-system'
import { rpIdOf, installationOrigin } from '../installation'
import { createNativeIdentity } from '../identity'
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

function progress (onProgress, value) {
  if (typeof onProgress !== 'function') return
  try { onProgress(value) } catch {}
}

// request(method, params): the connection's request (connect.native.js).
export function webNodeHandle (request) {
  const native = createNativeIdentity({ request, rpId: rpIdOrNull })
  native.resume()
  const identity = {
    status: native.status,
    unlock: native.unlock,
    complete: native.complete,
    lock: native.lock,
    signOut: native.signOut,
    reset: native.reset
  }

  // The bytes go through a file in the upload dir: one IPC request is capped
  // at 64 KiB (docs/rpc.md 5.56). Only its name crosses the IPC; the worklet
  // finds it under the cacheDir it was started with. The worklet deletes the file after a
  // successful upload; on any failure it is deleted here.
  const media = {
    upload: async ({ bytes, mime, width, height, onProgress } = {}) => {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new TypeError('mídia inválida')
      const name = randomName()
      const file = new File(uploadDirectory(), name)
      try {
        file.create()
        file.write(bytes)
        progress(onProgress, 0.25)
        const descriptor = await request('media.uploadFile', { name, mime, width, height })
        progress(onProgress, 1)
        return descriptor
      } catch (err) {
        removeQuietly(file)
        throw err
      }
    }
  }

  // The in-app web node starts on fresh storage, so it never kept follows
  // from before follow records: nothing to confirm, and no follows IPC exists.
  const follows = {
    legacy: async () => ({ keys: [] }),
    confirmLegacy: async () => ({ published: 0 })
  }

  return { identity, media, follows }
}
