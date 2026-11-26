'use strict'

// persist 'peek' (a stranger the Espiadinha shows) end to end in the source:
// the value passes through every view instead of turning into a boolean, the
// fetch of such a photo is transient (never the unmanaged HTTP cache), the
// kept store is read and written only through loadKept, and the cold-start
// preview never shows a peek copy. The behaviour of loadKept and the store is
// tested in mediaKeptLoad.test.js and mediaKeep.test.js.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const PASS = (value) => value + " === 'peek' ? 'peek' : " + value + ' !== false'

test('PostRow passes peek through to photos, link cards and the avatar', (t) => {
  const src = read('ui/PostRow.js')
  t.ok(src.includes('<MediaGrid author={author} media={media} thumbs={thumbs} alt={alt} persist={' + PASS('persistMedia') + '} bleed />'), 'MediaGrid')
  t.ok(src.includes("thumb={{ kind: 'post', author, persist: " + PASS('persistMedia') + ' }} />'), 'link and music cards')
  t.is(src.split("thumb={{ kind: 'post', author, persist: " + PASS('persistMedia') + ' }}').length - 1, 2, 'both cards')
  t.ok(src.includes('picture={avatar} persist={' + PASS('persistMedia') + '} />'), 'Avatar')
  t.absent(/persist(?:=\{|: )persistMedia !== false[ }]/.test(src), 'no site coerces it to a boolean')
})

test('MediaView, Avatar, LinkCard and the music cover keep the peek value', (t) => {
  const media = read('ui/MediaView.js')
  t.ok(media.includes('const keep = ' + PASS('persist') + '\n'))
  t.ok(media.includes('useMedia(author, local ? null : active, keep, thumbStep)'), 'the photo keeps the peek value')
  t.ok(media.includes('const below = useMedia(author, under, keep, true)'), 'so does its thumbnail underlay')
  const avatar = read('ui/Avatar.js')
  t.ok(avatar.includes('useAvatarUrl(mediaAuthor, privateImage ? null : picture, ' + PASS('persist') + ')'))
  const card = read('ui/LinkCard.js')
  t.ok(card.includes('persist={' + PASS('thumb.persist') + '}'))
  t.ok(read('embedCover.js').includes('persist: ' + PASS('thumb.persist') + ' }'), 'the music cover source')
  t.ok(read('ui/EmbedCover.js').includes('<MediaView author={src.author} descriptor={src.descriptor} persist={src.persist}'), 'EmbedCover hands it to MediaView as is')
})

test('a peek photo is fetched as transient, and the kept store reads its bytes', (t) => {
  const media = read('ui/MediaView.js')
  const hook = media.slice(media.indexOf('function useMedia'), media.indexOf('function startImageFade'))
  t.ok(hook.includes("function useMedia (author, descriptor, keepAs, thumb = false) {\n  const persist = keepAs === 'peek' ? false : keepAs\n"), 'persist is false for peek')
  t.ok(hook.includes('fetchBytes: (d) => fetchMedia(author, d, { ...mediaHashDeps(), fresh, persist, fetch: mediaFetch() })'), 'the fetch gets that persist')
  t.ok(hook.includes('persist: keepAs,\n'), 'loadKept gets the peek value')
  t.ok(hook.includes('keptBytes: keptStore.keptBytes,'))
  t.ok(hook.includes('}, [canFetch, author, key, attempt, keepAs, thumb])'), 'the effect depends on the value itself')
  const avatar = read('ui/Avatar.js')
  t.ok(avatar.includes("fetchBytes: (d) => fetchAvatarBytes(publicKey, d, { ...mediaHashDeps(), persist: persist === 'peek' ? false : persist, fresh, fetch: mediaFetch() })"))
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
