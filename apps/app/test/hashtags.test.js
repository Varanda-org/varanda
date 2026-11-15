'use strict'

const test = require('brittle')
const load = () => import('../src/hashtags.js')

test('plain tags fold to lower case', async (t) => {
  const { tagsOf } = await load()
  t.alike(tagsOf('oi #Varanda e #p2p'), ['varanda', 'p2p'])
  t.alike(tagsOf('#a1'), ['a1'])
})

test('accents fold away, composed or decomposed', async (t) => {
  const { tagsOf, findTags } = await load()
  t.alike(tagsOf('#Céu'), ['ceu'])
  t.alike(tagsOf('#Céu'), ['ceu'])
  t.alike(findTags('x #Céu'), [{ start: 2, end: 6, tag: 'ceu' }])
})

test('a tag is not a URL fragment', async (t) => {
  const { tagsOf } = await load()
  t.alike(tagsOf('https://x.com/a#frag'), [])
  t.alike(tagsOf('https://x.com/#frag'), [])
  t.alike(tagsOf('veja (https://x.com/?q=1#frag) #ok'), ['ok'])
  t.alike(tagsOf('www.x.com/#frag'), [])
})

test('too short, too long and non-latin runs are not tags', async (t) => {
  const { tagsOf } = await load()
  t.alike(tagsOf('#1 #a #'), [])
  t.alike(tagsOf('#' + 'a'.repeat(32)), ['a'.repeat(32)])
  t.alike(tagsOf('#' + 'a'.repeat(33)), [])
  t.alike(tagsOf('#日本'), [])
})

test('a tag needs a non-word character before it', async (t) => {
  const { tagsOf } = await load()
  t.alike(tagsOf('abc#tag'), [])
  t.alike(tagsOf('(#tag) "#dois", #tres! ¡#quatro'), ['tag', 'dois', 'tres', 'quatro'])
  t.alike(tagsOf('#um\n#dois'), ['um', 'dois'])
})

test('adjacent hashes: only the first tag counts', async (t) => {
  const { tagsOf } = await load()
  t.alike(tagsOf('#a1#b2'), ['a1'])
  t.alike(tagsOf('##tag'), [])
})

test('repeats collapse and hasTag folds the token', async (t) => {
  const { tagsOf, hasTag } = await load()
  t.alike(tagsOf('#Ceu #ceu'), ['ceu'])
  t.ok(hasTag('olá #Céu', 'ceu'))
  t.ok(hasTag('olá #ceu', 'CÉU'))
  t.absent(hasTag('olá #ceux', 'ceu'))
  t.absent(hasTag('olá', 'ceu'))
  t.absent(hasTag('x', 5))
})

test('non-string input gives nothing', async (t) => {
  const { tagsOf } = await load()
  t.alike(tagsOf(null), [])
  t.alike(tagsOf(undefined), [])
})

test('a # after a / in the same token is an address fragment, not a tag', async (t) => {
  const { tagsOf, hasTag } = await load()
  const { textSegments } = await import('../src/links.js')
  t.alike(tagsOf('exemplo.com/#secao'), [])
  t.alike(tagsOf('veja /#topo e a/ #ok'), ['ok'])
  t.absent(hasTag('exemplo.com/#secao', 'secao'))
  t.absent(textSegments('exemplo.com/#secao', { hashtags: true }).some((s) => s.tag !== null), 'textSegments agrees')
})

test('the Kelvin and Angstrom signs are word code points, as the index folds them', async (t) => {
  const { tagsOf } = await load()
  t.alike(tagsOf('#Kelvin'), ['kelvin'])
  t.alike(tagsOf('#Ångstrom'), ['angstrom'])
  t.alike(tagsOf('abK#tag'), [], 'a sign before the # is a word character')
})

test('no tag flush after an email, a mention or a word; emoji around a tag do not matter', async (t) => {
  const { tagsOf } = await load()
  t.alike(tagsOf('a@b#cd'), [])
  t.alike(tagsOf('@ana#cd'), [])
  t.alike(tagsOf('\u{1F600}#tag e #dois\u{1F600}'), ['tag', 'dois'])
  t.alike(tagsOf('\u{1D400}#tag'), ['tag'], 'an astral symbol before the # is not a word character')
})
