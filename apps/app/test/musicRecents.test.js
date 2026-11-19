'use strict'

// Recent music picks (src/musicRecents.js and the web store). ES modules
// loaded through import(); read, write and remove are in-memory fakes.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { MUSIC_GENRES } = require('@varanda/rpc')

const load = () => import('../src/musicRecents.js')
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const owner = (i) => i.toString(16).padStart(64, '0')
const page = (i) => 'https://audius.co/artista/faixa-' + i
const track = (i, genre) => {
  const t = { id: 'T' + i, title: 'Faixa ' + i, artist: 'Artista', duration: 200, url: page(i), cover: true, year: 2020 }
  if (genre !== undefined) t.genre = genre
  return t
}
const playlist = (i) => ({ id: 'T' + i, title: 'Lista ' + i, artist: 'Artista', count: 12, url: 'https://audius.co/artista/playlist/lista-' + i, cover: false })
const kept = (i, genre) => {
  const e = { kind: 'track', id: 'T' + i, title: 'Faixa ' + i, artist: 'Artista', url: page(i) }
  if (genre !== undefined) e.genre = genre
  return e
}

function disk (initial = null) {
  const d = { raw: initial, writes: 0, removes: 0 }
  d.read = () => d.raw
  d.write = (raw) => { d.writes++; d.raw = raw }
  d.remove = () => { d.removes++; d.raw = null }
  return d
}

test('constants', async (t) => {
  const s = await load()
  t.is(s.STORAGE_KEY, 'varanda-music-recents')
  t.is(s.FILE_NAME, 'varanda-music-recents.json')
  t.is(s.MAX_RECENTS, 24)
  t.is(s.MAX_OWNERS, 4)
  t.is(s.MUSIC_RECENTS_SHOWN, 5)
  t.is(s.MUSIC_GENRE_MIN, 1)
  t.is(s.MAX_RAW, 262144)
})

test('note keeps only the listed keys and the canonical genre, newest first', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createMusicRecents(d)
  t.alike(store.list(A), [])
  t.ok(store.note(A, 'track', track(1, 'Techno, Tech House, Melodic')))
  t.ok(store.note(A, 'playlist', playlist(2)))
  t.ok(store.note(A, 'track', track(3, 'Samba')))
  const list = store.list(A)
  t.alike(list, [kept(3), { kind: 'playlist', id: 'T2', title: 'Lista 2', artist: 'Artista', count: 12, url: 'https://audius.co/artista/playlist/lista-2' }, kept(1, 'Techno')])
  for (const it of list) {
    for (const key of ['duration', 'year', 'cover', 'start', 'tracks']) t.absent(Object.hasOwn(it, key), it.id + ' ' + key)
  }
  t.absent(d.raw.includes('Tech House') || d.raw.includes('Samba'), 'the provider text is never kept')
  list[0].title = 'changed'
  t.is(store.list(A)[0].title, 'Faixa 3', 'list gives a copy')
  t.is(d.writes, 3)
})

test('a snippet is its track, a playlist of the same id is another entry', async (t) => {
  const s = await load()
  const store = s.createMusicRecents(disk())
  t.ok(store.note(A, 'snippet', { ...track(1, 'Pop'), start: 30 }))
  t.ok(store.note(A, 'track', track(1, 'Pop')))
  t.ok(store.note(A, 'playlist', playlist(1)))
  const list = store.list(A)
  t.alike(list.map((it) => it.kind + ':' + it.id), ['playlist:T1', 'track:T1'])
  t.alike(list[1], kept(1, 'Pop'))
})

test('re-noting moves to the front without growing or counting twice', async (t) => {
  const s = await load()
  const store = s.createMusicRecents(disk())
  store.note(A, 'track', track(1, 'Pop'))
  store.note(A, 'track', track(2, 'Rock'))
  store.note(A, 'track', track(1, 'Pop'))
  store.note(A, 'track', track(1, 'Pop'))
  const list = store.list(A)
  t.alike(list.map((it) => it.id), ['T1', 'T2'])
  t.is(s.musicGenreCounts(list).get('Pop'), 1)
  t.is(s.musicTopGenre(list), 'Pop', 'a tie goes to the most recent')
})

