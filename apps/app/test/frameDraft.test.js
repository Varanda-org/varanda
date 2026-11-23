'use strict'

const test = require('brittle')
const load = () => import('../src/frameDraft.js')

const initial = { zoom: 1, cx: 0.5, cy: 0.5 }
const still = { id: 'still', status: 'ready', encoded: { mime: 'image/jpeg', width: 1080, height: 1080 }, thumb: 'blob:still' }
const gif = { id: 'gif', status: 'ready', encoded: { mime: 'image/gif', width: 1920, height: 1080 }, thumb: 'blob:gif' }
const statuses = ['encoding', 'invalid', 'ready', 'uploading', 'failed', 'done']

test('seedFrame keeps an existing frame and seeds from the first encoded dimensions', async (t) => {
  const { seedFrame } = await load()
  const frame = { id: 'portrait', chosen: true }
  t.is(seedFrame(frame, { width: 1920, height: 1080 }), frame)
  t.alike(seedFrame(null, { width: 4032, height: 3024 }), { id: 'square', chosen: false })
  t.alike(seedFrame(null, { width: 3024, height: 4032 }), { id: 'portrait', chosen: false })
  t.alike(seedFrame(null, { width: 1920, height: 1080 }), { id: 'landscape', chosen: false })
})

test('frameRatioOf and frameLabel look up the same frame presets', async (t) => {
  const { frameLabel, frameRatioOf } = await load()
  for (const [frame, ratio, label] of [
    [{ id: 'portrait' }, 4 / 5, 'Retrato'],
    [{ id: 'square' }, 1, 'Quadrado'],
    [{ id: 'landscape' }, 16 / 9, 'Paisagem'],
    [{ id: 'unknown' }, 1, ''],
    [null, 1, '']
  ]) {
    t.is(frameRatioOf(frame), ratio)
    t.is(frameLabel(frame), label)
  }
})

test('canFrame requires a ready still and blocks during encoding or after upload starts', async (t) => {
  const { GIF_MIME, canFrame, isFixed } = await load()
  t.is(GIF_MIME, 'image/gif')
  t.is(isFixed(gif), true)
  t.is(isFixed(still), false)
  t.is(canFrame([gif], {}), false)
  t.is(canFrame([gif, still], {}), true)
  for (const status of statuses) {
    const item = { ...still, id: 'other', status }
    // A failed upload with no retry is sent again, so it is framed too.
    t.is(canFrame([item], {}), status === 'ready' || status === 'failed', `${status} alone`)
    t.is(canFrame([still, item], {}), status !== 'encoding' && status !== 'uploading', `${status} beside a ready still`)
  }
  t.is(canFrame([still, { ...gif, descriptor: {} }], {}), false)
  t.is(canFrame([still, { ...gif, retry: () => {} }], {}), false)
  t.is(canFrame([{ ...still, descriptor: null, retry: null }], {}), true)
  t.is(canFrame([{ ...still, retry: true }], {}), true)
  for (const flag of ['held', 'busy', 'frozen']) {
    t.is(canFrame([still], { [flag]: true }), false, flag)
  }
  t.is(canFrame([], {}), false)
})

test('editorPhotos keeps each crop in the coordinate space of its image', async (t) => {
  const { editorPhotos } = await load()
  const whole = { uri: 'file:whole', width: 4032, height: 3024 }
  const crop = { zoom: 2, cx: 0.4, cy: 0.6 }
  t.alike(editorPhotos([
    { ...still, id: 'whole', whole, crop, cropBase: 'full' },
    { ...still, id: 'encoded', whole, crop, cropBase: 'encoded' },
    gif,
    still
  ]), [
    { id: 'whole', uri: 'file:whole', width: 4032, height: 3024, crop, cropBase: 'full', fixed: false },
    { id: 'encoded', uri: 'blob:still', width: 1080, height: 1080, crop, cropBase: 'encoded', fixed: false },
    { id: 'gif', uri: 'blob:gif', width: 1920, height: 1080, crop: initial, cropBase: 'full', fixed: true },
    { id: 'still', uri: 'blob:still', width: 1080, height: 1080, crop: initial, cropBase: 'full', fixed: false }
  ])
})

test('editorPhotos skips items that are unready or lack a usable image', async (t) => {
  const { editorPhotos } = await load()
  t.alike(editorPhotos([
    ...statuses.filter(status => status !== 'ready' && status !== 'failed').map(status => ({ ...still, status })),
    { ...still, status: 'failed', retry: () => {} },
    { ...still, thumb: null },
    { ...still, thumb: ' ' },
    { ...still, encoded: null },
    { ...still, encoded: { width: 0, height: 1080 } },
    { ...still, encoded: { width: 1080, height: Infinity } },
    { ...still, whole: { uri: 'file:whole' } }
  ]), [])
})

