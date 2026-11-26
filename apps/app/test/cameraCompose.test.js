'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const source = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')
const asset = { uri: 'file:///cache/CameraCapture/' + 'a'.repeat(32) + '.jpg', mimeType: 'image/jpeg', width: 640, height: 480 }

function evaluate (code, deps) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), code)(...Object.values(deps))
}

async function composer (overrides = {}) {
  const calls = []
  const notes = []
  const errors = []
  const choices = []
  const plan = await import('../src/media/plan.js')
  const video = await import('../src/videoCompose.js')
  const camera = await import('../src/cameraChoice.js')
  const moment = {
    pending: false,
    held: false,
    photo: { items: [], busy: false },
    video: { draft: video.createVideoDraft({ moment: true }) },
    musicAvailable: true,
    music: null,
    setNote: (text) => notes.push(text),
    setError: (text) => errors.push(text),
    pick: () => calls.push('moment gallery photo'),
    pickClip: () => calls.push('moment gallery video'),
    stagePhoto: async (file) => { calls.push(['stagePhoto', file]); return true },
    stageClip: (pickVideo) => moment.video.draft.pick({ pickVideo, prepareVideo: ctx.prepareVideo })
  }
  const ctx = {
    ...plan,
    ...video,
    ...camera,
    ...(await import('../src/musicDraft.js')),
    cap: { photo: true, video: true },
    asPage: null,
    momentMode: false,
    canAttach: true,
    canVideo: true,
    mediaOnline: true,
    busy: false,
    frozen: false,
    pollActive: false,
    eventActive: false,
    liveRef: { current: new Set() },
    originalsRef: { current: new Map() },
    linkDraft: { view: null },
    musicDraftRef: { current: null },
    moment,
    video: { draft: video.createVideoDraft() },
    setNote: (text) => notes.push(text),
    setSourceKind: (kind) => choices.push(kind),
    capturePhoto: async () => { calls.push('capture photo'); return asset },
    captureVideo: async (opts) => { calls.push(['capture video', opts]); return asset },
    discardCapture: (uri) => calls.push(['discard', uri]),
    addFiles: async (files, onRoom) => { calls.push(['addFiles', files]); onRoom(0) },
    prepareVideo: async (file, opts) => { calls.push(['prepare', opts.maxMs]); return null },
    attach: () => calls.push('post gallery photo'),
    attachVideo: () => calls.push('post gallery video'),
    ...overrides
  }
  const code = source.slice(source.indexOf('  const capturePostPhoto ='), source.indexOf('  const handleRemoveMomentVideo ='))
  const render = () => evaluate(code + '\nreturn { chooseSource, actionsForSource, capturePostPhoto, capturePostVideo, captureMomentPhoto, captureMomentVideo, handlePickMoment, handlePickMomentVideo }', ctx)
  return { ctx, calls, notes, errors, choices, render, ...render() }
}

test('composer sources: capability chooses rows or the exact gallery handler, Pages stay gallery only', async (t) => {
  for (const momentMode of [false, true]) {
    for (const cap of [{ photo: false, video: false }, { photo: true, video: false }, { photo: false, video: true }, { photo: true, video: true }]) {
      for (const kind of ['photo', 'video']) {
        const h = await composer({ momentMode, cap })
        const gallery = momentMode ? (kind === 'photo' ? h.ctx.moment.pick : h.ctx.moment.pickClip) : (kind === 'photo' ? h.ctx.attach : h.ctx.attachVideo)
        await h.chooseSource(kind)
        if (cap[kind]) {
          t.alike(h.choices, [kind])
          t.alike(h.calls, [], 'opening the menu never opens a picker')
          const rows = h.actionsForSource(kind)
          t.alike(rows.map((r) => r.label), ['Galeria', 'Câmera'])
          t.is(rows[0].onPress, gallery)
          t.is(rows[1].onPress, momentMode ? (kind === 'photo' ? h.captureMomentPhoto : h.captureMomentVideo) : (kind === 'photo' ? h.capturePostPhoto : h.capturePostVideo))
          if (kind === 'video') t.is(rows[1].description, momentMode ? 'até 15 segundos' : 'até 30 segundos')
          rows[0].onPress()
        } else {
          t.alike(h.choices, [])
        }
        t.alike(h.calls, [(momentMode ? 'moment' : 'post') + ' gallery ' + kind])
        h.ctx.asPage = 'page'
        const page = h.render()
        t.alike(page.actionsForSource(kind), [], 'no camera for Pages')
        await page.capturePostPhoto()
        await page.capturePostVideo()
        await page.captureMomentPhoto()
        await page.captureMomentVideo()
        t.is(h.calls.length, 1, 'camera actions also guard the acting identity')
      }
    }
  }
  t.is((source.match(/<ActionsSheet /g) || []).length, 1, 'one shared source sheet')
  t.is((source.match(/\{sourceSheet\}/g) || []).length, 2, 'rendered in either composer mode')
  t.is((source.match(/onPress=\{handlePickMoment\}/g) || []).length, 2, 'photo toolbar and empty tile share the choice')
  t.ok(source.includes("onPress={() => chooseSource('video')}"), 'post video opens the choice')
  t.ok(source.includes("else chooseSource('photo')"), 'post photo keeps the room guard')
  t.ok(source.includes('title={sourceTitle(sourceKind)}'))
})

