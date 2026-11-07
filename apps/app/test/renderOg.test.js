'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { DESIGNS } = require('@varanda/rpc')
const { renderDesign, encodePng, decodePngRgb } = require('../scripts/render-og')

function pixel (image, x, y) {
  const offset = (Math.floor(y) * image.width + Math.floor(x)) * 3
  return Array.from(image.rgb.subarray(offset, offset + 3))
}

const colorRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

test('renderOg: tiny RGB image round trip preserves rows and channels', (t) => {
  const image = { width: 3, height: 2, rgb: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 31, 42, 36]) }
  const png = encodePng(image)
  t.alike(decodePngRgb(png), image)
  t.is(png[24], 8, '8-bit channels')
  t.is(png[25], 2, 'RGB without alpha')
  t.is(png.readUInt32BE(png.length - 4), 0xae426082, 'standard IEND CRC')
  const single = encodePng({ width: 1, height: 1, rgb: Uint8Array.from([0, 0, 0]) })
  t.is(single.readUInt32BE(29), 0x907753de, 'standard 1x1 RGB IHDR CRC')
  const broken = Buffer.from(png)
  broken[45] ^= 1
  t.exception(() => decodePngRgb(broken), /CRC/, 'corrupt pixels are rejected')
  t.exception(() => decodePngRgb(png.subarray(0, -12)), /incompleto/, 'missing IEND is rejected')
})

test('renderOg: every committed preview matches deterministic shared art', async (t) => {
  const { CANVAS, SAFE_AREA, artFor, resolveFill } = await import('../src/inviteCardArt.js')
  const { light } = await import('../src/appearance.js')
  const scale = 1200 / CANVAS.w
  const directory = path.join(__dirname, '../public/og')
  const ids = ['unknown-design', ...DESIGNS]
  const names = ids.map((id, i) => i === 0 ? 'convite.png' : 'convite-' + id + '.png')
  t.is(names.length, 14)
  t.alike(fs.readdirSync(directory).filter((name) => /^convite(?:-.*)?\.png$/.test(name)).sort(), [...names].sort())
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const rendered = await renderDesign(id)
    t.is(rendered.width, 1200, id + ': width')
    t.is(rendered.height, 630, id + ': height')
    t.ok(rendered.rgb instanceof Uint8Array, id + ': RGB bytes')
    t.is(rendered.rgb.length, 1200 * 630 * 3, id + ': RGB length')
    const again = await renderDesign(id)
    t.ok(Buffer.from(rendered.rgb).equals(again.rgb), id + ': deterministic')
    const png = fs.readFileSync(path.join(directory, names[i]))
    t.ok(png.length < 200000, id + ': under 200 KB')
    const saved = decodePngRgb(png)
    t.is(saved.width, rendered.width, id + ': saved width')
    t.is(saved.height, rendered.height, id + ': saved height')
    t.ok(Buffer.from(saved.rgb).equals(rendered.rgb), id + ': committed pixels match')
    t.alike(pixel(rendered, (SAFE_AREA.x + 30) * scale, (SAFE_AREA.y + SAFE_AREA.h / 2) * scale), colorRgb(light.card), id + ': panel color')
    t.alike(pixel(rendered, SAFE_AREA.x * scale, SAFE_AREA.y * scale), colorRgb(artFor(id).bg.light), id + ': rounded panel corner')
    t.alike(pixel(rendered, SAFE_AREA.x * scale + 12, SAFE_AREA.y * scale), colorRgb(light.card), id + ': panel radius is 12 output pixels')
    t.unlike(pixel(rendered, 0, 0), colorRgb(light.card), id + ': corner has frame color')
    t.alike(pixel(rendered, 600, 300), colorRgb(resolveFill(artFor(id).ink, 'light')), id + ': chair ink')
  }
})

test('renderOg: primitive interiors, cutouts and paint order match the frame', async (t) => {
  const { artFor, resolveFill } = await import('../src/inviteCardArt.js')
  const probes = [
    ['bandeirinhas', 50, 30, 'red'],
    ['bandeirinhas', 50, 80, 'red'],
    ['bandeirinhas', 18, 80, null],
    ['vitoria', 60, 54, 'pink'],
    ['vitoria', 90, 54, 'leaf'],
    ['vitoria', 105, 54, 'forest'],
    ['vitoria', 105, 99, null],
    ['chita', 145, 52, 'leaf'],
    ['chita', 135, 46, null],
    ['azulejo', 13, 18, null],
    ['azulejo', 16, 18, 'tileWhite'],
    ['azulejo', 47, 52, 'tileBlue'],
    ['copacabana', 5, 5, 'sea'],
    ['copacabana', 5, 25, 'sand'],
    ['copacabana', 5, 50, 'sea'],
    ['copacabana', 5, 75, 'sand']
  ]
  const images = new Map()
  for (const [id, x, y, fill] of probes) {
    if (!images.has(id)) images.set(id, await renderDesign(id))
    const color = fill === null ? artFor(id).bg.light : resolveFill(fill, 'light')
    t.alike(pixel(images.get(id), x * 1.2, y * 1.2), colorRgb(color), id + ': ' + x + ',' + y)
  }
  const flags = images.get('bandeirinhas')
  const bg = colorRgb(artFor('bandeirinhas').bg.light)
  const red = colorRgb(resolveFill('red', 'light'))
  let blended = false
  for (let y = 25; y < 95 && !blended; y++) {
    for (let x = 18; x < 100; x++) {
      const p = pixel(flags, x, y)
      if ([1, 2, 3].some((n) => p.every((v, c) => v === Math.round((red[c] * n + bg[c] * (4 - n)) / 4)))) {
        blended = true
        break
      }
    }
  }
  t.ok(blended, 'triangle edges contain averaged 2x2 samples')
})
