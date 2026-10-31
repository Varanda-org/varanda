'use strict'

// The group-link helpers (src/groupLink.js), loaded through import().
const test = require('brittle')

const load = () => import('../src/groupLink.js')
const A = 'ab'.repeat(32)

test('parseGroupPath accepts a lowercase hex64 with or without a trailing slash', async (t) => {
  const { parseGroupPath } = await load()
  t.is(parseGroupPath('/g/' + A), A)
  t.is(parseGroupPath('/g/' + A + '/'), A)
})

test('parseGroupPath refuses uppercase, wrong length and extra segments', async (t) => {
  const { parseGroupPath } = await load()
  t.is(parseGroupPath('/g/' + A.toUpperCase()), null)
  t.is(parseGroupPath('/g/' + A.slice(1)), null)
  t.is(parseGroupPath('/g/' + A + 'a'), null)
  t.is(parseGroupPath('/g/' + A + '/x'), null)
  t.is(parseGroupPath('/g/' + A + '?x=1'), null)
  t.is(parseGroupPath('/g//' + A), null)
  t.is(parseGroupPath('/m/' + A), null)
  t.is(parseGroupPath('/g/' + 'zz'.repeat(32)), null)
  t.is(parseGroupPath(null), null)
  t.is(parseGroupPath('/g/' + A + ' '), null)
})

test('isGroupPath is a prefix test', async (t) => {
  const { isGroupPath } = await load()
  t.ok(isGroupPath('/g/anything'))
  t.absent(isGroupPath('/m/' + A))
  t.absent(isGroupPath('/'))
  t.absent(isGroupPath(undefined))
})

function fake (pathname, search = '', hash = '') {
  const calls = []
  return {
    location: { pathname, search, hash },
    history: { state: { idx: 1 }, replaceState (s, title, url) { calls.push({ s, url }) } },
    calls
  }
}

test('captureGroupLink returns the key and cleans the path, keeping search and hash', async (t) => {
  const { captureGroupLink } = await load()
  const f = fake('/g/' + A, '?conta=1', '#token=x')
  t.is(captureGroupLink(f), A)
  t.is(f.calls.length, 1)
  t.is(f.calls[0].url, '/?conta=1#token=x')
  t.alike(f.calls[0].s, { idx: 1 })
})

test('captureGroupLink cleans an invalid group path and returns null', async (t) => {
  const { captureGroupLink } = await load()
  const f = fake('/g/' + A.toUpperCase())
  t.is(captureGroupLink(f), null)
  t.is(f.calls.length, 1)
  t.is(f.calls[0].url, '/')
})

test('captureGroupLink leaves other paths alone and survives a broken history', async (t) => {
  const { captureGroupLink } = await load()
  const f = fake('/m/' + A)
  t.is(captureGroupLink(f), null)
  t.is(f.calls.length, 0)
  t.is(captureGroupLink(), null)
  const g = fake('/g/' + A)
  g.history.replaceState = () => { throw new Error('denied') }
  t.is(captureGroupLink(g), A)
})
