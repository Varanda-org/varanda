'use strict'

// gifSize (src/media/gif.js): the logical screen size from a GIF header.
const test = require('brittle')

const load = () => import('../src/media/gif.js')

const header = (sig, w, h) => {
  const b = new Uint8Array(13)
  for (let i = 0; i < 6; i++) b[i] = sig.charCodeAt(i)
  b[6] = w & 255
  b[7] = w >> 8
  b[8] = h & 255
  b[9] = h >> 8
  return b
}

test('gifSize: reads little-endian width and height of both versions', async (t) => {
  const { gifSize } = await load()
  t.alike(gifSize(header('GIF89a', 300, 200)), { width: 300, height: 200 })
  t.alike(gifSize(header('GIF87a', 1, 65535)), { width: 1, height: 65535 })
})

test('gifSize: null for other bytes', async (t) => {
  const { gifSize } = await load()
  t.is(gifSize(header('GIF90a', 3, 3)), null)
  t.is(gifSize(header('\xFF\xD8\xFF\xE0\x00\x10', 3, 3)), null)
  t.is(gifSize(header('GIF89a', 3, 3).subarray(0, 9)), null)
  t.is(gifSize(new Uint8Array(0)), null)
  t.is(gifSize(null), null)
  t.is(gifSize('GIF89a....'), null)
})
