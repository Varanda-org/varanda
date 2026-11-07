'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { deflateSync, inflateSync } = require('node:zlib')
const { DESIGNS } = require('@varanda/rpc')

const WIDTH = 1200
const HEIGHT = 630
const SAMPLE = 2
// InviteCardFrame uses appearance.light.card and the fixed ui/theme radius.md.
const PANEL_COLOR = '#ffffff'
const PANEL_RADIUS = 12
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0)
  return n >>> 0
})

function crc32 (bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}

function chunk (type, data) {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 4, 'ascii')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4)
  return out
}

function encodePng ({ width, height, rgb }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgb.length !== width * height * 3) {
    throw new Error('Dimensões RGB inválidas')
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const stride = width * 3
  const rows = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) rows.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// Only the non-interlaced, unfiltered RGB format emitted above is supported.
function decodePngRgb (bytes) {
  const png = Buffer.from(bytes)
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Assinatura PNG inválida')
  let width = 0
  let height = 0
  let ended = false
  const parts = []
  for (let offset = 8; offset < png.length;) {
    if (offset + 12 > png.length) throw new Error('PNG incompleto')
    const length = png.readUInt32BE(offset)
    const end = offset + 8 + length
    if (end + 4 > png.length) throw new Error('PNG incompleto')
    if (crc32(png.subarray(offset + 4, end)) !== png.readUInt32BE(end)) throw new Error('CRC do PNG inválido')
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, end)
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13 || data[8] !== 8 || data[9] !== 2 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('Formato PNG não suportado')
      }
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === 'IDAT') {
      parts.push(data)
    } else if (type === 'IEND') {
      if (length !== 0 || end + 4 !== png.length) throw new Error('Fim do PNG inválido')
      ended = true
    }
    offset = end + 4
  }
  if (!width || !height || !parts.length || !ended) throw new Error('PNG incompleto')
  const stride = width * 3
  const rows = inflateSync(Buffer.concat(parts), { maxOutputLength: (stride + 1) * height })
  if (rows.length !== (stride + 1) * height) throw new Error('Tamanho RGB inválido')
  const rgb = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1)
    if (rows[start] !== 0) throw new Error('Filtro PNG não suportado')
    rgb.set(rows.subarray(start + 1, start + 1 + stride), y * stride)
  }
  return { width, height, rgb }
}

function colorRgb (hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Cor RGB inválida')
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
}

function paint (image, box, color, contains) {
  const rgb = colorRgb(color)
  const x0 = Math.max(0, Math.floor(box.left))
  const y0 = Math.max(0, Math.floor(box.top))
  const x1 = Math.min(image.width, Math.ceil(box.left + box.width))
  const y1 = Math.min(image.height, Math.ceil(box.top + box.height))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (contains(x + 0.5, y + 0.5)) image.rgb.set(rgb, (y * image.width + x) * 3)
    }
  }
}

function paintBox (image, box) {
  const { left, top, width, height } = box
  const r = Math.min(box.radius || 0, width / 2, height / 2)
  paint(image, box, box.color, (x, y) => {
    if (x < left || x >= left + width || y < top || y >= top + height) return false
    const dx = Math.max(left + r - x, 0, x - (left + width - r))
    const dy = Math.max(top + r - y, 0, y - (top + height - r))
    return dx * dx + dy * dy <= r * r
  })
}

function paintPolygon (image, points, color) {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const box = { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
  paint(image, box, color, (x, y) => {
    let inside = false
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]
      const [xj, yj] = points[j]
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
    }
    return inside
  })
}

function paintShape (image, item) {
  if (item.kind === 'box') return paintBox(image, item)
  if (item.kind === 'tri') {
    const { left, top, leftWidth, rightWidth, height, up } = item
    const base = top + (up ? height : 0)
    return paintPolygon(image, [[left, base], [left + leftWidth + rightWidth, base], [left + leftWidth, top + (up ? 0 : height)]], item.color)
  }
  if (item.kind === 'diamond') {
    const cx = item.left + item.side / 2
    const cy = item.top + item.side / 2
    const ry = item.side / Math.SQRT2
    const rx = ry * item.scaleX
    return paintPolygon(image, [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]], item.color)
  }
  throw new Error('Forma de arte não suportada')
}