test('a camera photo kept for a retry keeps its file', async (t) => {
  const h = await composer({ addFiles: async (files) => { h.calls.push(['addFiles', files]); return ['item-1'] } })
  await h.render().capturePostPhoto()
  t.alike(h.calls, ['capture photo', ['addFiles', [asset]]], 'no discard while the retry holds the file')
  const done = await composer({ addFiles: async (files) => { done.calls.push(['addFiles', files]); return [] } })
  await done.render().capturePostPhoto()
  t.alike(done.calls, ['capture photo', ['addFiles', [asset]], ['discard', asset.uri]])
})

test('a camera photo kept as the original for re-framing keeps its file until the item drops it', async (t) => {
  const h = await composer()
  h.ctx.addFiles = async (files) => { h.calls.push(['addFiles', files]); h.ctx.originalsRef.current.set('item-1', files[0]); return [] }
  await h.render().capturePostPhoto()
  t.alike(h.calls, ['capture photo', ['addFiles', [asset]]], 'no discard while the original can re-frame')
  t.ok(source.includes('const dropOriginal = (id) => {') && source.includes('    if (file) discardCapture(file.uri)\n'), 'dropping an original deletes a camera file')
  t.ok(source.includes('      dropOriginal(id)\n      appliedRef.current.delete(id)'), 'removing an item drops its original')
  t.ok(source.includes('    dropOriginal(id)\n  }'), 'forgetting an original drops it')
  t.ok(source.includes('for (const file of originalsRef.current.values()) discardCapture(file && file.uri)'), 'closing the composer deletes kept camera files')
})

test('camera photos: encode before discarding, including refusal and failure; cancel does nothing', async (t) => {
  for (const momentMode of [false, true]) {
    for (const outcome of ['success', 'refused', 'error', 'cancel', 'denied']) {
      const h = await composer({ momentMode })
      if (outcome === 'cancel') h.ctx.capturePhoto = async () => null
      if (outcome === 'denied') h.ctx.capturePhoto = async () => { throw Object.assign(new Error('raw details'), { code: 'CAMERA_DENIED' }) }
      let settle
      const pending = new Promise((resolve) => { settle = resolve })
      const encode = async () => {
        h.calls.push('encoding')
        await pending
        if (outcome === 'error') throw new Error('não foi possível preparar a foto')
        return outcome !== 'refused'
      }
      if (momentMode) h.ctx.moment.stagePhoto = encode
      else h.ctx.addFiles = encode
      const handlers = h.render()
      const task = momentMode ? handlers.captureMomentPhoto() : handlers.capturePostPhoto()
      await Promise.resolve()
      t.absent(h.calls.some((c) => Array.isArray(c) && c[0] === 'discard'), 'capture remains during encode')
      settle()
      await task
      if (outcome === 'cancel' || outcome === 'denied') {
        t.alike(h.calls, [])
        if (outcome === 'denied') t.is((momentMode ? h.errors : h.notes).at(-1), h.ctx.CAPTURE_TEXT.CAMERA_DENIED)
      } else {
        t.alike(h.calls, ['capture photo', 'encoding', ['discard', asset.uri]])
        if (outcome === 'error') t.is((momentMode ? h.errors : h.notes).at(-1), 'não foi possível preparar a foto')
      }
    }
    const h = await composer({ momentMode })
    await (momentMode ? h.captureMomentPhoto() : h.capturePostPhoto())
    t.alike(h.calls[1], momentMode ? ['stagePhoto', asset] : ['addFiles', [asset]])
    t.alike(h.calls.at(-1), ['discard', asset.uri])
  }
})

test('a photo refused after capture is still discarded and the post room note is preserved', async (t) => {
  const h = await composer()
  h.ctx.addFiles = async (files, onRoom) => { onRoom(1) }
  await h.render().capturePostPhoto()
  t.is(h.notes.at(-1), 'até 10 fotos por publicação')
  t.alike(h.calls.at(-1), ['discard', asset.uri])
  h.ctx.capturePhoto = async () => {
    h.ctx.moment.video.draft = { state: { phase: 'ready' } }
    return asset
  }
  h.calls.length = 0
  await h.render().captureMomentPhoto()
  t.is(h.notes.at(-1), h.ctx.MOMENT_ONE_MEDIA)
  t.alike(h.calls, [['discard', asset.uri]], 'no replacement of a video that arrived during capture')
})

