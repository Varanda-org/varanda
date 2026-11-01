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

test('parseCommunityPath accepts only a strict lowercase /c/<hex64>', async (t) => {
  const { parseCommunityPath, isCommunityPath, communityLink } = await load()
  t.is(parseCommunityPath('/c/' + A), A)
  t.is(parseCommunityPath('/c/' + A + '/'), A)
  t.is(parseCommunityPath('/c/' + A.toUpperCase()), null)
  t.is(parseCommunityPath('/c/' + A.slice(1)), null)
  t.is(parseCommunityPath('/c/' + A + 'a'), null)
  t.is(parseCommunityPath('/c/' + A + '/x'), null)
  t.is(parseCommunityPath('/c/' + A + '?x=1'), null)
  t.is(parseCommunityPath(null), null)
  t.ok(isCommunityPath('/c/anything'))
  t.absent(isCommunityPath('/g/' + A))
  t.is(communityLink(A.toUpperCase()), '/c/' + A)
  t.is(communityLink('nope'), null)
})

test('captureCommunityLink returns the key, cleans the path and keeps search and hash', async (t) => {
  const { captureCommunityLink } = await load()
  const f = fake('/c/' + A, '?conta=1', '#token=x')
  t.is(captureCommunityLink(f), A)
  t.is(f.calls.length, 1)
  t.is(f.calls[0].url, '/?conta=1#token=x')
  const bad = fake('/c/' + A.toUpperCase())
  t.is(captureCommunityLink(bad), null)
  t.is(bad.calls[0].url, '/')
  const other = fake('/m/' + A)
  t.is(captureCommunityLink(other), null)
  t.is(other.calls.length, 0)
})

test('group and community links never mix', async (t) => {
  const { parseGroupPath, parseCommunityPath, captureGroupLink, captureCommunityLink } = await load()
  t.is(parseGroupPath('/c/' + A), null)
  t.is(parseCommunityPath('/g/' + A), null)
  const g = fake('/g/' + A)
  t.is(captureCommunityLink(g), null)
  t.is(g.calls.length, 0)
  const c = fake('/c/' + A)
  t.is(captureGroupLink(c), null)
  t.is(c.calls.length, 0)
})
