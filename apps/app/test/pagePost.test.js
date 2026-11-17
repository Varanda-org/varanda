// A page post op and its video upload (src/pagePost.js). The upload is
// injected; nothing here touches the network.
'use strict'

const test = require('brittle')

const load = () => import('../src/pagePost.js')

function clip (overrides = {}) {
  return {
    bytes: new Uint8Array(24),
    mime: 'video/mp4',
    width: 640,
    height: 360,
    ms: 3000,
    poster: { bytes: new Uint8Array([255, 216, 255, 217]), mime: 'image/jpeg', width: 640, height: 360 },
    ...overrides
  }
}

const photoD = (over = {}) => ({ blocks: 1, bytes: 10, core: 'ab'.repeat(32), height: 1, mime: 'image/jpeg', sha256: 'cd'.repeat(32), start: 1, width: 1, ...over })
const videoD = (over = {}) => ({ blocks: 1, bytes: 10, core: 'ef'.repeat(32), height: 360, mime: 'video/mp4', ms: 1000, sha256: '12'.repeat(32), start: 2, width: 640, ...over })

async function rejected (run) {
  try {
    await run()
  } catch (err) {
    return err
  }
  return null
}

test('pagePostOp keeps text and only the keys that are present', async (t) => {
  const { pagePostOp } = await load()
  t.alike(pagePostOp({ text: 'oi' }), { text: 'oi' })
  t.alike(pagePostOp({ text: 'oi', media: null, preview: null }), { text: 'oi' })
  t.alike(pagePostOp({ text: '', media: [] }), { text: '' })
  const photos = [{ mime: 'image/jpeg' }, { mime: 'image/png' }]
  t.alike(pagePostOp({ text: 'oi', media: photos }), { text: 'oi', media: photos })
  const preview = { url: 'https://exemplo.com/a', title: 'Titulo', desc: 'Uma linha', image: null }
  t.alike(pagePostOp({ text: 'oi', preview }), { text: 'oi', preview })
  t.alike(pagePostOp({ text: 'oi', media: [], preview }), { text: 'oi', preview })
})

test('pagePostOp refuses any media together with a preview', async (t) => {
  const { pagePostOp } = await load()
  const preview = { url: 'https://exemplo.com/a', title: 'T', desc: 'D', image: null }
  const pair = [photoD(), videoD()]
  const photos = [{ mime: 'image/jpeg' }, { mime: 'image/png' }]
  for (const media of [pair, photos, [photos[0]]]) {
    const err = await rejected(() => pagePostOp({ text: 'oi', media, preview }))
    t.ok(err instanceof Error)
    t.is(err.code, 'pedido-invalido')
    t.is(err.message, 'Pedido inválido')
    t.absent(err.uncertain)
  }
  t.alike(pagePostOp({ text: 'oi', media: pair }), { text: 'oi', media: pair })
})

test('prepPageVideo uploads the poster, then the video with ms, once each', async (t) => {
  const { prepPageVideo } = await load()
  const { readyVideo } = await import('../src/videoCompose.js')
  const file = clip()
  t.ok(readyVideo(file))
  const calls = []
  const posterDescriptor = photoD()
  const videoDescriptor = videoD({ ms: file.ms })
  const pair = await prepPageVideo({
    upload: async (arg) => {
      calls.push(arg)
      const descriptor = arg.mime === 'video/mp4' ? videoDescriptor : posterDescriptor
      return { seq: calls.length, length: calls.length + 1, pushed: true, descriptor }
    },
    file
  })
  t.is(calls.length, 2)
  t.is(calls[0].bytes, file.poster.bytes)
  t.is(calls[0].mime, 'image/jpeg')
  t.is(calls[0].width, 640)
  t.is(calls[0].height, 360)
  t.absent(calls[0].ms)
  t.is(Object.keys(calls[0]).length, 4)
  t.is(calls[1].bytes, file.bytes)
  t.is(calls[1].mime, 'video/mp4')
  t.is(calls[1].width, 640)
  t.is(calls[1].height, 360)
  t.is(calls[1].ms, 3000)
  t.is(Object.keys(calls[1]).length, 5)
  t.is(pair[0], posterDescriptor)
  t.is(pair[1], videoDescriptor)
})

