'use strict'

// persist 'peek' (a stranger the Espiadinha shows) and 'copy' (a reopened
// screen's saved copy) end to end in the source: the value passes through
// every view (persistMode) instead of turning into a boolean, the fetch of
// such a photo is transient unless fetchPersist allows the HTTP cache, the
// kept store is read and written only through loadKept, and the cold-start
// preview never shows a peek copy. The behaviour of loadKept and the store is
// tested in mediaKeptLoad.test.js and mediaKeep.test.js.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const PASS = (value) => 'persistMode(' + value + ')'
// The hand coercions persistMode replaced: each turned 'copy' into true.
const COERCED = /=== 'peek' \? (?:'peek'|false) :/

test('PostRow passes peek through to photos, link cards and the avatar', (t) => {
  const src = read('ui/PostRow.js')
  t.ok(src.includes('<MediaGrid author={author} media={media} thumbs={thumbs} alt={alt} persist={' + PASS('persistMedia') + '} bleed />'), 'MediaGrid')
  t.ok(src.includes("thumb={{ kind: 'post', author, persist: " + PASS('persistMedia') + ' }} />'), 'link and music cards')
  t.is(src.split("thumb={{ kind: 'post', author, persist: " + PASS('persistMedia') + ' }}').length - 1, 2, 'both cards')
  t.ok(src.includes('picture={avatar} persist={' + PASS('persistMedia') + '} />'), 'Avatar')
  t.absent(/persist(?:=\{|: )persistMedia !== false[ }]/.test(src), 'no site coerces it to a boolean')
  t.absent(COERCED.test(src), 'no hand coercion left')
})

test('MediaView, Avatar, LinkCard and the music cover keep the peek value', (t) => {
  const media = read('ui/MediaView.js')
  t.ok(media.includes('const keep = ' + PASS('persist') + '\n'))
  t.ok(media.includes('useMedia(author, local ? null : active, keep, thumbStep)'), 'the photo keeps the peek value')
  t.ok(media.includes('const below = useMedia(author, under, keep, true)'), 'so does its thumbnail underlay')
  const avatar = read('ui/Avatar.js')
  t.ok(avatar.includes('useAvatarUrl(mediaAuthor, privateImage ? null : picture, ' + PASS('persist') + ')'))
  const card = read('ui/LinkCard.js')
  t.ok(card.includes('persist={' + PASS('thumb.persist ?? true') + '}'))
  t.ok(read('embedCover.js').includes('persist: ' + PASS('thumb.persist ?? true') + ' }'), 'the music cover source')
  for (const file of ['ui/MediaView.js', 'ui/Avatar.js', 'ui/LinkCard.js', 'ui/QuoteCard.js', 'embedCover.js', 'media/prefetch.js', 'media/prefetchLoad.js']) {
    t.absent(COERCED.test(read(file)), file + ': no hand coercion left')
  }
  t.ok(read('ui/EmbedCover.js').includes('<MediaView author={src.author} descriptor={src.descriptor} persist={src.persist}'), 'EmbedCover hands it to MediaView as is')
})

test('a peek photo is fetched as transient, and the kept store reads its bytes', (t) => {
  const media = read('ui/MediaView.js')
  const hook = media.slice(media.indexOf('function useMedia'), media.indexOf('function startImageFade'))
  t.ok(hook.includes('function useMedia (author, descriptor, keepAs, thumb = false) {\n  const persist = persistMode(keepAs)\n'), 'the mode, peek and copy kept')
  t.ok(hook.includes('fetchBytes: (d) => fetchMedia(author, d, { ...mediaHashDeps(), fresh, persist: fetchPersist(persist, author), fetch: mediaFetch() })'), 'the fetch gets fetchPersist: false for peek and for a copy stranger')
  t.ok(hook.includes('d: descriptor,\n      persist,\n      keptUrl: keptStore.keptUrl,'), 'loadKept gets the mode itself (peek, copy)')
  t.ok(hook.includes('keptBytes: keptStore.keptBytes,'))
  t.ok(hook.includes('}, [canFetch, author, key, attempt, keepAs, thumb])'), 'the effect depends on the value itself')
  const avatar = read('ui/Avatar.js')
  t.ok(avatar.includes('fetchBytes: (d) => fetchAvatarBytes(publicKey, d, { ...mediaHashDeps(), persist: fetchPersist(persist, publicKey), fresh, fetch: mediaFetch() })'))
  t.ok(avatar.includes("kind: 'avatars',\n      author: publicKey,\n      d: picture,\n      persist,\n"), 'loadKept gets the mode itself (peek, copy)')
  t.ok(avatar.includes('keptBytes: refresh ? undefined : keptStore.keptBytes,'), 'a refresh skips the kept bytes like the kept URI')
})

test('fetch.js: persist false is a transient fetch (no-store), unchanged', (t) => {
  const src = read('media/fetch.js')
  t.ok(src.includes('const bytes = await fetchPublic(author, d, deps, deps && deps.persist === false, chat)'), 'fetchMedia')
  t.ok(src.includes('if (edge === own) return fetchVerified(own, d, deps, transient)'), 'fetchPublic keeps the transient flag')
  t.ok(src.includes("init.cache = transient ? 'no-store' : deps && deps.fresh === true ? 'no-cache' : 'force-cache'"), 'browser')
  t.ok(src.includes("} else if (transient) {\n    init.headers = { 'Cache-Control': 'no-store' }"), 'app')
  t.ok(read('media/avatar.js').includes('const bytes = await fetchMedia(author, d, deps)'), 'fetchAvatarBytes hands its deps to fetchMedia')
})

