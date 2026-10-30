'use strict'

const test = require('brittle')

const load = () => import('../src/share.js')

test('copyText writes text and reports unavailable or rejected clipboard', async (t) => {
  const { copyText } = await load()
  const calls = []
  const nav = { clipboard: { writeText: async (text) => { calls.push(text) } } }
  t.is(await copyText(nav, 'https://varanda.example/@ana'), true)
  t.alike(calls, ['https://varanda.example/@ana'])
  t.is(await copyText(null, 'x'), false)
  t.is(await copyText({}, 'x'), false)
  t.is(await copyText({ clipboard: {} }, 'x'), false)
  t.is(await copyText({ clipboard: { writeText: async () => { throw new Error('refused') } } }, 'x'), false)
})

test('shareUrl maps sharing outcomes', async (t) => {
  const { shareUrl } = await load()
  const calls = []
  const shared = await shareUrl({ share: (value) => { calls.push(value); return Promise.resolve() } }, {
    url: 'https://varanda.example/@ana',
    title: 'Varanda'
  })
  t.is(shared, 'shared')
  t.alike(calls, [{ title: 'Varanda', url: 'https://varanda.example/@ana' }])

  const abort = new Error('closed')
  abort.name = 'AbortError'
  t.is(await shareUrl({ share: () => Promise.reject(abort) }, { url: 'u', title: 't' }), 'cancelled')
  t.is(await shareUrl({ share: () => Promise.reject(new Error('broken')) }, { url: 'u', title: 't' }), 'failed')
  t.is(await shareUrl({ share: () => { throw new Error('broken') } }, { url: 'u', title: 't' }), 'failed')
})

test('canShare detects navigator share support', async (t) => {
  const { canShare } = await load()
  t.ok(canShare({ share: () => {} }))
  t.absent(canShare({}))
  t.absent(canShare(null))
})

test('visibleUrl only paints named profile URLs', async (t) => {
  const { visibleUrl } = await load()
  t.is(visibleUrl('https://varanda.example/@ana'), 'https://varanda.example/@ana')
  t.is(visibleUrl('https://varanda.example/m/' + 'ab'.repeat(32)), null)
  t.is(visibleUrl('not a URL'), null)
  t.is(visibleUrl(42), null)
})

test('native share shape shares, cancels, fails, and cannot copy', async (t) => {
  const { canShare, copyText, shareUrl } = await load()
  let next = () => Promise.resolve()
  const fake = { share: () => next() }

  t.ok(canShare(fake))
  t.is(await copyText(fake, 'x'), false)
  t.is(await shareUrl(fake, { url: 'https://varanda.example/@ana', title: 'Varanda' }), 'shared')

  const abort = new Error('closed')
  abort.name = 'AbortError'
  next = () => Promise.reject(abort)
  t.is(await shareUrl(fake, { url: 'u', title: 't' }), 'cancelled')

  next = () => Promise.reject(new Error('broken'))
  t.is(await shareUrl(fake, { url: 'u', title: 't' }), 'failed')
})