test('the 25th pick pushes the oldest out, the 5th owner the least recently used', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createMusicRecents(d)
  for (let i = 1; i <= 25; i++) store.note(A, 'track', track(i))
  const list = store.list(A)
  t.is(list.length, 24)
  t.is(list[0].id, 'T25')
  t.absent(list.some((it) => it.id === 'T1'), 'the oldest is gone')
  for (let i = 1; i <= 4; i++) store.note(owner(i), 'track', track(i))
  store.note(owner(1), 'track', track(9))
  store.note(owner(5), 'track', track(5))
  const owners = JSON.parse(d.raw).owners.map((o) => o.owner)
  t.alike(owners, [owner(5), owner(1), owner(4), owner(3)], 'A and then owner 2 were the least recently used')
  t.alike(store.list(owner(2)), [])
  t.alike(store.list(owner(1)).map((it) => it.id), ['T9', 'T1'])
})

test('each owner sees only its own picks; clearOwner leaves the others', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createMusicRecents(d)
  store.note(A, 'track', track(1, 'Pop'))
  store.note(B, 'track', track(2, 'Rock'))
  t.alike(store.list(A), [kept(1, 'Pop')])
  t.alike(store.list(B), [kept(2, 'Rock')])
  for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), null, 7]) {
    t.alike(store.list(bad), [], 'list ' + JSON.stringify(bad))
    t.is(store.note(bad, 'track', track(3)), false, 'note ' + JSON.stringify(bad))
    t.is(store.clearOwner(bad), false, 'clearOwner ' + JSON.stringify(bad))
  }
  t.is(store.note(A, 'album', track(3)), false)
  t.is(store.note(A, 'track', null), false)
  t.is(store.note(A, 'track', { ...track(3), url: 'https://evil.example/a/b' }), false)
  t.ok(store.clearOwner(A))
  t.alike(store.list(A), [])
  t.alike(store.list(B), [kept(2, 'Rock')])
  const failing = s.createMusicRecents({ read: d.read, write: () => { throw new Error('quota') }, remove: d.remove })
  t.is(failing.clearOwner(B), false, 'a refused write is reported')
  t.alike(store.list(B), [kept(2, 'Rock')], 'storage unchanged')
})

test('clear empties the storage', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createMusicRecents(d)
  store.note(A, 'track', track(1))
  store.note(B, 'track', track(2))
  t.ok(store.clear())
  t.is(d.raw, null)
  t.is(d.removes, 1)
  t.alike(store.list(A), [])
  t.alike(store.list(B), [])
})

test('a throwing read or write never throws out, and a read that threw is not written over', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createMusicRecents(d)
  store.note(A, 'track', track(1))
  const before = d.raw
  let broken = true
  const flaky = s.createMusicRecents({
    read: () => { if (broken) throw new Error('denied'); return d.raw },
    write: d.write,
    remove: () => { throw new Error('denied') }
  })
  t.is(flaky.note(A, 'track', track(2)), false, 'nothing written after a failed read')
  t.is(d.raw, before, 'storage kept')
  t.alike(flaky.list(A).map((it) => it.id), ['T2'], 'this run still shows the pick')
  t.is(flaky.clearOwner(A), false)
  t.is(d.raw, before)
  t.is(flaky.clear(), false, 'a refused remove is reported')
  broken = false
  t.alike(flaky.list(A).map((it) => it.id), ['T1'], 'the next good read wins')
  const dead = s.createMusicRecents({
    read: () => { throw new Error('denied') },
    write: () => { throw new Error('denied') },
    remove: () => { throw new Error('denied') }
  })
  t.alike(dead.list(A), [])
  t.is(dead.note(A, 'track', track(1)), false)
  t.is(dead.clearOwner(A), false)
  t.is(dead.clear(), false)
  const refused = s.createMusicRecents({ read: () => null, write: () => { throw new Error('quota') }, remove: () => {} })
  t.is(refused.note(A, 'track', track(1)), false, 'a refused write is reported')
  const corrupt = disk('{not json')
  t.ok(s.createMusicRecents(corrupt).note(A, 'track', track(1)), 'a corrupt file is empty and may be written')
  t.alike(JSON.parse(corrupt.raw).owners[0].items, [kept(1)])
})

