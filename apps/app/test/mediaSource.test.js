'use strict'

// Pure source decisions of the native encoders (src/media/source.js).
const test = require('brittle')

const load = () => import('../src/media/source.js')

test('acceptedSource: any image type, HEIC included, or an empty type', async (t) => {
  const { acceptedSource } = await load()
  for (const m of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/HEIF', 'image/avif', '']) {
    t.ok(acceptedSource(m), m)
  }
  for (const m of ['video/mp4', 'application/pdf', 'text/plain']) t.absent(acceptedSource(m), m)
  t.absent(acceptedSource(undefined))
  t.absent(acceptedSource(null))
})

test('canHaveAlpha: only png and webp', async (t) => {
  const { canHaveAlpha } = await load()
  t.ok(canHaveAlpha('image/png'))
  t.ok(canHaveAlpha('image/WEBP'))
  for (const m of ['image/jpeg', 'image/heic', 'image/gif', '', undefined]) t.absent(canHaveAlpha(m), String(m))
})

test('gifOverCap: decided from the size alone', async (t) => {
  const { gifOverCap } = await load()
  const cap = 8 * 1024 * 1024
  t.absent(gifOverCap(cap, cap))
  t.ok(gifOverCap(cap + 1, cap))
})