test('prepPageVideo uploads nothing when the file is not a ready video', async (t) => {
  const { prepPageVideo } = await load()
  let calls = 0
  const upload = () => { calls++; return { descriptor: {} } }
  const badPoster = { mime: 'image/png', bytes: new Uint8Array([1]), width: 1, height: 1 }
  for (const file of [null, clip({ mime: 'image/jpeg' }), clip({ ms: 0 }), clip({ poster: badPoster })]) {
    const err = await rejected(() => prepPageVideo({ upload, file }))
    t.is(err.code, 'pedido-invalido')
    t.absent(err.uncertain)
  }
  const err = await rejected(() => prepPageVideo({ upload: null, file: clip() }))
  t.is(err.code, 'pedido-invalido')
  t.is(calls, 0)
})

test('a missing descriptor is uncertain and stops the upload, with no retry', async (t) => {
  const { prepPageVideo } = await load()
  const file = clip()
  let calls = 0
  let retried = false
  const fail = Object.assign(new Error('sem resposta'), { uncertain: true, retry () { retried = true } })
  const posterOnly = await rejected(() => prepPageVideo({
    upload: async () => {
      calls++
      return { seq: 1, length: 2, pushed: true }
    },
    file
  }))
  t.is(calls, 1, 'the video is not uploaded without a poster descriptor')
  t.is(posterOnly.uncertain, true)
  t.is(posterOnly.message, 'Resposta inválida ao enviar a capa do vídeo.')

  calls = 0
  const videoMissing = await rejected(() => prepPageVideo({
    upload: async (arg) => {
      calls++
      if (arg.mime === 'video/mp4') return { seq: 2, length: 3, pushed: true, descriptor: null }
      return { seq: 1, length: 2, pushed: true, descriptor: photoD() }
    },
    file
  }))
  t.is(calls, 2)
  t.is(videoMissing.uncertain, true)
  t.is(videoMissing.message, 'Resposta inválida ao enviar o vídeo.')

  calls = 0
  const thrown = await rejected(() => prepPageVideo({
    upload: async (arg) => {
      calls++
      if (arg.mime === 'video/mp4') throw fail
      return { descriptor: photoD() }
    },
    file
  }))
  t.is(thrown, fail)
  t.is(calls, 2)
  t.is(retried, false, 'prepPageVideo does not retry')
})

test('a failed video upload carries the poster descriptor and a retry skips the poster', async (t) => {
  const { prepPageVideo } = await load()
  const file = clip()
  const poster = photoD()
  const video = videoD({ ms: file.ms })
  let calls = []
  const fail = Object.assign(new Error('sem resposta'), { uncertain: true })
  const err = await rejected(() => prepPageVideo({
    upload: async (arg) => {
      calls.push(arg.mime)
      if (arg.mime === 'video/mp4') throw fail
      return { descriptor: poster }
    },
    file
  }))
  t.is(err, fail)
  t.alike(err.poster, poster)
  t.alike(calls, ['image/jpeg', 'video/mp4'])
  calls = []
  const pair = await prepPageVideo({
    upload: async (arg) => { calls.push(arg.mime); return { descriptor: video } },
    file,
    poster: err.poster
  })
  t.alike(calls, ['video/mp4'], 'the poster is not uploaded again')
  t.alike(pair, [poster, video])
})

test('a malformed descriptor is uncertain', async (t) => {
  const { prepPageVideo } = await load()
  const file = clip()
  const png = await rejected(() => prepPageVideo({ upload: async () => ({ descriptor: photoD({ mime: 'image/png' }) }), file }))
  t.is(png.uncertain, true)
  const notVideo = await rejected(() => prepPageVideo({
    upload: async () => ({ descriptor: photoD() }),
    file
  }))
  t.is(notVideo.uncertain, true)
  t.is(notVideo.message, 'Resposta inválida ao enviar o vídeo.')
})
