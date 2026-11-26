'use strict'

const test = require('brittle')
const load = () => import('../src/mediaAlt.js')
const MAX = 140
const m2 = [{}, {}]

test('photoLabel with and without description', async (t) => {
  const { photoLabel } = await load()
  const media = [{}, {}, {}, {}]
  t.is(photoLabel({ alt: [null, 'Um gato', null, null], media, index: 1, count: 4 }), 'Um gato, foto 2 de 4')
  t.is(photoLabel({ alt: [null, 'Um gato', null, null], media, index: 0, count: 4 }), 'foto 1 de 4')
  t.is(photoLabel({ media, index: 2, count: 4 }), 'foto 3 de 4')
})

test('wrong length or non-string entries are ignored', async (t) => {
  const { photoLabel, lineUp } = await load()
  const media = [{}, {}]
  t.is(lineUp(['a'], media), null)
  t.is(lineUp('ab', media), null)
  t.is(lineUp(['a', 1], media), null)
  t.is(lineUp(['a', null], media).length, 2)
  t.is(photoLabel({ alt: ['a'], media, index: 0, count: 2 }), 'foto 1 de 2')
  t.is(photoLabel({ alt: ['a', 5], media, index: 0, count: 2 }), 'foto 1 de 2')
})

test('hostile text is cleaned and capped', async (t) => {
  const { altText } = await load()
  const out = altText(['  a‮b\nc\u0007d  '], 0)
  t.is(out, 'a�b�c�d')
  t.is(Array.from(altText(['x'.repeat(5000)], 0)).length, MAX)
  t.is(Array.from(altText(['😀'.repeat(300)], 0)).length, MAX)
  t.is(altText(['   '], 0), '')
  t.is(altText(null, 0), '')
})

test('videoLabel uses alt[1] then alt[0]', async (t) => {
  const { videoLabel } = await load()
  t.is(videoLabel({ alt: ['capa', 'clipe'], media: m2, seconds: 5 }), 'clipe, vídeo de 5 segundos')
  t.is(videoLabel({ alt: ['capa', null], media: m2, seconds: 1 }), 'capa, vídeo de 1 segundo')
  t.is(videoLabel({ alt: [null, null], media: m2, seconds: 2 }), 'vídeo de 2 segundos')
  t.is(videoLabel({ media: m2, seconds: 2 }), 'vídeo de 2 segundos')
})

test('cleanAltInput', async (t) => {
  const { cleanAltInput } = await load()
  t.is(cleanAltInput('a\nb\tc\u0000d'), 'a b c d')
  t.is(cleanAltInput(' a '), ' a ')
  t.is(Array.from(cleanAltInput('y'.repeat(500))).length, MAX)
})

test('altParam and videoAltParam', async (t) => {
  const { altParam, videoAltParam } = await load()
  t.is(altParam(['', '  ']), null)
  t.alike(altParam([' a ', '', 'b']), ['a', null, 'b'])
  t.is(videoAltParam('  '), null)
  t.alike(videoAltParam(' oi '), [null, 'oi'])
})

test('validAlt', async (t) => {
  const { validAlt } = await load()
  t.ok(validAlt([null, 'ok'], m2))
  t.absent(validAlt([null], m2))
  t.absent(validAlt(['', null], m2))
  t.absent(validAlt(['x'.repeat(MAX + 1), null], m2))
  t.ok(validAlt(['x'.repeat(MAX), null], m2))
  t.absent(validAlt([1, null], m2))
  t.absent(validAlt(undefined, m2))
})