test('decode rebuilds an untrusted file field by field', async (t) => {
  const s = await load()
  const raw = (owners) => JSON.stringify({ v: 1, owners })
  const good = { kind: 'track', id: 'T1', title: 'Faixa 1', artist: 'Artista', url: page(1), genre: 'Pop' }
  const list = { kind: 'playlist', id: 'T2', title: 'Lista', artist: 'Artista', count: 3, url: 'https://audius.co/artista/playlist/lista' }
  t.alike(s.decodeRecents(raw([{ owner: A, items: [good, list] }])), [{ owner: A, items: [good, list] }])
  const items = [
    { ...good, kind: 'snippet' },
    { ...good, kind: 'album' },
    { ...good, id: 'a-b' },
    { ...good, id: '' },
    { ...good, title: 'x'.repeat(81) },
    { ...good, title: ' Faixa' },
    { ...good, artist: 'A\u0000B' },
    { ...good, url: 'https://evil.example/a/b' },
    { ...good, url: page(1) + '#varanda-musica=t:T1' },
    { ...list, count: 0 },
    { ...list, count: 501 },
    { ...list, count: '3' },
    null,
    'x',
    7,
    good,
    { ...good, title: 'Repetida' },
    { ...good, id: 'T3', genre: 'Samba' },
    { ...good, id: 'T4', genre: 'pop' },
    { ...good, id: 'T5', genre: 'Techno, House' },
    { ...good, id: 'T6', duration: 200, year: 2020, cover: true, start: 5, tracks: [] },
    { ...list, genre: 'Pop' }
  ]
  const [slot] = s.decodeRecents(raw([{ owner: A, items }]))
  t.alike(slot.items, [
    good,
    { kind: 'track', id: 'T3', title: 'Faixa 1', artist: 'Artista', url: page(1) },
    { kind: 'track', id: 'T4', title: 'Faixa 1', artist: 'Artista', url: page(1) },
    { kind: 'track', id: 'T5', title: 'Faixa 1', artist: 'Artista', url: page(1) },
    { kind: 'track', id: 'T6', title: 'Faixa 1', artist: 'Artista', url: page(1), genre: 'Pop' },
    list
  ], 'bad items dropped, duplicates once, genres off the list dropped, extra keys never kept')
  const owners = s.decodeRecents(raw([
    { owner: A.toUpperCase(), items: [good] },
    { owner: 'a'.repeat(63), items: [good] },
    { owner: A, items: 'x' },
    { owner: A, items: [good] },
    { owner: A, items: [list] },
    null,
    { owner: B, items: [] }
  ]))
  t.alike(owners, [{ owner: A, items: [good] }, { owner: B, items: [] }], 'bad owners dropped, each owner once')
  const many = []
  for (let i = 1; i <= 30; i++) many.push({ ...good, id: 'T' + i })
  const capped = s.decodeRecents(raw([1, 2, 3, 4, 5, 6].map((i) => ({ owner: owner(i), items: many }))))
  t.is(capped.length, 4, 'at most MAX_OWNERS')
  t.alike(capped.map((o) => o.owner), [owner(1), owner(2), owner(3), owner(4)])
  t.is(capped[0].items.length, 24, 'at most MAX_RECENTS')
  t.is(capped[0].items[23].id, 'T24')
  for (const garbage of [null, undefined, 7, '', '{', 'null', '[]', '"x"', JSON.stringify({ v: 2, owners: [{ owner: A, items: [good] }] }), JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, owners: {} }), JSON.stringify({ v: 1, owners: [7, 'x', [A]] })]) {
    t.alike(s.decodeRecents(garbage), [], JSON.stringify(garbage))
  }
})

test('a raw above MAX_RAW is empty, and a full file at the caps stays below it', async (t) => {
  const s = await load()
  const title = '\u{1F3B5}'.repeat(80)
  const url = 'https://audius.co/' + 'a'.repeat(100) + '/' + 'b'.repeat(100)
  const d = disk()
  const store = s.createMusicRecents(d)
  for (let o = 1; o <= 4; o++) {
    for (let i = 1; i <= 24; i++) {
      const id = String(i).padStart(32, 'x')
      t.ok(store.note(owner(o), 'track', { id, title, artist: title, duration: 200, url: url + i, genre: 'Drum & Bass' }))
    }
  }
  const owners = JSON.parse(d.raw).owners
  t.is(owners.length, 4)
  t.ok(owners.every((x) => x.items.length === 24))
  t.ok(d.raw.length < s.MAX_RAW, 'a full file is ' + d.raw.length + ' characters')
  t.alike(s.decodeRecents(d.raw).length, 4, 'and decodes')
  const padded = JSON.stringify({ v: 1, owners: [{ owner: A, items: [kept(1)] }], pad: 'x'.repeat(s.MAX_RAW) })
  t.alike(s.decodeRecents(padded), [])
})