test('camera guards: post state, video or photos, moment hold and music block capture', async (t) => {
  for (const guard of ['busy', 'frozen', 'pollActive', 'eventActive']) {
    const h = await composer({ [guard]: true })
    await h.capturePostPhoto()
    await h.capturePostVideo()
    t.alike(h.calls, [], guard)
  }
  for (const guard of ['canAttach', 'mediaOnline']) {
    const h = await composer({ [guard]: false })
    await h.capturePostPhoto()
    t.alike(h.calls, [], guard)
  }
  const offline = await composer({ canVideo: false })
  await offline.capturePostVideo()
  await offline.captureMomentVideo()
  t.alike(offline.calls, [])
  const h = await composer()
  h.ctx.video.draft = { state: { phase: 'ready' } }
  await h.capturePostPhoto()
  t.is(h.notes.at(-1), h.ctx.VIDEO_OR_PHOTOS)
  for (const guard of ['pending', 'held']) {
    h.ctx.moment[guard] = true
    await h.captureMomentPhoto()
    await h.captureMomentVideo()
    h.ctx.moment[guard] = false
  }
  h.ctx.moment.video.draft = { state: { phase: 'ready' } }
  await h.captureMomentPhoto()
  await h.captureMomentVideo()
  t.is(h.notes.at(-1), h.ctx.MOMENT_ONE_MEDIA)
  h.ctx.moment.video.draft.state.phase = 'empty'
  h.ctx.moment.music = {}
  await h.captureMomentVideo()
  t.is(h.notes.at(-1), h.ctx.MUSIC_MOMENT_VIDEO_TEXT)
  h.ctx.moment.music = null
  h.ctx.moment.photo.items = [{}]
  await h.captureMomentVideo()
  t.is(h.notes.at(-1), h.ctx.MOMENT_ONE_MEDIA)
  t.alike(h.calls, [], 'all guards run before capture')
  const photos = await composer({ liveRef: { current: new Set([1]) } })
  await photos.capturePostVideo()
  t.alike(photos.calls, [])
  t.is(photos.notes.at(-1), photos.ctx.VIDEO_OR_PHOTOS)
  for (const conflict of [{ linkDraft: { view: {} } }, { musicDraftRef: { current: {} } }]) {
    const preview = await composer(conflict)
    await preview.capturePostVideo()
    t.alike(preview.calls, [])
    t.is(preview.notes.at(-1), preview.ctx.VIDEO_OR_PREVIEW)
  }
})

test('camera videos use 30 seconds for posts and 15 for momentos and handle capture and OVER_LIMIT errors', async (t) => {
  for (const momentMode of [false, true]) {
    const h = await composer({ momentMode })
    await (momentMode ? h.captureMomentVideo() : h.capturePostVideo())
    const maxMs = momentMode ? 15000 : 30000
    t.alike(h.calls, [['capture video', { maxMs }], ['prepare', maxMs]])
    for (const error of [{ code: 'CAMERA_DENIED', message: 'raw details' }, { code: 'OVER_LIMIT', message: 'Vídeo longo demais.' }]) {
      h.ctx.captureVideo = async () => {
        if (error.code === 'CAMERA_DENIED') throw error
        return asset
      }
      h.ctx.prepareVideo = async () => { throw error }
      const handlers = h.render()
      await (momentMode ? handlers.captureMomentVideo() : handlers.capturePostVideo())
      t.is((momentMode ? h.errors : h.notes).at(-1), error.code === 'CAMERA_DENIED' ? h.ctx.CAPTURE_TEXT.CAMERA_DENIED : error.message)
    }
    h.calls.length = 0
    h.ctx.captureVideo = async () => null
    const handlers = h.render()
    await (momentMode ? handlers.captureMomentVideo() : handlers.capturePostVideo())
    t.alike(h.calls, [], 'cancellation never prepares or discards a video in the composer')
    t.is((momentMode ? h.errors : h.notes).at(-1), '')
  }
})

test('opening probes once and sweeps without waiting; late capability answers are ignored', async (t) => {
  const effect = source.slice(source.indexOf('  const [cap, setCap]'), source.indexOf("  const [text, setText] = useState('')", source.indexOf('export default function Publicar')))
  for (const open of [false, true]) {
    const calls = []
    let resolve, cleanup
    const promise = new Promise((_resolve) => { resolve = _resolve })
    evaluate(effect, {
      open,
      useState: (initial) => { calls.push(initial); return [initial, (value) => calls.push(value)] },
      useEffect: (fn, deps) => { t.alike(deps, [open]); cleanup = fn() },
      canCapture: () => { calls.push('probe'); return promise },
      sweepCaptures: () => calls.push('sweep')
    })
    t.alike(calls.slice(0, 3), [{ photo: false, video: false }, null, null])
    t.alike(calls.slice(3), open ? ['sweep', 'probe'] : [])
    if (cleanup) cleanup()
    resolve({ photo: true, video: true })
    await promise
    await Promise.resolve()
    t.is(calls.length, open ? 5 : 3, 'no state write after closing or unmount')
  }
  const answers = []
  const promise = Promise.resolve({ photo: true, video: false })
  evaluate(effect, {
    open: true,
    useState: (initial) => [initial, (value) => answers.push(value)],
    useEffect: (fn) => fn(),
    canCapture: () => promise,
    sweepCaptures: () => {}
  })
  await promise
  t.alike(answers, [null, { photo: true, video: false }], 'a mounted composer uses the capability answer')
})
