'use strict'

// This is crash and secret isolation, not an OS sandbox. Only bytes enter
// the decoder; no caller-controlled path or URL is passed to native code.

const sharp = require('sharp')
const { mediaBounds, MAX_MEDIA_PIXELS, MAX_SHARE_COVER_BYTES } = require('@varanda/rpc')
const { coverSize } = require('./og-transcode')

const COVER_TARGET_BYTES = 204800
const INPUT_OPTIONS = { limitInputPixels: MAX_MEDIA_PIXELS, pages: 1, failOn: 'warning' }
const MIMES = ['image/avif', 'image/jpeg', 'image/png', 'image/webp']

// Copied from packages/rpc/test/helpers/avif-samples.js: the production image
// excludes tests, and a single-item probe alone misses broken grid decoders.
const IOS_OPAQUE =
  'AAAAIGZ0eXBhdmlmAAAAAE1pUHJhdmlmbWlhZm1pZjEAAAEhbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAA' +
  'AAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAAOcGl0bQAAAAAAAQAAACNpaW5mAAAAAAABAAAA' +
  'FWluZmUCAAAAAAEAAGF2MDEAAAAAgWlwcnAAAABgaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNw' +
  'ZQAAAAAAAAAQAAAAEAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAAZaXBtYQAAAAAAAAABAAEGgQID' +
  'BYaEAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAVEAAABiAAAAAW1kYXQAAAAAAAAAchIACg0AAAABn/n/8CBAQNCAMk8QAZgA' +
  'EEEEIMPbSJ8B/Y/s2J9QqA2RYDpfozpie771la9FiPcGapleqH7hsjnJTD/8MP94EiIUxtz3FMXo8qugaCoDqYH5kmRJD20F' +
  'DzGY'

const IMAGEIO_GRID_1024X768 =
  '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'

sharp.concurrency(1)
sharp.cache(false)

// macOS and libvips can add runtime variables even after an empty-env fork.
for (const name of Object.keys(process.env)) delete process.env[name]

async function selfTest () {
  try {
    for (const [sample, width, height] of [[IOS_OPAQUE, 16, 16], [IMAGEIO_GRID_1024X768, 1024, 768]]) {
      const { info } = await sharp(Buffer.from(sample, 'base64'), INPUT_OPTIONS).raw().toBuffer({ resolveWithObject: true })
      if (info.width !== width || info.height !== height) return false
    }
    return true
  } catch {
    return false
  }
}

async function encode (input) {
  try {
    const { bytes, mime, srcWidth, srcHeight, width, height } = input
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 8 * 1024 * 1024 || !MIMES.includes(mime)) return null
    const bounds = mediaBounds(bytes, mime)
    const size = coverSize(srcWidth, srcHeight)
    if (!bounds || bounds.frames !== 1 || bounds.width !== srcWidth || bounds.height !== srcHeight ||
      !size || size.width !== width || size.height !== height) return null
    const source = sharp(Buffer.from(bytes), INPUT_OPTIONS)
    const metadata = await source.metadata()
    if ((metadata.pages || 1) !== 1 || metadata.width !== srcWidth || metadata.height !== srcHeight) return null
    // The app strips EXIF and turns the pixels itself, but another client's
    // JPEG may still carry a rotation the browser applies to the body photo:
    // a cover built from the stored pixels would show it sideways.
    if (metadata.orientation !== undefined && metadata.orientation !== 1) return null
    // Check decoded pixels as well as headers before fitting the cover.
    const decoded = await source.flatten({ background: '#ffffff' }).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
    if (decoded.info.width !== srcWidth || decoded.info.height !== srcHeight) return null
    const resized = await sharp(decoded.data, { raw: decoded.info })
      .resize(width, height, { fit: 'fill', withoutEnlargement: true })
      .raw().toBuffer({ resolveWithObject: true })
    let bytesOut
    for (const quality of [82, 72, 60]) {
      bytesOut = await sharp(resized.data, { raw: resized.info }).jpeg({ quality }).toBuffer()
      if (bytesOut.length <= COVER_TARGET_BYTES) return bytesOut
    }
    return bytesOut.length <= MAX_SHARE_COVER_BYTES ? bytesOut : null
  } catch {
    return null
  }
}

function send (msg) {
  if (process.connected) process.send(msg, () => {})
}

async function start () {
  const avif = await selfTest()
  let busy = false
  process.on('message', async (msg) => {
    if (!msg || msg.type !== 'transcode' || !Number.isSafeInteger(msg.id) || busy) return
    busy = true
    const bytes = msg.mime === 'image/avif' && !avif ? null : await encode(msg)
    busy = false
    send({ type: 'result', id: msg.id, bytes })
  })
  process.on('disconnect', () => process.exit(0))
  send({ type: 'ready', avif })
}

if (require.main === module) start()
