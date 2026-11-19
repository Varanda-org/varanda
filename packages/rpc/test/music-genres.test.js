'use strict'

const test = require('brittle')
const rpc = require('..')
const { MUSIC_GENRES, isMusicGenre } = require('../lib/music-genres')

const EXPECTED = [
  'Pop', 'Hip-Hop/Rap', 'Rock', 'Electronic', 'R&B/Soul', 'Latin', 'Funk', 'Reggae',
  'Jazz', 'Alternative', 'Indie', 'Metal', 'Folk', 'Acoustic', 'Classical', 'Lo-Fi',
  'House', 'Techno', 'Trance', 'Dubstep', 'Drum & Bass', 'Trap', 'Deep House', 'Tech House'
]

test('music-genres: exported from @varanda/rpc', (t) => {
  t.is(rpc.MUSIC_GENRES, MUSIC_GENRES)
  t.is(rpc.isMusicGenre, isMusicGenre)
})

test('music-genres: the exact 24 names in display order, frozen and unique', (t) => {
  t.alike(Array.from(MUSIC_GENRES), EXPECTED)
  t.is(MUSIC_GENRES.length, 24)
  t.ok(Object.isFrozen(MUSIC_GENRES))
  t.is(new Set(MUSIC_GENRES).size, MUSIC_GENRES.length)
  let threw = false
  try { MUSIC_GENRES.push('Samba') } catch { threw = true }
  t.ok(threw, 'push refused')
  t.is(MUSIC_GENRES.length, 24)
})

test('music-genres: every name is plain, short and has no comma', (t) => {
  for (const name of MUSIC_GENRES) {
    t.is(typeof name, 'string', name)
    t.absent(name.includes(','), 'no comma: ' + name)
    t.absent(Array.from(name).some((c) => { const n = c.codePointAt(0); return n < 0x20 || (n >= 0x7f && n <= 0x9f) }), 'no control character: ' + name)
    t.is(name, name.trim(), 'no leading or trailing space: ' + name)
    t.ok(name.length > 0 && Array.from(name).length <= 40, 'at most 40 code points: ' + name)
  }
})

test('music-genres: the left out names stay out, whatever their case', (t) => {
  const lower = MUSIC_GENRES.map((n) => n.toLowerCase())
  for (const name of ['Devotional', 'Kids', 'Podcasts', 'Audiobooks', 'Spoken Word', 'Comedy']) {
    t.absent(MUSIC_GENRES.includes(name), name)
    t.absent(lower.includes(name.toLowerCase()), name.toLowerCase())
  }
})

test('music-genres: the electronic sub-genres are entries of their own', (t) => {
  for (const name of ['Electronic', 'House', 'Techno', 'Trance', 'Dubstep', 'Drum & Bass', 'Trap', 'Deep House', 'Tech House']) {
    t.ok(isMusicGenre(name), name)
  }
})

test('music-genres: isMusicGenre is exact and case-sensitive', (t) => {
  for (const name of MUSIC_GENRES) t.ok(isMusicGenre(name), name)
  t.ok(isMusicGenre('Drum & Bass'))
  t.ok(isMusicGenre('Deep House'))
  t.ok(isMusicGenre('Hip-Hop/Rap'))
  t.ok(isMusicGenre('R&B/Soul'))
  for (const v of ['pop', 'POP', ' Pop', 'Pop ', 'Samba', 'Instrumental', 'Techno, Tech House', 'Techno,Tech House', 'Drum &amp; Bass', '']) {
    t.absent(isMusicGenre(v), JSON.stringify(v))
  }
})

test('music-genres: isMusicGenre never throws and refuses a non-string', (t) => {
  const evil = { toString () { return 'Pop' } }
  for (const v of [7, null, undefined, true, ['Pop'], { name: 'Pop' }, evil, Symbol('Pop'), () => 'Pop']) {
    t.is(isMusicGenre(v), false)
  }
})
