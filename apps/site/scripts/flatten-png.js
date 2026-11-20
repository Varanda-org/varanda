'use strict'

// Turns a PNG capture into a 24-bit PNG without alpha (colour type 2), as
// Google Play asks for screenshots. Transparent pixels are composited onto
// opaque white. Usage: node flatten-png.js <input.png> <output.png>

const fs = require('node:fs')
const { PNG } = require('pngjs')

function flatten (data) {
  const src = PNG.sync.read(data)
  const px = src.data
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]
    if (a === 255) continue
    for (let c = 0; c < 3; c++) px[i + c] = Math.round((px[i + c] * a + 255 * (255 - a)) / 255)
    px[i + 3] = 255
  }
  const out = PNG.sync.write(src, { colorType: 2, inputColorType: 6, inputHasAlpha: true, deflateLevel: 9 })
  return { png: out, width: src.width, height: src.height }
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) {
    console.error('uso: node flatten-png.js <entrada.png> <saida.png>')
    process.exit(2)
  }
  const { png, width, height } = flatten(fs.readFileSync(input))
  fs.writeFileSync(output, png)
  console.log(`${output} ${width}x${height}`)
}

module.exports = { flatten }
