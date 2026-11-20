import { fixtures, postPictureBytes } from './fixtures.js'
import { sha256 } from '@noble/hashes/sha2.js'

// The Vitrine's stand-in for the installation's /media route, so a public
// post or listing photo loads through the same verified path as on a live network.
// It answers for fixtures and public uploads of the instance that uploaded
// last; nothing leaves the page.

const HEX64 = /^[0-9a-f]{64}$/
const mediaKey = (author, d) => `${author}/${d.core}/${d.start}/${d.blocks}`
let currentUploads = new Map()

// Public uploads also go through Avatar and the verified media client, which
// need the real hash and a page-local route to the bytes.
export function withPublicUploads (media, author) {
  const uploads = new Map()
  return {
    ...media,
    async upload (args = {}) {
      const d = await media.upload(args)
      if (args.sealed === true) return d
      const bytes = new Uint8Array(args.bytes)
      d.sha256 = Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
      uploads.set(mediaKey(author, d), { bytes, descriptor: { ...d } })
      // Only an uploading instance takes the route over: the index responder
      // builds a second instance that never uploads (indexResponder.js).
      currentUploads = uploads
      return d
    },
    async read (ref) {
      const d = ref?.item
      const uploaded = d && ['group', 'listing'].includes(ref.kind) ? uploads.get(mediaKey(author, d)) : null
      if (uploaded && uploaded.descriptor.sha256 === d.sha256) {
        return { bytes: new Uint8Array(uploaded.bytes), mime: uploaded.descriptor.mime }
      }
      return media.read(ref)
    }
  }
}

const answer = (status, bytes) => ({
  status,
  url: '',
  redirected: false,
  headers: { get: () => null },
  arrayBuffer: async () => (bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0))
})

// The descriptor a fixture names at author/core/start/blocks, or null.
function descriptorOf (author, core, start, blocks) {
  // The large rich feed (./large.js) shows fixture photos under other
  // members' names, so a known member or page may name any feed photo.
  const known = fixtures.members.some((m) => m.author === author) || fixtures.pages.some((m) => m.author === author)
  for (const post of fixtures.feed) {
    if ((!known && post.author !== author) || !Array.isArray(post.media)) continue
    for (const d of post.media) {
      if (d.core === core && String(d.start) === start && String(d.blocks) === blocks) return d
    }
  }
  for (const { author: owner, record } of fixtures.listings) {
    if (owner !== author || !['listing', 'listing-edit'].includes(record.type) || !Array.isArray(record.media)) continue
    for (const d of record.media) {
      if (d.core === core && String(d.start) === start && String(d.blocks) === blocks) return d
    }
  }
  for (const { image: d, imageAuthor } of [...fixtures.groups, ...fixtures.communities]) {
    if (imageAuthor === author && d && d.core === core && String(d.start) === start && String(d.blocks) === blocks) return d
  }
  return null
}

// url: what the media client built, '/media/<author>/<core>/<start>/<blocks>'.
export async function vitrineMediaResponse (url) {
  let path
  try { path = new URL(url, 'https://vitrine.invalid').pathname } catch { return answer(404) }
  const [, route, author, core, start, blocks, ...extra] = path.split('/')
  if (route !== 'media' || extra.length > 0 || blocks === undefined) return answer(404)
  if (!HEX64.test(author) || !HEX64.test(core) || !/^[1-9][0-9]*$/.test(start) || !/^[1-9][0-9]*$/.test(blocks)) return answer(404)
  const uploaded = currentUploads.get(mediaKey(author, { core, start, blocks }))
  if (uploaded) return answer(200, uploaded.bytes)
  const d = descriptorOf(author, core, start, blocks)
  const bytes = d ? postPictureBytes(d.sha256) : null
  return bytes ? answer(200, bytes) : answer(404)
}
