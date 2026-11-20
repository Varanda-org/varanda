'use strict'

const test = require('brittle')
const rpc = require('..')
const { YOUTUBE_COVER_HOST, youtubeCoverUrl } = require('../lib/music-cover')

const ID = 'dQw4w9WgXcQ'
const COVER = 'https://i.ytimg.com/vi/' + ID + '/mqdefault.jpg'

test('music-cover: exported from @varanda/rpc', (t) => {
  t.is(rpc.youtubeCoverUrl, youtubeCoverUrl)
  t.is(rpc.YOUTUBE_COVER_HOST, YOUTUBE_COVER_HOST)
  t.is(YOUTUBE_COVER_HOST, 'i.ytimg.com')
})

test('music-cover: the canonical watch pages musicEmbed builds give the thumbnail', (t) => {
  const accepted = [
    'https://www.youtube.com/watch?v=' + ID,
    'https://music.youtube.com/watch?v=' + ID,
    'https://www.youtube.com/watch?v=' + ID + '&t=1s',
    'https://www.youtube.com/watch?v=' + ID + '&t=90s',
    'https://music.youtube.com/watch?v=' + ID + '&t=86400s'
  ]
  for (const url of accepted) t.is(youtubeCoverUrl(url), COVER, url)
  t.is(youtubeCoverUrl('https://www.youtube.com/watch?v=a-b_c1D2e3F'), 'https://i.ytimg.com/vi/a-b_c1D2e3F/mqdefault.jpg', '- and _ in the id')
})

test('music-cover: anything else gives null', (t) => {
  const refused = [
    ['youtu.be', 'https://youtu.be/' + ID],
    ['m.youtube.com', 'https://m.youtube.com/watch?v=' + ID],
    ['bare youtube.com', 'https://youtube.com/watch?v=' + ID],
    ['shorts path', 'https://www.youtube.com/shorts/' + ID],
    ['embed path', 'https://www.youtube.com/embed/' + ID],
    ['playlist', 'https://www.youtube.com/playlist?list=PLabcdefghij'],
    ['&list=', 'https://www.youtube.com/watch?v=' + ID + '&list=PLabcdefghij'],
    ['extra param', 'https://www.youtube.com/watch?v=' + ID + '&feature=share'],
    ['param before v', 'https://www.youtube.com/watch?feature=share&v=' + ID],
    ['10 char id', 'https://www.youtube.com/watch?v=' + ID.slice(0, 10)],
    ['12 char id', 'https://www.youtube.com/watch?v=' + ID + 'x'],
    ['bad id char', 'https://www.youtube.com/watch?v=dQw4w9WgXc.'],
    ['http', 'http://www.youtube.com/watch?v=' + ID],
    ['uppercase scheme', 'HTTPS://www.youtube.com/watch?v=' + ID],
    ['uppercase host', 'https://WWW.YOUTUBE.COM/watch?v=' + ID],
    ['trailing junk', 'https://www.youtube.com/watch?v=' + ID + '/x'],
    ['trailing fragment', 'https://www.youtube.com/watch?v=' + ID + '#t=5'],
    ['trailing newline', 'https://www.youtube.com/watch?v=' + ID + '\n'],
    ['leading space', ' https://www.youtube.com/watch?v=' + ID],
    ['userinfo', 'https://x@www.youtube.com/watch?v=' + ID],
    ['port', 'https://www.youtube.com:443/watch?v=' + ID],
    ['look-alike host', 'https://www.youtube.com.evil.example/watch?v=' + ID],
    ['t of 0', 'https://www.youtube.com/watch?v=' + ID + '&t=0s'],
    ['t with leading zero', 'https://www.youtube.com/watch?v=' + ID + '&t=05s'],
    ['t without s', 'https://www.youtube.com/watch?v=' + ID + '&t=90'],
    ['t of 6 digits', 'https://www.youtube.com/watch?v=' + ID + '&t=100000s'],
    ['t one past the 86400 s limit', 'https://www.youtube.com/watch?v=' + ID + '&t=86401s'],
    ['t of 5 digits past the limit', 'https://www.youtube.com/watch?v=' + ID + '&t=99999s'],
    ['t as 1m30s', 'https://www.youtube.com/watch?v=' + ID + '&t=1m30s'],
    ['empty string', '']
  ]
  for (const [name, url] of refused) t.is(youtubeCoverUrl(url), null, name)
})

test('music-cover: non-strings give null and never throw', (t) => {
  for (const v of [undefined, null, 0, 1, true, {}, [], ['https://www.youtube.com/watch?v=' + ID], { toString: () => 'https://www.youtube.com/watch?v=' + ID }]) {
    t.is(youtubeCoverUrl(v), null)
  }
})

test('music-cover: only the id is carried into the cover address', (t) => {
  const cover = youtubeCoverUrl('https://music.youtube.com/watch?v=' + ID + '&t=123s')
  t.is(cover, COVER)
  t.absent(cover.includes('music'))
  t.absent(cover.includes('123'))
})
