'use strict'

// The web photo encoder reads the header size before any decode, so a small
// file declaring a huge canvas never reaches createImageBitmap, while camera
// photos (48 MP and up, EXIF and ICC first, progressive) still do.

const test = require('brittle')

const load = () => import('../src/media/encode.web.js')

const be16 = (v) => [(v >>> 8) & 0xff, v & 0xff]
const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))

function jpeg (w, h, { sof = 0xc0, camera = false } = {}) {
  const app = (marker, fill) => [0xff, marker, ...be16(65533), ...new Array(65531).fill(fill)]
  return new Uint8Array([0xff, 0xd8,
    ...(camera ? [...app(0xe1, 0x45), ...app(0xe2, 0x49)] : []),
    0xff, sof, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xda, ...be16(2), 0xff, 0xd9])
}

function chunk (id, data) {
  return [...be32(data.length), ...ascii(id), ...data, 0, 0, 0, 0]
}

function png (w, h) {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be32(w), ...be32(h), 8, 6, 0, 0, 0]),
    ...chunk('IDAT', [1, 2, 3]),
    ...chunk('IEND', [])])
}

test('photoProblem refuses a header past 16384 px on a side or 100 MP', async (t) => {
  const { photoProblem, MAX_PHOTO_SIDE, MAX_PHOTO_PIXELS } = await load()
  t.is(MAX_PHOTO_SIDE, 16384)
  t.is(MAX_PHOTO_PIXELS, 100000000)
  t.is(photoProblem(png(23000, 23000)), 'foto grande demais', 'a small PNG declaring 23000 x 23000')
  t.is(photoProblem(jpeg(16385, 100)), 'foto grande demais', 'one side too long')
  t.is(photoProblem(jpeg(100, 16385)), 'foto grande demais', 'the other side too long')
  t.is(photoProblem(jpeg(10001, 10000)), 'foto grande demais', 'over 100 MP')
  t.is(photoProblem(jpeg(10000, 10000)), null, 'exactly 100 MP')
  t.is(photoProblem(jpeg(16384, 6103)), null, 'a panorama at the side limit')
  t.is(photoProblem(jpeg(8064, 6048, { camera: true })), null, 'a 48 MP camera JPEG with EXIF and ICC first')
  t.is(photoProblem(jpeg(4032, 3024, { sof: 0xc2, camera: true })), null, 'a progressive JPEG')
  t.is(photoProblem(new Uint8Array([1, 2, 3, 4])), 'não foi possível abrir a foto', 'an unreadable header')
  t.is(photoProblem(jpeg(100, 100).subarray(0, 8)), 'não foi possível abrir a foto', 'a truncated header')
})

test('encodeFile checks the header before decoding a photo', async (t) => {
  const { encodeFile } = await load()
  let decodes = 0
  const realBitmap = globalThis.createImageBitmap
  const realImage = globalThis.Image
  globalThis.createImageBitmap = async () => { decodes++; throw new Error('no decoder here') }
  globalThis.Image = class { async decode () { decodes++; throw new Error('no decoder here') } }
  t.teardown(() => {
    globalThis.createImageBitmap = realBitmap
    globalThis.Image = realImage
  })

  await t.exception(encodeFile(new File([png(23000, 23000)], 'a.png', { type: 'image/png' })), /foto grande demais/)
  await t.exception(encodeFile(new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' })), /não foi possível abrir a foto/)
  t.is(decodes, 0, 'never decoded')

  await t.exception(encodeFile(new File([jpeg(8064, 6048, { camera: true })], 'c.jpg', { type: 'image/jpeg' })), /não foi possível abrir a foto/)
  t.ok(decodes > 0, 'a camera photo reaches the decoder (which fails here)')
})

const le16 = (v) => [v & 0xff, (v >>> 8) & 0xff]

function gif (w, h, frames, { frameW = w, frameH = h } = {}) {
  const parts = [...ascii('GIF89a'), ...le16(w), ...le16(h), 0x80, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < frames; i++) {
    parts.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0)
    parts.push(0x2c, ...le16(0), ...le16(0), ...le16(frameW), ...le16(frameH), 0, 2, 2, 0x4c, 0x01, 0)
  }
  parts.push(0x3b)
  return new Uint8Array(parts)
}

test('gifProblem holds a GIF to the media bounds, not just its logical screen', async (t) => {
  const { gifProblem } = await import('../src/media/gif.js')
  t.is(gifProblem(gif(480, 270, 3)), null, 'an ordinary animated GIF')
  t.is(gifProblem(gif(16384, 16384, 1)), 'imagem grande demais', 'a small GIF declaring a 268 MP screen')
  t.is(gifProblem(gif(1, 1, 1, { frameW: 20000, frameH: 20000 })), 'imagem grande demais', 'a 1 x 1 screen with a huge frame')
  t.is(gifProblem(gif(1000, 1000, 100)), 'imagem grande demais', 'too many pixels across the frames')
  t.is(gifProblem(new Uint8Array([1, 2, 3])), 'formato não aceito', 'not a GIF')
  t.is(gifProblem(gif(480, 270, 3).subarray(0, 20)), 'formato não aceito', 'a truncated GIF')
})

test('both encoders check a GIF with gifProblem before keeping it', async (t) => {
  const fs = require('fs')
  const path = require('path')
  for (const name of ['encode.web.js', 'encode.native.js']) {
    const src = fs.readFileSync(path.join(__dirname, '../src/media', name), 'utf8')
    const body = src.slice(src.indexOf('async function encodeGif'), src.indexOf('\n}\n', src.indexOf('async function encodeGif')))
    t.ok(/const refused = gifProblem\(bytes\)\n\s+if \(refused\) throw fail\(refused\)\n\s+return \{ bytes, mime: 'image\/gif'/.test(body), name)
  }
})