test('genre counts, order and top genre come from the stored tracks', async (t) => {
  const s = await load()
  t.alike(s.musicGenreOrder([]), [...MUSIC_GENRES], 'no picks keep the list order')
  t.alike(s.musicGenreOrder(undefined), [...MUSIC_GENRES])
  t.is(s.musicTopGenre([]), null)
  t.is(s.musicTopGenre([kept(1)]), null, 'no listed genre')
  t.is(s.musicTopGenre([{ kind: 'playlist', id: 'T2', genre: 'Pop' }]), null, 'playlists never count')
  t.is(s.musicTopGenre([kept(1, 'Jazz')]), 'Jazz', 'one pick is enough')
  t.alike(s.musicGenreCounts([kept(1, 'Pop'), { kind: 'playlist', id: 'T2', genre: 'Pop' }, kept(3, 'Pop'), kept(4, 'Samba'), kept(5)]), new Map([['Pop', 2]]))
  const items = [kept(1, 'Rock'), kept(2, 'Jazz'), kept(3, 'Jazz'), kept(4, 'Techno'), kept(5, 'Rock')]
  const order = s.musicGenreOrder(items)
  t.alike(order.slice(0, 3), ['Rock', 'Jazz', 'Techno'], 'a tie of two goes to the most recent')
  t.alike(order.slice(3), MUSIC_GENRES.filter((g) => !['Rock', 'Jazz', 'Techno'].includes(g)), 'the rest keep the list order')
  t.is(order.length, MUSIC_GENRES.length)
  t.alike(s.musicGenreOrder(items), order, 'stable')
  t.is(s.musicTopGenre(items), 'Rock')
  t.is(s.musicTopGenre([kept(1, 'Jazz'), kept(2, 'Rock'), kept(3, 'Rock')]), 'Rock', 'a higher count beats a more recent pick')
})

test('web store persists through localStorage', async (t) => {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
  try {
    const web = await import('../src/musicRecentsStore.web.js')
    const s = await load()
    t.ok(web.noteMusicRecent(A, 'track', track(1, 'Pop')))
    t.ok(web.noteMusicRecent(B, 'track', track(2)))
    t.alike(web.listMusicRecents(A), [kept(1, 'Pop')])
    t.alike(JSON.parse(map.get(s.STORAGE_KEY)).owners.map((o) => o.owner), [B, A])
    t.ok(web.clearMusicRecentsOf(B))
    t.alike(web.listMusicRecents(B), [])
    t.alike(web.listMusicRecents(A), [kept(1, 'Pop')])
    t.ok(web.clearMusicRecents())
    t.absent(map.has(s.STORAGE_KEY))
    delete globalThis.localStorage
    t.alike(web.listMusicRecents(A), [], 'no storage still answers')
    t.is(web.noteMusicRecent(A, 'track', track(1)), false)
    t.is(web.clearMusicRecents(), false)
  } finally {
    delete globalThis.localStorage
  }
})

test('wiring: sign-out and reset clear the list, a lock keeps it', (t) => {
  const node = read('src/node.js')
  t.ok(node.includes("import { clearMusicRecents } from './musicRecentsStore'"))
  t.ok(node.includes("if (name === 'signOut' || name === 'reset') clearMusicRecents()"), 'sign-out and reset clear the device list')
  const wipe = node.split('\n').filter((line) => line.includes('wipeLocalCaches()'))
  t.ok(wipe.length > 0)
  for (const line of wipe) t.absent(line.includes('clearMusicRecents'), 'not wiped on lock')
  for (const rel of ['src/musicRecentsStore.web.js', 'src/musicRecentsStore.native.js']) {
    const src = read(rel)
    for (const name of ['listMusicRecents', 'noteMusicRecent', 'clearMusicRecentsOf', 'clearMusicRecents']) t.ok(src.includes('export const ' + name + ' ='), rel + ' ' + name)
    t.absent(src.includes('registerLocalCache'), rel + ' is not a local cache')
  }
  const pure = read('src/musicRecents.js')
  for (const banned of ["from 'react", "from 'expo", "from 'fs'", "from 'path'", 'globalThis']) t.absent(pure.includes(banned), banned)
})
