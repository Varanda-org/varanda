'use strict'

// Pure GIF client helpers (src/gif.js). ES module loaded through import().
const test = require('brittle')

const load = () => import('../src/gif.js')
const item = { id: 'abc_DEF-1', width: 200, height: 100, bytes: 5000 }

test('searchBody: { q } or { q, cursor }, trimmed and bounded', async (t) => {
  const g = await load()
  t.absent('searchUrl' in g, 'no search URL: the text never rides in a query string')
  const { searchBody } = g
  t.alike(searchBody(' gato & cão '), { q: 'gato & cão' })
  t.alike(searchBody('a', 'x/y?z'), { q: 'a', cursor: 'x/y?z' })
  t.alike(searchBody('a', ''), { q: 'a' })
  t.alike(searchBody('a', null), { q: 'a' })
  t.is(searchBody(''), null)
  t.is(searchBody('   '), null)
  t.is(searchBody('a'.repeat(65)), null)
  t.ok(searchBody('😀'.repeat(64)))
  t.is(searchBody('😀'.repeat(65)), null)
  t.is(searchBody(5), null)
  t.is(searchBody('a', 'c'.repeat(513)), null)
  t.is(searchBody('a', 5), null)
})

test('gifOriginOf: GIF only on a hosted node, by capability', async (t) => {
  const { gifOriginOf } = await load()
  t.is(gifOriginOf({ hosted: true }), undefined, 'the installation account service')
  t.is(gifOriginOf({ hosted: true, accountOrigin: 'https://conta.example.org' }), undefined)
  t.is(gifOriginOf({ hosted: false, accountOrigin: 'https://conta.example.org' }), null, 'no invite.sign without a hosted node')
  t.is(gifOriginOf({ accountOrigin: 'https://conta.example.org' }), null)
  t.is(gifOriginOf({ hosted: 'true' }), null)
  t.is(gifOriginOf({}), null)
  t.is(gifOriginOf(null), null)
  t.is(gifOriginOf(undefined), null)
})

test('imageUrl: only a safe id and a known size', async (t) => {
  const { imageUrl } = await load()
  t.is(imageUrl('', 'abc_DEF-1', 'tiny'), '/account/gif/image/abc_DEF-1?size=tiny')
  t.is(imageUrl('https://conta.example.org', 'a1', 'full'), 'https://conta.example.org/account/gif/image/a1?size=full')
  for (const id of ['', 'a/b', '../x', 'a.b', 'https://evil.example/x', 'a'.repeat(65), 5, null]) t.is(imageUrl('', id, 'tiny'), null, String(id))
  t.is(imageUrl('', 'a1', 'huge'), null)
  t.is(imageUrl('', 'a1'), null)
  t.is(imageUrl('ftp://x', 'a1', 'tiny'), null)
})

test('parseSearch: the exact shape or null', async (t) => {
  const { parseSearch } = await load()
  t.alike(parseSearch({ items: [item], next: 'c1' }), { items: [item], next: 'c1' })
  t.alike(parseSearch({ items: [], next: null }), { items: [], next: null })
  t.ok(parseSearch({ items: Array.from({ length: 50 }, () => item), next: null }))
  t.is(parseSearch({ items: Array.from({ length: 51 }, () => item), next: null }), null)
  const bad = [
    null, [], 'x', {}, { items: [] }, { items: [], next: undefined }, { items: [], next: null, x: 1 },
    { items: {}, next: null }, { items: [], next: 5 }, { items: [], next: '' },
    { items: [], next: 'https://evil.example/x' },
    { items: [{ ...item, url: 'https://evil.example/a.gif' }], next: null },
    { items: [{ id: item.id, width: 1, height: 1 }], next: null },
    { items: [{ ...item, id: 'https://evil.example/a' }], next: null },
    { items: [{ ...item, id: 'a/b' }], next: null },
    { items: [{ ...item, id: '' }], next: null },
    { items: [{ ...item, width: 0 }], next: null },
    { items: [{ ...item, width: 4097 }], next: null },
    { items: [{ ...item, height: 4097 }], next: null },
    { items: [{ ...item, height: 1.5 }], next: null },
    { items: [{ ...item, bytes: 0 }], next: null },
    { items: [{ ...item, bytes: 8388609 }], next: null },
    { items: [{ ...item, bytes: '5' }], next: null },
    { items: [null], next: null }
  ]
  for (const b of bad) t.is(parseSearch(b), null, JSON.stringify(b))
  t.ok(parseSearch({ items: [{ ...item, width: 4096, height: 4096, bytes: 8388608 }], next: null }))
})
