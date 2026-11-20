'use strict'

// jpegOrientation and orientedSize (src/media/exif.js): a link card's
// thumbnail is resized from the header size, and the native decoders turn
// the pixels by the EXIF orientation first.
const test = require('brittle')

const load = () => import('../src/media/exif.js')

const u16 = (v, little) => little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]
const u32 = (v, little) => little ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
const segment = (marker, body) => [0xff, marker, ...u16(body.length + 2, false), ...body]
const EXIF = [0x45, 0x78, 0x69, 0x66, 0, 0]
const JFIF = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
const SOF = segment(0xc0, [8, 0, 3, 0, 4, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
const SCAN = [...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]), 1, 2, 3, 0xff, 0xd9]

// IFD0 with `entries` ([tag, type, count, value]), in either byte order.
function tiff (entries, { little = true, ifd = 8, gap = Math.max(0, ifd - 8) } = {}) {
  const head = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42, little), ...u32(ifd, little)]
  const pad = new Array(gap).fill(0)
  const body = entries.flatMap(([tag, type, count, value]) => [...u16(tag, little), ...u16(type, little), ...u32(count, little), ...u16(value, little), 0, 0])
  return [...head, ...pad, ...u16(entries.length, little), ...body, ...u32(0, little)]
}

function jpeg (app1, { before = [JFIF] } = {}) {
  return new Uint8Array([0xff, 0xd8, ...before.flat(), ...(app1 ? segment(0xe1, app1) : []), ...SOF, ...SCAN])
}

const oriented = (value, opts) => jpeg([...EXIF, ...tiff([[0x0110, 2, 4, 0], [0x0112, 3, 1, value]], opts)])

test('jpegOrientation: reads tag 0x0112 of IFD0 in either byte order', async (t) => {
  const { jpegOrientation } = await load()
  for (let v = 1; v <= 8; v++) {
    t.is(jpegOrientation(oriented(v)), v, 'little endian ' + v)
    t.is(jpegOrientation(oriented(v, { little: false })), v, 'big endian ' + v)
  }
  t.is(jpegOrientation(oriented(6, { ifd: 20 })), 6, 'IFD0 after a gap')
  t.is(jpegOrientation(jpeg([...EXIF, ...tiff([[0x0112, 3, 1, 6]])], { before: [] })), 6, 'APP1 right after SOI')
  t.is(jpegOrientation(jpeg([...EXIF, ...tiff([[0x0112, 3, 1, 8]])], { before: [JFIF, segment(0xe2, [1, 2, 3])] })), 8, 'after other segments')
})

test('jpegOrientation: anything missing or malformed reads as 1', async (t) => {
  const { jpegOrientation } = await load()
  t.is(jpegOrientation(jpeg(null)), 1, 'no APP1')
  t.is(jpegOrientation(jpeg([...EXIF, ...tiff([[0x0110, 2, 4, 0]])])), 1, 'no orientation tag')
  t.is(jpegOrientation(jpeg([0x68, 0x74, 0x74, 0x70, 0, 0, ...tiff([[0x0112, 3, 1, 6]])])), 1, 'an APP1 that is not Exif')
  t.is(jpegOrientation(oriented(0)), 1, 'value 0')
  t.is(jpegOrientation(oriented(9)), 1, 'value 9')
  t.is(jpegOrientation(jpeg([...EXIF, ...tiff([[0x0112, 4, 1, 6]])])), 1, 'type LONG')
  t.is(jpegOrientation(jpeg([...EXIF, ...tiff([[0x0112, 3, 2, 6]])])), 1, 'count 2')
  const wrongMagic = [...EXIF, ...tiff([[0x0112, 3, 1, 6]])]
  wrongMagic[8] = 43
  t.is(jpegOrientation(jpeg(wrongMagic)), 1, 'TIFF magic 43')
  t.is(jpegOrientation(jpeg([...EXIF, ...tiff([[0x0112, 3, 1, 6]], { ifd: 4 })])), 1, 'IFD0 inside the header')
  t.is(jpegOrientation(jpeg([...EXIF, ...tiff([[0x0112, 3, 1, 6]], { ifd: 4000, gap: 0 })])), 1, 'IFD0 past the segment')
  const two = [...EXIF, ...tiff([[0x0110, 2, 4, 0], [0x0112, 3, 1, 6]])]
  t.is(jpegOrientation(jpeg(two.slice(0, two.length - 10))), 1, 'an entry past the segment')
  const cut = oriented(6)
  t.is(jpegOrientation(cut.subarray(0, 30)), 1, 'a segment cut short')
  const scanFirst = new Uint8Array([0xff, 0xd8, ...SCAN, ...segment(0xe1, [...EXIF, ...tiff([[0x0112, 3, 1, 6]])])])
  t.is(jpegOrientation(scanFirst), 1, 'nothing read after the scan')
  t.is(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 1, 'not a JPEG')
  t.is(jpegOrientation(new Uint8Array(0)), 1, 'empty')
  t.is(jpegOrientation(null), 1, 'not bytes')
})

test('orientedSize: 5 to 8 swap the sides of a JPEG, other formats stay as stored', async (t) => {
  const { orientedSize } = await load()
  const size = { width: 400, height: 300 }
  for (let v = 1; v <= 4; v++) t.alike(orientedSize(oriented(v), 'image/jpeg', size), size, 'orientation ' + v)
  for (let v = 5; v <= 8; v++) t.alike(orientedSize(oriented(v), 'image/jpeg', size), { width: 300, height: 400 }, 'orientation ' + v)
  t.alike(orientedSize(oriented(6), 'image/png', size), size, 'only a JPEG is turned')
  t.alike(size, { width: 400, height: 300 }, 'the size given is not changed')
})
