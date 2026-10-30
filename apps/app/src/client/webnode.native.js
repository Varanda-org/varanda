// Native, web kind: the handle of the in-app web node (the browser node's
// session inside the Bare worklet, src/client/native.js), shaped like
// connectBrowserNode's (src/client/browser.js; docs/rpc.md section 11) so
// src/node.js treats both alike. The host controls cross the IPC as the
// IPC-only methods of docs/rpc.md 5.35 to 5.41.
//
// The passkey ceremony is not wired yet: status reports no WebAuthn, and
// unlock / complete refuse with UNSUPPORTED. The handle exists as soon as the
// connection is up, so node.passkey is non-null while locked, as on the web.

/* global crypto */

import { File } from 'expo-file-system'
import { rpIdOf, installationOrigin } from '../installation'
import { uploadDirectory, uriToPath } from './native'

// packages/web-member/lib/passkey.js MESSAGES.UNSUPPORTED.
const UNSUPPORTED_MESSAGE = 'este endereço não pode usar passkeys'

function unsupported () {
  const err = new Error(UNSUPPORTED_MESSAGE)
  err.code = 'UNSUPPORTED'
  return Promise.reject(err)
}

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
  const identity = {
    status: async () => {
      const st = await request('identity.status')
      return { ...st, webauthn: false, prf: 'unknown', rpId: rpIdOrNull() }
    },
    unlock: () => unsupported(),
    complete: () => unsupported(),
    lock: () => request('identity.clear'),
    signOut: async () => {
      await request('identity.forget')
      return request('identity.clear')
    },
    reset: () => request('identity.reset')
  }

  // The bytes go through a file in the upload dir: one IPC request is capped
  // at 64 KiB (docs/rpc.md 5.41). The worklet deletes the file after a
  // successful upload; on any failure it is deleted here.
  const media = {
    upload: async ({ bytes, mime, width, height, onProgress } = {}) => {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new TypeError('mídia inválida')
      const file = new File(uploadDirectory(), randomName())
      try {
        file.create()
        file.write(bytes)
        progress(onProgress, 0.25)
        const descriptor = await request('media.uploadFile', { path: uriToPath(file.uri), mime, width, height })
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