test('the cold-start preview never shows a peek copy', (t) => {
  const media = read('ui/MediaView.js')
  t.ok(media.includes("if (persist === false || persist === 'peek' || typeof author !== 'string'"), 'keptOnlyUrl')
})

test('only loadKept chooses the store kind; noteBlocksKnown has one caller', (t) => {
  const kept = read('media/keptLoad.js')
  t.ok(kept.includes("(persist === 'peek' ? peekKeepAllowed(author) : allowedAuthor(author))"), 'the keep rule')
  t.ok(kept.includes("const readable = keepable && (persist !== 'peek' || peekKeepAllowed(author))"), 'the read rule')
  t.ok(kept.includes('keep(storeKind, author, d, bytes)'))
  t.ok(kept.includes('keptUrl(storeKind, author, d)'))
  t.ok(read('blocksProvider.js').includes('noteBlocksKnown(wiped)'))
})

// keptOnlyUrl (the native cold-start read) runs here from its source, since
// MediaView loads react-native, with the real block registry and copyKindOf.
async function keptOnly (files) {
  const media = read('ui/MediaView.js')
  const start = media.indexOf('export function keptOnlyUrl')
  const body = media.slice(start, media.indexOf('\n}\n', start) + 3).replace('export function', 'function')
  const shown = media.match(/const isShownUrl = .*\n/)[0]
  const caches = await import('../src/localCaches.js')
  const { copyKindOf } = await import('../src/media/keptLoad.js')
  const reads = []
  const keptStore = { keptUrl: (kind, author, d) => { reads.push(kind); return files[kind] ?? null } }
  // eslint-disable-next-line no-new-func
  const fn = new Function('keptStore', 'copyKindOf', 'copyReadAllowed', 'deniedAuthor', shown + body + '\nreturn keptOnlyUrl')(keptStore, copyKindOf, caches.copyReadAllowed, caches.deniedAuthor)
  return { keptOnlyUrl: fn, reads, caches }
}

test('keptOnlyUrl: copy reads the copy kind only once copyReadAllowed, peek never', async (t) => {
  const A = 'a1'.repeat(32)
  const d = { core: 'c'.repeat(64), start: 0, blocks: 1, sha256: 'e'.repeat(64) }
  const { keptOnlyUrl, reads, caches } = await keptOnly({ posts: null, copyPosts: 'file:///copy/posts.jpg', copyAvatars: 'file:///copy/avatar.jpg', peekPosts: 'file:///peek.jpg' })
  caches.wipeLocalCaches()
  t.teardown(() => caches.wipeLocalCaches())
  t.is(keptOnlyUrl('posts', A, d, 'copy'), null, 'no block list yet: no copy read')
  t.alike(reads.splice(0), ['posts'], 'only the main kind was read')
  caches.noteBlocksKnown(caches.wipeEpoch())
  t.is(keptOnlyUrl('posts', A, d, 'copy'), 'file:///copy/posts.jpg', 'blocks known: the copy kind answers')
  t.is(keptOnlyUrl('avatars', A, d, 'copy'), 'file:///copy/avatar.jpg', 'avatars read their copy kind')
  reads.length = 0
  t.is(keptOnlyUrl('posts', A, d, 'peek'), null, 'peek never reads, even with blocks known')
  t.is(keptOnlyUrl('posts', A, d, false), null, 'false never reads')
  t.alike(reads, [], 'nothing was read for peek or false')
  t.is(keptOnlyUrl('posts', A, d, true), null, 'true reads only the main kind')
  t.alike(reads.splice(0), ['posts'])
  caches.dropAuthors([A])
  t.is(keptOnlyUrl('posts', A, d, 'copy'), null, 'a denied author is never read')
  t.alike(reads, [], 'not even the main kind')
  caches.wipeLocalCaches()
  caches.noteBlocksSeeded(caches.wipeEpoch())
  t.is(keptOnlyUrl('posts', A, d, 'copy'), 'file:///copy/posts.jpg', 'an adopted block list allows the copy read too')
})

test('keptOnlyUrl: copy answers with the main kind first', async (t) => {
  const A = 'a2'.repeat(32)
  const d = { core: 'c'.repeat(64), start: 0, blocks: 1, sha256: 'e'.repeat(64) }
  const { keptOnlyUrl, reads, caches } = await keptOnly({ posts: 'file:///main.jpg', copyPosts: 'file:///copy.jpg' })
  caches.wipeLocalCaches()
  t.teardown(() => caches.wipeLocalCaches())
  t.is(keptOnlyUrl('posts', A, d, 'copy'), 'file:///main.jpg', 'a followed copy is in the main kind')
  t.alike(reads, ['posts'])
  t.is(keptOnlyUrl('posts', 'A2'.repeat(32), d, 'copy'), null, 'only a lowercase hex author')
})