function luminance (hex) {
  const [r, g, b] = colorRgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

// First fill of the design with a mid luminance (0.2 to 0.75), so each chair keeps a colour of its own.
function cushionColor (art, ink, resolveFill) {
  for (const shape of art.shapes) {
    if (!shape.fill || shape.fill === 'ink') continue
    const color = resolveFill(shape.fill, 'light')
    if (luminance(color) > 0.2 && luminance(color) < 0.75) return color
  }
  return ink
}

// A porch rocking chair seen from the side, in units of its height (u = 1).
function paintChair (image, cx, top, u, ink, cushion) {
  const poly = (points, color) => paintPolygon(image, points.map(([x, y]) => [cx + x * u, top + y * u]), color)
  const rect = (x, y, w, h, color, radius = 0) => paintBox(image, { left: cx + x * u, top: top + y * u, width: w * u, height: h * u, radius: radius * u, color })
  // Backrest leaning back, then the cushion in front of it.
  poly([[-0.3, 0], [-0.17, 0], [-0.07, 0.6], [-0.2, 0.6]], ink)
  poly([[-0.17, 0.12], [-0.11, 0.12], [-0.02, 0.56], [-0.08, 0.56]], cushion)
  // Seat and seat cushion.
  rect(-0.2, 0.6, 0.5, 0.07, ink, 0.02)
  rect(-0.06, 0.53, 0.34, 0.07, cushion, 0.03)
  // Armrest with its front post.
  rect(0, 0.4, 0.3, 0.05, ink, 0.025)
  rect(0.23, 0.4, 0.06, 0.27, ink)
  // Back leg slanted, front leg straight, rocker base.
  poly([[-0.17, 0.67], [-0.08, 0.67], [-0.21, 0.9], [-0.3, 0.9]], ink)
  rect(0.22, 0.67, 0.07, 0.23, ink)
  rect(-0.4, 0.88, 0.8, 0.07, ink, 0.035)
}

async function renderDesign (id) {
  const { CANVAS, SAFE_AREA, artFor, layoutArt, resolveFill } = await import('../src/inviteCardArt.js')
  const art = artFor(id)
  const image = { width: WIDTH * SAMPLE, height: HEIGHT * SAMPLE, rgb: new Uint8Array(WIDTH * HEIGHT * SAMPLE * SAMPLE * 3) }
  paintBox(image, { left: 0, top: 0, width: image.width, height: image.height, color: resolveFill(art.bg, 'light') })
  for (const item of layoutArt(art, image.width, image.height, 'light')) paintShape(image, item)
  const scale = image.width / CANVAS.w
  const panel = { left: SAFE_AREA.x * scale, top: SAFE_AREA.y * scale, width: SAFE_AREA.w * scale, height: SAFE_AREA.h * scale, radius: PANEL_RADIUS * SAMPLE, color: PANEL_COLOR }
  paintBox(image, panel)
  const size = panel.height * 0.52
  const cx = panel.left + panel.width / 2
  const top = panel.top + (panel.height - size) / 2
  const ink = resolveFill(art.ink, 'light')
  paintChair(image, cx, top, size, ink, cushionColor(art, ink, resolveFill))
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const source = (y * SAMPLE * image.width + x * SAMPLE) * 3
      const target = (y * WIDTH + x) * 3
      for (let c = 0; c < 3; c++) {
        rgb[target + c] = Math.round((image.rgb[source + c] + image.rgb[source + 3 + c] + image.rgb[source + image.width * 3 + c] + image.rgb[source + image.width * 3 + 3 + c]) / 4)
      }
    }
  }
  return { width: WIDTH, height: HEIGHT, rgb }
}

async function main () {
  if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Uso: node apps/app/scripts/render-og.js [--check]')
  const check = process.argv.includes('--check')
  const directory = path.join(__dirname, '../public/og')
  if (!check) fs.mkdirSync(directory, { recursive: true })
  for (const id of [null, ...DESIGNS]) {
    const name = id === null ? 'convite.png' : 'convite-' + id + '.png'
    const file = path.join(directory, name)
    const rendered = await renderDesign(id)
    if (check) {
      try {
        const saved = decodePngRgb(fs.readFileSync(file))
        if (saved.width !== rendered.width || saved.height !== rendered.height || !Buffer.from(saved.rgb).equals(rendered.rgb)) {
          throw new Error('pixels diferentes')
        }
        console.log(name + ': confere')
      } catch {
        console.error(name + ': ausente, inválido ou diferente da arte atual')
        process.exitCode = 1
      }
    } else {
      const png = encodePng(rendered)
      fs.writeFileSync(file, png)
      console.log(name + ': ' + png.length + ' bytes')
    }
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error('Não foi possível renderizar as imagens de convite. Uso: node apps/app/scripts/render-og.js [--check]')
    process.exitCode = 1
  })
}

module.exports = { renderDesign, encodePng, decodePngRgb }
