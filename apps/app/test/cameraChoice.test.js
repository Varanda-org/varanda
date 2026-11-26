'use strict'

const test = require('brittle')

const load = () => import('../src/cameraChoice.js')

const CODES = ['CAMERA_DENIED', 'CAMERA_UNAVAILABLE', 'CAMERA_BUSY', 'CAMERA_FAILED']

test('CAPTURE_TEXT is a frozen map of the four capture lines', async (t) => {
  const { CAPTURE_TEXT } = await load()
  t.alike(Object.keys(CAPTURE_TEXT), CODES)
  t.alike(CAPTURE_TEXT, {
    CAMERA_DENIED: 'sem permissão para usar a câmera. Libere nos Ajustes do aparelho',
    CAMERA_UNAVAILABLE: 'nenhum app de câmera foi encontrado',
    CAMERA_BUSY: 'a câmera já está aberta',
    CAMERA_FAILED: 'não foi possível usar a câmera'
  })
  t.is(Object.isFrozen(CAPTURE_TEXT), true)
  t.ok(Object.isFrozen(CAPTURE_TEXT), 'frozen text rejects writes')
  t.is(CAPTURE_TEXT.CAMERA_DENIED, 'sem permissão para usar a câmera. Libere nos Ajustes do aparelho')
})

test('captureError uses the matching line and falls back to CAMERA_FAILED', async (t) => {
  const { CAPTURE_TEXT, captureError } = await load()
  for (const code of CODES) {
    const err = captureError(code)
    t.ok(err instanceof Error)
    t.is(err.message, CAPTURE_TEXT[code])
    t.is(err.code, code)
    t.ok(captureError(code) !== err, 'each call is a new error')
  }
  for (const code of [undefined, null, '', 'camera_denied', 'CAMERA_DENIED ', 'NOPE', 'toString', 'constructor', 1, true, {}, []]) {
    const err = captureError(code)
    t.ok(err instanceof Error)
    t.is(err.message, CAPTURE_TEXT.CAMERA_FAILED)
    t.is(err.code, 'CAMERA_FAILED', 'unknown code ' + JSON.stringify(code))
  }
})

test('captureErrorText returns a known line or null', async (t) => {
  const { CAPTURE_TEXT, captureError, captureErrorText } = await load()
  for (const code of CODES) {
    t.is(captureErrorText(captureError(code)), CAPTURE_TEXT[code])
    t.is(captureErrorText({ code, message: 'English' }), CAPTURE_TEXT[code])
    t.is(captureErrorText({ code }), CAPTURE_TEXT[code])
  }
  for (const err of [
    null,
    undefined,
    false,
    0,
    1,
    '',
    'CAMERA_DENIED',
    {},
    { code: null },
    { code: undefined },
    { code: '' },
    { code: 'NOPE' },
    { code: 'camera_denied' },
    { code: 'CAMERA_DENIED ' },
    new Error('Permission denied'),
    { message: CAPTURE_TEXT.CAMERA_FAILED }
  ]) {
    t.is(captureErrorText(err), null, 'not a capture error ' + JSON.stringify(err))
  }
})

test('sourceActions is empty unless this kind can capture', async (t) => {
  const { sourceActions } = await load()
  const onGallery = () => {}
  const onCamera = () => {}
  for (const kind of ['photo', 'video']) {
    for (const cap of [
      { photo: false, video: false },
      { photo: true, video: false },
      { photo: false, video: true },
      { photo: 1, video: 'true' },
      { photo: null, video: undefined },
      {},
      null,
      undefined
    ]) {
      const offered = cap && cap[kind] === true
      const rows = sourceActions({ cap, kind, maxMs: 5000, onGallery, onCamera })
      t.is(rows.length, offered ? 2 : 0, kind + ' ' + JSON.stringify(cap))
    }
  }
  t.alike(sourceActions({ cap: { photo: true }, kind: 'clip', onGallery, onCamera }), [])
  t.alike(sourceActions({ cap: { photo: true, video: true }, kind: 'Photo', onGallery, onCamera }), [])
})

test('sourceActions offers gallery then camera, with a video limit only when it is a positive integer', async (t) => {
  const { sourceActions } = await load()
  let gallery = 0
  let camera = 0
  const onGallery = () => { gallery++ }
  const onCamera = () => { camera++ }
  const photo = sourceActions({ cap: { photo: true, video: true }, kind: 'photo', maxMs: 5000, onGallery, onCamera })
  t.alike(Object.keys(photo[0]), ['icon', 'label', 'onPress'])
  t.alike(Object.keys(photo[1]), ['icon', 'label', 'onPress'])
  t.is(photo[0].icon, 'imagem')
  t.is(photo[0].label, 'Galeria')
  t.is(photo[0].onPress, onGallery)
  t.is(photo[1].icon, 'camera')
  t.is(photo[1].label, 'Câmera')
  t.is(photo[1].onPress, onCamera)
  t.is(Object.hasOwn(photo[0], 'description'), false)
  t.is(Object.hasOwn(photo[1], 'description'), false)
  photo[0].onPress()
  photo[1].onPress()
  t.is(gallery, 1)
  t.is(camera, 1)

  const open = sourceActions({ cap: { photo: false, video: true }, kind: 'video', onGallery, onCamera })
  t.is(open[1].icon, 'video')
  t.is(Object.hasOwn(open[1], 'description'), false, 'missing maxMs')

  for (const maxMs of [0, -1, -1000, 1.5, NaN, Infinity, -Infinity, '30000', null, undefined, true, false, 1000n]) {
    const rows = sourceActions({ cap: { video: true }, kind: 'video', maxMs, onGallery, onCamera })
    t.is(rows[1].icon, 'video')
    t.is(Object.hasOwn(rows[1], 'description'), false, 'no limit for ' + String(maxMs))
  }
  for (const [maxMs, seconds] of [[1, 0], [999, 0], [1000, 1], [1500, 1], [30000, 30], [60500, 60]]) {
    const rows = sourceActions({ cap: { video: true }, kind: 'video', maxMs, onGallery, onCamera })
    t.alike(Object.keys(rows[1]), ['icon', 'label', 'description', 'onPress'])
    t.is(rows[0].icon, 'imagem')
    t.is(rows[0].label, 'Galeria')
    t.is(rows[0].onPress, onGallery)
    t.is(Object.hasOwn(rows[0], 'description'), false)
    t.is(rows[1].description, 'até ' + seconds + ' segundos')
    t.is(rows[1].onPress, onCamera)
  }
})

test('sourceTitle names a photo or a video', async (t) => {
  const { sourceTitle } = await load()
  t.is(sourceTitle('photo'), 'Foto')
  t.is(sourceTitle('video'), 'Vídeo')
  for (const kind of ['Photo', 'VIDEO', '', 'clip', null, undefined, 1, true]) {
    t.is(sourceTitle(kind), undefined)
  }
})
