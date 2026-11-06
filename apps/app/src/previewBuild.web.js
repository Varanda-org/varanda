// Web: a link preview through the account service's proxy (account.js
// previewFetch), since the page cannot read other sites and the site then
// sees the service's address, never the member's. Hosted only (the service
// is the page's own origin) and only while the service's policy is on; the
// member session is the node's read-only invite.sign 'summary' statement.
// Shared code imports './previewBuild'; previewBuild.native.js has the same
// export. Only called while "Prévia de links" is on (previewPref.js).
// -> { url, host, title, desc, imageBytes, imageMime } or null; never rejects.

import rpc from '@varanda/rpc'
import { previewFetch, previewPolicy } from './account.js'

const { cardUrlHost } = rpc

export async function buildPreview (url, { signal, member, request, origin, account = { previewFetch, previewPolicy } } = {}) {
  try {
    // null: no account service for this node (gif.js gifOriginOf).
    if (origin === null || cardUrlHost(url) === null || typeof member !== 'string' || typeof request !== 'function') return null
    if (!(await account.previewPolicy({ origin }))) return null
    if (signal && signal.aborted) return null
    const p = await account.previewFetch(url, { origin, member, request, signal })
    if (signal && signal.aborted) return null
    return {
      url: p.url,
      host: p.host,
      title: p.title,
      desc: p.desc,
      imageBytes: p.imageBytes instanceof Uint8Array ? p.imageBytes : null,
      imageMime: p.imageBytes instanceof Uint8Array ? p.imageMime : null
    }
  } catch {
    return null
  }
}

// "Prévia de links" (previewPref.js) in the browser: localStorage.
export function previewPrefStore () {
  try {
    return globalThis.localStorage || { getItem: () => null, setItem () {} }
  } catch {
    return { getItem: () => null, setItem () {} }
  }
}
