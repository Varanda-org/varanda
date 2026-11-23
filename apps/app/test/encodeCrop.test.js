'use strict'

// src/media/encode.web.js with options.cropFor and options.whole, and
// encodeBytes: the canvas and the decoder are faked, the header checks are
// the real ones.

const test = require('brittle')

const load = () => import('../src/media/encode.web.js')

const be16 = (v) => [(v >>> 8) & 0xff, v & 0xff]
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))

function jpeg (w, h) {
  return new Uint8Array([0xff, 0xd8,
    0xff, 0xe0, ...be16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xda, ...be16(2), 0xff, 0xd9])
}

// The canvas records every drawImage and encodes to a tiny blob of the asked
// type (webp refused when webp is false, as some browsers do).
function fakes (t, { webp = true, w = 4000, h = 3000 } = {}) {
  const box = { draws: [], canvases: [], qualities: [] }
  const real = { createImageBitmap: globalThis.createImageBitmap, document: globalThis.document }
  globalThis.createImageBitmap = async () => ({ width: w, height: h, close () {} })
  globalThis.document = {
    createElement () {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          clearRect () {},
          fillRect () {},
          drawImage: (...args) => box.draws.push({ canvas: [canvas.width, canvas.height], args: args.slice(1) })
        }),
        toBlob (cb, mime, quality) {
          box.qualities.push([mime, quality])
          const type = mime === 'image/webp' && !webp ? 'image/png' : mime
          cb(new Blob([new Uint8Array([1, 2, 3])], { type }))
        }
      }
      box.canvases.push(canvas)
      return canvas
    }
  }
  t.teardown(() => {
    globalThis.createImageBitmap = real.createImageBitmap
    globalThis.document = real.document
  })
  return box
}

const file = () => new File([jpeg(4000, 3000)], 'a.jpg', { type: 'image/jpeg' })
const CROP = { sx: 100, sy: 200, sw: 3000, sh: 2500 }

test('no cropFor keeps the five argument drawImage and today\'s result', async (t) => {
  const { encodeFile } = await load()
  const box = fakes(t)
  const res = await encodeFile(file())
  t.is(res.mime, 'image/webp')
  t.is(res.width, 2048)
  t.is(res.height, 1536)
  t.alike(box.draws, [{ canvas: [2048, 1536], args: [0, 0, 2048, 1536] }])
  t.absent('whole' in res)
})

test('drawImage receives the source rect and sizes follow the crop', async (t) => {
  const { encodeFile } = await load()
  let box = fakes(t)
  const seen = []
  const res = await encodeFile(file(), { cropFor: (size) => { seen.push(size); return CROP } })
  t.alike(seen, [{ width: 4000, height: 3000 }])
  t.is(res.width, 2048)
  t.is(res.height, 1707)
  t.alike(box.draws, [{ canvas: [2048, 1707], args: [100, 200, 3000, 2500, 0, 0, 2048, 1707] }])
  t.absent('whole' in res, 'no whole unless asked')

  box = fakes(t, { webp: false })
  const jpg = await encodeFile(file(), { cropFor: () => CROP })
  t.is(jpg.mime, 'image/jpeg')
  t.is(box.draws.length, 2, 'the JPEG fallback redraws')
  t.alike(box.draws[1].args, [100, 200, 3000, 2500, 0, 0, 2048, 1707], 'with the same rect')
})

test('a full image rect is no crop, an invalid rect throws', async (t) => {
  const { encodeFile } = await load()
  let box = fakes(t)
  const res = await encodeFile(file(), { cropFor: () => ({ sx: 0, sy: 0, sw: 4000, sh: 3000 }), whole: true })
  t.alike(box.draws, [{ canvas: [2048, 1536], args: [0, 0, 2048, 1536] }])
  t.absent('whole' in res)
  box = fakes(t)
  await t.exception.all(encodeFile(file(), { cropFor: () => ({ sx: 1, sy: 0, sw: 4000, sh: 3000 }) }), /TypeError: Expected a crop inside the image/)
  t.alike(box.draws, [])
})

test('whole: the uncropped photo at most 1280, JPEG 0.8, only with a crop', async (t) => {
  const { encodeFile } = await load()
  const box = fakes(t)
  const res = await encodeFile(file(), { cropFor: () => CROP, whole: true })
  t.is(res.mime, 'image/webp')
  t.is(res.whole.mime, 'image/jpeg')
  t.is(res.whole.width, 1280)
  t.is(res.whole.height, 960)
  t.alike(res.whole.bytes, new Uint8Array([1, 2, 3]))
  t.alike(box.draws[1], { canvas: [1280, 960], args: [0, 0, 1280, 960] })
  t.alike(box.qualities[1], ['image/jpeg', 0.8])
  t.ok(box.canvases.every((c) => c.width === 0 && c.height === 0), 'canvases released')
})

test('encodeBytes encodes already encoded bytes', async (t) => {
  const { encodeBytes } = await load()
  const box = fakes(t)
  const res = await encodeBytes({ bytes: jpeg(4000, 3000), mime: 'image/jpeg', width: 4000, height: 3000 }, { cropFor: () => CROP, whole: true })
  t.is(res.mime, 'image/webp')
  t.is(res.width, 2048)
  t.is(res.whole.width, 1280)
  t.alike(box.draws[0].args, [100, 200, 3000, 2500, 0, 0, 2048, 1707])
  const plain = await encodeBytes({ bytes: jpeg(4000, 3000), mime: 'image/jpeg', width: 4000, height: 3000 })
  t.is(plain.width, 2048)
  t.is(plain.height, 1536)
})
