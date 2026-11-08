'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const DIR = path.join(__dirname, '..', 'artwork', 'play', 'screens')
const EXPECTED = ['a-rua.png', 'diario.png', 'conversas.png', 'conversa.png']
const MAX_BYTES = 8 * 1024 * 1024

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.png')).sort() : []

if (files.length === 0) {
  test('play screenshots: none captured yet, skipping', (t) => {
    t.pass('no PNG under apps/site/artwork/play/screens')
  })
} else {
  test('play screenshots: the four expected names are present', (t) => {
    for (const name of EXPECTED) t.ok(files.includes(name), name)
  })

  for (const name of files) {
    test(`play screenshot ${name}: 1080x1920, 24-bit without alpha, under 8 MB`, (t) => {
      const buf = fs.readFileSync(path.join(DIR, name))
      t.is(buf.subarray(1, 4).toString('latin1'), 'PNG', 'PNG signature')
      t.is(buf.subarray(12, 16).toString('latin1'), 'IHDR', 'IHDR first')
      t.is(buf.readUInt32BE(16), 1080, 'width')
      t.is(buf.readUInt32BE(20), 1920, 'height')
      t.is(buf[24], 8, 'bit depth')
      t.is(buf[25], 2, 'colour type 2 (RGB, no alpha)')
      t.ok(buf.length < MAX_BYTES, `${buf.length} bytes`)
    })
  }
}
