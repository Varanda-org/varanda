'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '../src/ui/ShareProfile.js'), 'utf8')

test('ShareProfile exports a direct share that reports false when it cannot share', (t) => {
  t.ok(/export async function shareProfileDirect \(url, nav = shareNav\(\)\)/.test(SRC))
  t.ok(/return result !== 'failed'/.test(SRC), 'cancelled is handled, failed is false')
  t.ok(/typeof url !== 'string'\) return false/.test(SRC))
})

test('copy reports through the caller toast, else inline', (t) => {
  t.ok(/onNotice \}\)/.test(SRC))
  t.ok(/if \(typeof onNotice === 'function'\) onNotice\(message\)\s+else setNote\(message\)/.test(SRC))
  t.absent(/setNote\('link copiado/.test(SRC), 'the confirmation goes through report')
  t.ok(/report\('link copiado'\)/.test(SRC))
})

test('share comes before copy', (t) => {
  t.ok(SRC.indexOf('label={text.share}') < SRC.indexOf('label={text.copy}'))
})

test('no QR code', (t) => {
  t.absent(/qr/i.test(SRC))
})

test('a copy failure stays inline even with onNotice', (t) => {
  t.ok(/setNote\('não foi possível copiar: o link está selecionado abaixo'\)/.test(SRC))
  t.absent(/report\('não foi possível copiar/.test(SRC))
})
