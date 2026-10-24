'use strict'

const test = require('brittle')

const load = () => import('../src/pwa-boot.js')
const full = { mode: 'browser', hosted: true, hasMarker: true, hasServiceWorker: true }

test('pwaBoot: registers only for the full combination', async (t) => {
  const { pwaBoot } = await load()
  t.alike(pwaBoot(full), { action: 'register', url: '/sw.js', scope: '/', updateViaCache: 'none' })
})

test('pwaBoot: none otherwise, never unregister', async (t) => {
  const { pwaBoot } = await load()
  for (const over of [{ mode: 'serve' }, { hosted: false }, { hasMarker: false }, { hasServiceWorker: false }]) {
    t.alike(pwaBoot({ ...full, ...over }), { action: 'none' }, JSON.stringify(over))
  }
})
