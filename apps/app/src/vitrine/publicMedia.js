import { fixtures, postPictureBytes } from './fixtures.js'

// The Vitrine's stand-in for the installation's /media route, so a public
// post or listing photo loads through the same verified path as on a live network.
// It answers only for photos the fixtures name; nothing leaves the page.

const HEX64 = /^[0-9a-f]{64}$/

const answer = (status, bytes) => ({
  status,
  url: '',
  redirected: false,
  headers: { get: () => null },
  arrayBuffer: async () => (bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0))
})

// The descriptor a fixture names at author/core/start/blocks, or null.
function descriptorOf (author, core, start, blocks) {
  if (!HEX64.test(author) || !HEX64.test(core) || !/^[1-9][0-9]*$/.test(start) || !/^[1-9][0-9]*$/.test(blocks)) return null
  for (const post of fixtures.feed) {
    if (post.author !== author || !Array.isArray(post.media)) continue
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
  return null
}

// url: what the media client built, '/media/<author>/<core>/<start>/<blocks>'.
export async function vitrineMediaResponse (url) {
  let path
  try { path = new URL(url, 'https://vitrine.invalid').pathname } catch { return answer(404) }
  const [, route, author, core, start, blocks, ...extra] = path.split('/')
  if (route !== 'media' || extra.length > 0 || blocks === undefined) return answer(404)
  const d = descriptorOf(author, core, start, blocks)
  const bytes = d ? postPictureBytes(d.sha256) : null
  return bytes ? answer(200, bytes) : answer(404)
}