test('reframeIds selects ready stills in item order when the frame changes', async (t) => {
  const { reframeIds } = await load()
  const items = [still, gif, { ...still, id: 'other' }, { ...still, id: 'failed', status: 'failed', retry: () => {} }]
  t.alike(reframeIds(items, 'square', 'portrait', {}), ['still', 'other'])
})

test('reframeIds compares each crop coordinate and defaults an unset crop', async (t) => {
  const { reframeIds } = await load()
  const crop = { zoom: 2, cx: 0.4, cy: 0.6 }
  const items = [still, gif, { ...still, id: 'other', crop }]
  const crops = { still: { ...initial }, other: { ...crop }, gif: crop }
  t.alike(reframeIds(items, 'square', 'square', crops), [])
  t.alike(reframeIds(items, 'square', 'square', { still: initial }), [])
  for (const field of ['zoom', 'cx', 'cy']) {
    t.alike(reframeIds(items, 'square', 'square', { ...crops, other: { ...crop, [field]: initial[field] } }), ['other'], field)
  }
  t.alike(reframeIds(items, 'square', 'square', { ...crops, still: crop }), ['still'])
})

test('keepsFrame retains a chosen frame until empty and an automatic frame while usable items remain', async (t) => {
  const { keepsFrame } = await load()
  const auto = { id: 'square', chosen: false }
  const chosen = { ...auto, chosen: true }
  t.is(keepsFrame(auto, []), false)
  t.is(keepsFrame(chosen, []), false)
  for (const status of statuses) {
    t.is(keepsFrame(auto, [{ status }]), status !== 'invalid', status)
  }
  t.is(keepsFrame(chosen, [{ status: 'invalid' }]), true)
  t.is(keepsFrame(auto, [{ status: 'invalid' }, gif]), true)
})

test('leadFrame uses only a ready GIF in the first position', async (t) => {
  const { leadFrame } = await load()
  t.is(leadFrame([gif, still]), 'landscape')
  t.is(leadFrame([{ ...gif, encoded: { ...gif.encoded, width: 800, height: 1000 } }]), 'portrait')
  t.is(leadFrame([still, gif]), null)
  t.is(leadFrame([{ ...gif, status: 'encoding' }, gif]), null)
  t.is(leadFrame([]), null)
})

test('frame draft rules tolerate malformed inputs', async (t) => {
  const { canFrame, editorPhotos, frameLabel, frameRatioOf, isFixed, keepsFrame, leadFrame, reframeIds, seedFrame } = await load()
  const auto = { id: 'square', chosen: false }
  for (const value of [undefined, null, 17, 'photo', Symbol('photo'), {}, [undefined, null, 17, 'photo', {}]]) {
    t.is(isFixed(value), false)
    t.alike(seedFrame(null, value), auto)
    t.is(frameRatioOf(value), 1)
    t.is(frameLabel(value), '')
    t.is(canFrame(value, null), false)
    t.alike(editorPhotos(value), [])
    t.alike(reframeIds(value, 'square', 'portrait', null), [])
    t.is(keepsFrame(auto, value), false)
    t.is(leadFrame(value), null)
  }
  t.is(keepsFrame(null, [still]), false)
  t.alike(reframeIds([{ ...still, id: Object.create(null) }], 'square', 'square', {}), [])
  t.alike(reframeIds([still], 'square', 'square', null), [])
})

test('a photo whose upload failed for good follows the frame; one with a retry does not', async (t) => {
  const { canFrame, editorPhotos, reframeIds } = await load()
  const lost = { ...still, id: 'lost', status: 'failed', thumb: 'blob:lost' }
  const pending = { ...lost, id: 'pending', retry: () => {} }
  t.ok(canFrame([lost], {}), 'failed without retry can be framed')
  t.alike(editorPhotos([lost]).map((p) => p.id), ['lost'])
  t.alike(reframeIds([still, lost], 'square', 'portrait', null), ['still', 'lost'])
  t.absent(canFrame([still, pending], {}), 'a pending retry locks the editor')
  t.alike(editorPhotos([pending]), [])
  t.alike(reframeIds([pending], 'square', 'portrait', null), [])
  t.alike(reframeIds([{ ...lost, descriptor: { id: 'x' } }], 'square', 'portrait', null), [], 'an uploaded photo is excluded')
})
