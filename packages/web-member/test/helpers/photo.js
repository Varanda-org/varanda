'use strict'

// Test photos the node's photo check accepts (@varanda/rpc mediaBounds): a
// header written over the start of `bytes`, which keep their length and the
// rest of their content. -> bytes

const be32 = (v) => [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]

// SOI, then a baseline frame header.
function jpegHead (bytes, width = 640, height = 480) {
  return stamp(bytes, [0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1], 0)
}

// The signature and IHDR, then one IDAT chunk holding the rest.
function pngHead (bytes, width = 640, height = 480) {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]
  return stamp(bytes, [...head, ...be32(bytes.length - head.length - 12), 0x49, 0x44, 0x41, 0x54], 4)
}

function stamp (bytes, head, trailer) {
  if (bytes.length < head.length + trailer) throw new Error('too short for an image header')
  bytes.set(head, 0)
  return bytes
}

module.exports = { jpegHead, pngHead }
