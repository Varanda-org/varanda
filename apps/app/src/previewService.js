// A link preview through the account service's proxy (account.js
// previewFetch): the site sees the service's address, never the member's,
// and the service follows up to 3 redirects, checking each address. Only for
// a hosted node (gif.js gifOriginOf: origin undefined, the installation's own
// service) and only while the service's policy is on; the member session is
// the node's read-only invite.sign 'summary' statement. The web build always
// comes here; the native one only for a link that redirects
// (previewBuild.native.js).
// -> { url, host, title, desc, imageBytes, imageMime } or null; never rejects.

import rpc from '@varanda/rpc'
import { previewFetch, previewPolicy } from './account.js'
import { coverTarget } from './musicEmbed.js'

const { cardUrlHost } = rpc

export async function previewViaService (url, { signal, member, request, origin, account = { previewFetch, previewPolicy } } = {}) {
  try {
    // null: no account service for this node (gif.js gifOriginOf).
    if (origin === null || cardUrlHost(url) === null || typeof member !== 'string' || typeof request !== 'function') return null
    if (!(await account.previewPolicy({ origin }))) return null
    if (signal && signal.aborted) return null
    // The service builds a YouTube thumbnail only from the canonical watch
    // address, never from a youtu.be or embed link.
    const p = await account.previewFetch(coverTarget(url) || url, { origin, member, request, signal })
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
