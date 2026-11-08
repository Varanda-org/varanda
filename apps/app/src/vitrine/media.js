import { pictures } from './pictures.js'
import { PICTURE_BASE } from './fixtures.js'

// The node's chat media handle for the Vitrine (read, putDm, putMoment,
// upload and the two no-op sweeps of src/node.js CHAT_MEDIA_CALLS). Everything stays in
// memory: the bytes come from the tiny drawings of ./pictures.js or from the
// file the person just picked, and nothing leaves the page.

const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)))
const keyOf = (n) => n.toString(16).padStart(64, '0')
const fail = (message) => Object.assign(new Error(message), { code: 'USAGE' })
const gone = () => Object.assign(new Error('foto indisponível'), { code: 'NOT_FOUND' })

// Fixture items name their drawing through the sha256 (see fixtures.js).
function pictureOf (sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return null
  const p = parseInt(sha.slice(2), 16) - PICTURE_BASE
  return Number.isInteger(p) && p >= 0 && p < pictures.length ? pictures[p] : null
}

function checkFile ({ bytes, mime, width, height }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw fail('foto inválida')
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) throw fail('foto inválida')
  for (const side of [width, height]) if (!Number.isInteger(side) || side < 1 || side > 16384) throw fail('foto inválida')
}

// data: the request's live state (conversations and groups), so a photo
// sent here opens again like a fixture one. data.momentMedia(author, seq),
// set by ./request.js, answers the photo item of a moment that is showing
// (live, inside its 24 h) or null; data.momentUploads holds the items
// putMoment answered and moment.create has not published yet.
export function createVitrineMedia (data) {
  let serial = 0
  // sha256 of an item made here -> its bytes and mime.
  const made = new Map()
  data.momentUploads = new Map()

  const stash = (args) => {
    checkFile(args)
    serial++
    const sha256 = keyOf(0x800 + serial)
    made.set(sha256, { bytes: new Uint8Array(args.bytes), mime: args.mime })
    return { sha256, n: serial }
  }

  // The bytes behind a sha256, fresh on every call (the caller wipes them).
  const bytesOf = (sha, mime) => {
    const own = made.get(sha)
    if (own) return { bytes: new Uint8Array(own.bytes), mime: own.mime }
    const picture = pictureOf(sha)
    return picture ? { bytes: hex(picture.hex), mime: picture.mime, w: picture.w, h: picture.h } : null
  }

  const itemOf = (ref) => {
    if (ref.kind === 'group') return ref.item && typeof ref.item === 'object' ? ref.item : null
    const message = data.conversations.flatMap((c) => c.messages).find((m) => m.id === ref.id && m.from === ref.from)
    return message && Array.isArray(message.media) ? message.media[ref.index] || null : null
  }

  return {
    async read (ref) {
      if (ref !== null && typeof ref === 'object' && ref.kind === 'moment') {
        const item = typeof data.momentMedia === 'function' ? data.momentMedia(ref.author, ref.seq) : null
        const got = item ? bytesOf(item.sha256) : null
        if (!got) throw gone()
        return got
      }
      if (ref === null || typeof ref !== 'object' || (ref.kind !== 'dm' && ref.kind !== 'group')) throw new TypeError('mídia inválida')
      const item = itemOf(ref)
      const got = item ? bytesOf(item.plainSha256 || item.sha256) : null
      if (!got) throw new Error('indisponível')
      return got
    },
    async putDm (args = {}) {
      const { sha256, n } = stash(args)
      return { id: keyOf(0x900 + n), key: keyOf(0xa00 + n), nonce: '0'.repeat(46) + (n % 100).toString().padStart(2, '0'), chunks: 1, bytes: args.bytes.byteLength + 16, sha256, mime: args.mime, w: args.width, h: args.height, ms: 0 }
    },
    // A fresh item for every call, never shared with a DM or another moment.
    // Like the node's momentPutMedia, it wipes the caller's bytes.
    async putMoment (args = {}) {
      const { sha256, n } = stash(args)
      // The ciphertext is the photo plus the 16-byte MAC, in 32 KiB chunks
      // (the descriptor rule moment.create checks).
      const bytes = args.bytes.byteLength + 16
      const item = { id: keyOf(0xe00 + n), key: keyOf(0xf00 + n), nonce: '0'.repeat(46) + (n % 100).toString().padStart(2, '0'), chunks: Math.ceil(bytes / 32768), bytes, sha256, mime: args.mime, w: args.width, h: args.height, ms: 0 }
      args.bytes.fill(0)
      data.momentUploads.set(item.id, item)
      return { ...item }
    },
    async upload (args = {}) {
      const { sha256, n } = stash(args)
      const blocks = Math.min(256, Math.ceil(args.bytes.byteLength / 32768))
      if (args.sealed === true) {
        return { core: keyOf(0xb00), mime: 'application/octet-stream', start: n, blocks, bytes: blocks * 32768, sha256: keyOf(0xc00 + n), key: keyOf(0xd00 + n), nonce: '0'.repeat(46) + (n % 100).toString().padStart(2, '0'), plainMime: args.mime, plainSha256: sha256, w: args.width, h: args.height, ms: 0 }
      }
      return { core: keyOf(0xb00), mime: args.mime, start: n, blocks, bytes: Math.min(args.bytes.byteLength, blocks * 32768), sha256, width: args.width, height: args.height }
    },
    forgetReadFile () {},
    clearReadFiles () {}
  }
}
