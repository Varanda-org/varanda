'use strict'

const test = require('brittle')

const load = () => import('../src/embedCover.js')

test('embedCover: coverLayout for the player heights', async (t) => {
  const { coverLayout } = await load()
  t.alike(coverLayout('spotify', 360, 152), { kind: 'row', art: 128 }, 'Spotify track 152')
  t.alike(coverLayout('soundcloud', 360, 166), { kind: 'row', art: 142 }, 'SoundCloud track 166')
  t.alike(coverLayout('apple', 360, 175), { kind: 'row', art: 151 }, 'Apple song 175')
  t.alike(coverLayout('spotify', 360, 352), { kind: 'stack', art: 240 }, 'Spotify album 352: height bound')
  t.alike(coverLayout('soundcloud', 200, 352), { kind: 'stack', art: 176 }, 'SoundCloud set 352: width bound')
  t.alike(coverLayout('apple', 360, 450), { kind: 'stack', art: 336 }, 'Apple album 450: width bound')
  t.alike(coverLayout('apple', 500, 450), { kind: 'stack', art: 338 }, 'Apple album 450: height bound')
  t.alike(coverLayout('youtube', 360, 203), { kind: 'full', art: 0 }, 'YouTube 16:9 slot')
  t.alike(coverLayout('youtube', 200, 200), { kind: 'full', art: 0 }, 'YouTube floor slot')
})

test('embedCover: coverLayout edges', async (t) => {
  const { coverLayout } = await load()
  t.alike(coverLayout('spotify', 360, 200), { kind: 'row', art: 176 }, '200 is still a row')
  t.alike(coverLayout('spotify', 360, 201), { kind: 'stack', art: 89 }, '201 is a stack')
  t.alike(coverLayout('spotify', 360, 10), { kind: 'row', art: 0 }, 'row art never negative')
  t.alike(coverLayout('spotify', 10, 352), { kind: 'stack', art: 0 }, 'stack art never negative')
  t.alike(coverLayout('spotify', 360.9, 152.7), { kind: 'row', art: 128 }, 'row art rounded down')
  t.alike(coverLayout('spotify', 300.5, 450), { kind: 'stack', art: 276 }, 'stack art rounded down')
  for (const [w, h] of [[0, 152], [360, 0], [-1, 152], [360, -5], [NaN, 152], [360, Infinity], ['360', 152], [360, null], [undefined, undefined]]) {
    t.alike(coverLayout('spotify', w, h), { kind: 'full', art: 0 }, String(w) + 'x' + String(h) + ': full')
  }
})

test('embedCover: coverSource follows LinkCard', async (t) => {
  const { coverSource } = await load()
  const image = { id: 'x' }
  t.alike(coverSource({ draft: { url: 'u' }, imageUri: 'blob:abc' }), { kind: 'uri', uri: 'blob:abc' }, 'draft with a URI')
  t.alike(coverSource({ draft: { url: 'u' }, imageUri: '' }), { kind: 'none' }, 'draft with an empty URI')
  t.alike(coverSource({ draft: { url: 'u' }, imageUri: 42 }), { kind: 'none' }, 'draft with a non-string URI')
  t.alike(coverSource({ draft: { url: 'u' }, card: { image }, thumb: { kind: 'post', author: 'a' } }), { kind: 'none' }, 'a draft never reads the stored card')
  t.alike(coverSource({ card: { image }, thumb: { kind: 'post', author: 'a' } }), { kind: 'post', author: 'a', descriptor: image, persist: true }, 'post')
  t.is(coverSource({ card: { image }, thumb: { kind: 'post', author: 'a' } }).descriptor, image, 'descriptor is card.image')
  t.alike(coverSource({ card: { image }, thumb: { kind: 'post', author: 'a', persist: false } }), { kind: 'post', author: 'a', descriptor: image, persist: false }, 'post, persist false')
  t.alike(coverSource({ card: { image }, thumb: { kind: 'post', author: 'a', persist: 0 } }).persist, true, 'only false turns persist off')
  t.alike(coverSource({ card: { image }, thumb: { kind: 'post', author: 7 } }), { kind: 'none' }, 'post without a string author')
  t.alike(coverSource({ card: {}, thumb: { kind: 'post', author: 'a' } }), { kind: 'none' }, 'post without an image')
  t.alike(coverSource({ card: { image: 'x' }, thumb: { kind: 'post', author: 'a' } }), { kind: 'none' }, 'post with a non-object image')
  t.alike(coverSource({ card: { image }, thumb: { kind: 'dm', from: 'f', id: 1 } }), { kind: 'chat' }, 'dm')
  t.alike(coverSource({ card: { image }, thumb: { kind: 'group', diary: 'd' } }), { kind: 'chat' }, 'group')
  t.alike(coverSource({ card: {}, thumb: { kind: 'dm' } }), { kind: 'none' }, 'dm without an image')
  t.alike(coverSource({ card: { image }, thumb: { kind: 'other' } }), { kind: 'none' }, 'unknown thumb kind')
  t.alike(coverSource({ card: { image } }), { kind: 'none' }, 'no thumb')
  t.alike(coverSource({}), { kind: 'none' }, 'nothing')
  for (const bad of [null, undefined, 'x', 5]) {
    t.execution(() => coverSource(bad), String(bad) + ': no throw')
    t.alike(coverSource(bad), { kind: 'none' }, String(bad) + ': none')
  }
})

test('embedCover: coverLabel', async (t) => {
  const { coverLabel } = await load()
  t.is(coverLabel('Spotify', 'Uma Canção'), 'Player do Spotify carregando: Uma Canção', 'name and title')
  t.is(coverLabel('YouTube', ''), 'Player do YouTube carregando', 'name, empty title')
  t.is(coverLabel('Apple Music'), 'Player do Apple Music carregando', 'name, no title')
  t.is(coverLabel('', 'Uma Canção'), 'Player carregando: Uma Canção', 'empty name, title')
  t.is(coverLabel(undefined, 'Uma Canção'), 'Player carregando: Uma Canção', 'no name, title')
  t.is(coverLabel(null), 'Player carregando', 'no name, no title')
  t.is(coverLabel(42, null), 'Player carregando', 'non-string name')
  t.absent(/\u2014/.test(coverLabel('Spotify', 'x')), 'no em dash')
})

test('embedCover: revealMs', async (t) => {
  const { revealMs } = await load()
  t.is(revealMs(true, 180), 0, 'reduced motion: instant')
  t.is(revealMs(false, 180), 180, 'otherwise the fast duration')
})

test('embedCover: coverLingers truth table', async (t) => {
  const { coverLingers } = await load()
  for (const standIn of [false, true]) {
    for (const live of [false, true]) {
      for (const ready of [false, true]) {
        for (const settled of [false, true]) {
          const want = !standIn && live && ready && !settled
          t.is(coverLingers(standIn, live, ready, settled), want, [standIn, live, ready, settled].join(','))
        }
      }
    }
  }
  t.is(coverLingers(false, 1, true, false), false, 'live must be true, not truthy')
  t.is(coverLingers(false, true, 'yes', false), false, 'ready must be true, not truthy')
  t.is(coverLingers(false, true, true, 1), true, 'settled must be true to end it')
  t.is(coverLingers(undefined, true, true, undefined), true, 'missing standIn and settled')
})
