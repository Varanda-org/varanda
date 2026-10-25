'use strict'

// Media planning stays usable without a browser, filesystem or core imports.
const test = require('brittle')
const load = () => import('../src/media/plan.js')

test('media constants and MIME kinds match the record contract', async (t) => {
  const plan = await load()
  t.is(plan.MEDIA_BLOCK_BYTES, 32768)
  t.is(plan.MAX_MEDIA_ITEM_BLOCKS, 256)
  t.is(plan.MAX_MEDIA_PER_POST, 4)
  t.is(plan.MAX_MEDIA_DIMENSION, 16384)
  t.is(plan.MAX_IMAGE_SIDE, 2048)
  t.is(plan.MAX_IMAGE_BYTES, 8 * 1024 * 1024)
  t.is(plan.MAX_GIF_BYTES, 8 * 1024 * 1024)
  t.alike(plan.MEDIA_MIMES, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) t.is(plan.kindOf(mime), 'image')
  t.is(plan.kindOf('image/gif'), 'gif')
  for (const mime of ['video/mp4', 'text/plain', 'image/svg+xml', 'image/avif', '', null, undefined]) {
    t.is(plan.kindOf(mime), null)
  }
})

test('blocksFor and splitBlocks: exact boundaries and no empty blocks', async (t) => {
  const { blocksFor, splitBlocks, MEDIA_BLOCK_BYTES } = await load()
  for (const [size, count] of [[1, 1], [32768, 1], [32769, 2], [65536, 2], [8388608, 256]]) {
    t.is(blocksFor(size), count)
    const bytes = new Uint8Array(size + 10).subarray(5, size + 5)
    bytes[0] = 42
    bytes[size - 1] = 99
    const blocks = splitBlocks(bytes)
    t.is(blocks.length, count)
    t.is(blocks[0][0], bytes[0])
    t.is(blocks[count - 1].length, size - (count - 1) * MEDIA_BLOCK_BYTES)
    t.is(blocks[count - 1].at(-1), 99)
    t.is(blocks.reduce((sum, block) => sum + block.length, 0), size)
    for (let i = 0; i < blocks.length; i++) {
      t.is(blocks[i].buffer, bytes.buffer)
      t.is(blocks[i].byteOffset, bytes.byteOffset + i * MEDIA_BLOCK_BYTES)
      t.ok(blocks[i].length > 0 && blocks[i].length <= MEDIA_BLOCK_BYTES)
    }
    t.is(bytes[size - 1], 99)
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await t.exception.all(() => blocksFor(value), RangeError)
  }
  await t.exception.all(() => splitBlocks(new Uint8Array(0)), RangeError)
  await t.exception.all(() => splitBlocks([1]), TypeError)
})

test('fitWithin: bounds each orientation without enlarging tiny images', async (t) => {
  const { fitWithin } = await load()
  t.alike(fitWithin(4000, 2000), { width: 2048, height: 1024 })
  t.alike(fitWithin(2000, 4000), { width: 1024, height: 2048 })
  t.alike(fitWithin(4000, 4000), { width: 2048, height: 2048 })
  t.alike(fitWithin(1, 1), { width: 1, height: 1 })
  t.alike(fitWithin(37, 23), { width: 37, height: 23 })
  t.alike(fitWithin(16384, 1), { width: 2048, height: 1 })
  t.alike(fitWithin(1, 16384), { width: 1, height: 2048 })
  t.alike(fitWithin(300, 200, 100), { width: 100, height: 67 })
  t.alike(fitWithin(2048, 1024), { width: 2048, height: 1024 })
  for (const args of [[0, 2], [2, -1], [Infinity, 2], [2, NaN], [2, 2, 0]]) {
    await t.exception.all(() => fitWithin(...args), RangeError)
  }
})

test('checkFile: MIME, byte and dimension limits', async (t) => {
  const { checkFile, MEDIA_MIMES, MAX_IMAGE_BYTES, MAX_MEDIA_DIMENSION } = await load()
  const file = Object.freeze({ mime: 'image/jpeg', bytes: 1, width: 1, height: 1 })
  t.is(checkFile(file), null)
  for (const mime of MEDIA_MIMES) {
    t.is(checkFile({ ...file, mime, bytes: MAX_IMAGE_BYTES, width: MAX_MEDIA_DIMENSION, height: MAX_MEDIA_DIMENSION }), null)
    t.is(checkFile({ ...file, mime, bytes: MAX_IMAGE_BYTES + 1 }), 'arquivo grande demais')
  }
  for (const mime of ['video/mp4', 'audio/mp3', 'image/svg+xml', '']) {
    t.is(checkFile({ ...file, mime }), 'formato não aceito')
  }
  for (const bytes of [0, -1, 1.5, NaN, Infinity]) {
    t.is(checkFile({ ...file, bytes }), 'arquivo grande demais')
  }
  for (const dimension of [0, -1, 1.5, NaN, Infinity, MAX_MEDIA_DIMENSION + 1]) {
    t.is(checkFile({ ...file, width: dimension }), 'imagem grande demais')
    t.is(checkFile({ ...file, height: dimension }), 'imagem grande demais')
  }
  t.alike(file, { mime: 'image/jpeg', bytes: 1, width: 1, height: 1 })
})

test('descriptorFor: exact contract keys, computed blocks and no mutation', async (t) => {
  const { descriptorFor } = await load()
  const input = Object.freeze({ core: 'a'.repeat(64), mime: 'image/png', start: 1, bytes: 32769, sha256: 'b'.repeat(64), width: 2048, height: 1024, extra: true, blocks: 99 })
  const descriptor = descriptorFor(input)
  t.alike(Object.keys(descriptor).sort(), ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height'].sort())
  t.alike(descriptor, { core: input.core, mime: input.mime, start: 1, blocks: 2, bytes: 32769, sha256: input.sha256, width: 2048, height: 1024 })
  t.is(input.blocks, 99)
  t.is(descriptorFor({ ...input, bytes: 32768 }).blocks, 1)
  await t.exception.all(() => descriptorFor({ ...input, bytes: 0 }), RangeError)
})

test('toHex and gridLayout', async (t) => {
  const { toHex, gridLayout } = await load()
  t.is(toHex(new Uint8Array([0, 1, 15, 16, 127, 128, 254, 255])), '00010f107f80feff')
  t.is(toHex(new Uint8Array()), '')
  t.is(toHex(new Uint8Array([255, 0, 15, 255]).subarray(1, 3)), '000f')
  t.alike([1, 2, 3, 4].map(gridLayout), ['one', 'two', 'three', 'four'])
  for (const n of [0, 5, -1, 1.5, NaN, '1']) t.is(gridLayout(n), null)
})
