'use strict'

// src/media/keep.native.js over the in-memory expo-file-system stub
// (helpers/stub-file-system.mjs), and the keep.web.js names and no-ops.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const test = require('brittle')

const stub = pathToFileURL(path.join(__dirname, 'helpers/stub-file-system.mjs')).href
const hooks = `
export async function resolve (specifier, context, next) {
  if (specifier === 'expo-file-system') return { url: ${JSON.stringify(stub)}, shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const load = () => import('../src/media/keep.native.js')
const ROOT = 'file:///stub/Caches/varanda-media-keep/'
const files = () => (globalThis.__stubFsFiles ??= new Map())
const dirs = () => (globalThis.__stubDirs ??= new Set())
const keptFiles = () => [...files().keys()].filter((k) => k.startsWith(ROOT)).sort()

const A = 'a1'.repeat(32)
const B = 'b2'.repeat(32)
const CORE = 'c3'.repeat(32)
const OTHER = 'd4'.repeat(32)

function desc (over = {}) {
  return {
    core: CORE,
    mime: 'image/jpeg',
    start: 1,
    blocks: 1,
    bytes: 4,
    sha256: 'e5'.repeat(32),
    width: 10,
    height: 20,
    ...over
  }
}

const bytesOf = (n, fill = 1) => new Uint8Array(n).fill(fill)

// Modification times are BASE + small offsets: real clock values, so the
// 30-day age bound (measured against Date.now) leaves them alone.
const BASE = Date.now()
const DAY = 24 * 60 * 60 * 1000

function reset () {
  files().clear()
  dirs().clear()
  globalThis.__stubNow = BASE + 1000
  globalThis.__stubWriteFails = false
  globalThis.__stubMoveFails = false
}

test('keep then keptUrl gives the same URI, built only from validated fields', async (t) => {
  reset()
  const keep = await load()
  const d = desc()
  t.is(keep.keptUrl('posts', A, d), null, 'nothing kept yet')
  const uri = keep.keep('posts', A, d, bytesOf(4))
  t.is(uri, ROOT + 'posts/' + [A, CORE, 1, 1, 4, 'e5'.repeat(32), '10x20'].join('-') + '.jpg')
  t.is(keep.keptUrl('posts', A, d), uri)
  t.is(keep.keptUrl('posts', A.toUpperCase(), d), uri, 'the author is lowercased')
  t.alike(files().get(uri).bytes, bytesOf(4))
  t.absent(keptFiles().some((k) => k.endsWith('.tmp')), 'no temporary file left')
  t.is(keep.keep('posts', A, d, bytesOf(4)), uri, 'keeping again is idempotent')
  const png = keep.keep('posts', A, desc({ mime: 'image/png', start: 2 }), bytesOf(4))
  t.ok(png.endsWith('.png'), 'extension from the mime table')
  t.ok(keep.keep('posts', A, desc({ mime: 'image/webp', start: 3 }), bytesOf(4)).endsWith('.webp'))
  t.ok(keep.keep('posts', A, desc({ mime: 'image/gif', start: 4 }), bytesOf(4)).endsWith('.gif'))
  const avif = keep.keep('posts', A, desc({ mime: 'image/avif', start: 5 }), bytesOf(4))
  t.ok(avif.endsWith('.avif'), 'an AVIF photo keeps as .avif')
  t.is(keep.keptUrl('posts', A, desc({ mime: 'image/avif', start: 5 })), avif)
})

test('a kept AVIF is listed like the other photos; a name outside the pattern is not', async (t) => {
  reset()
  const keep = await load()
  const avif = keep.keep('posts', A, desc({ mime: 'image/avif' }), bytesOf(4))
  const base = ROOT + 'posts/' + [A, CORE, 2, 1, 4, 'e5'.repeat(32), '10x20'].join('-')
  const strays = [base + '.heic', base + '.avif.jpg', base + '.AVIF']
  for (const stray of strays) files().set(stray, { bytes: bytesOf(4), mtime: BASE })
  keep.dropKeptAuthors([A])
  t.absent(files().has(avif), 'the AVIF file of a dropped author goes')
  for (const stray of strays) t.ok(files().has(stray), 'a stray name is never touched: ' + stray.slice(base.length))
  keep.releaseKept(base + '.heic')
  t.pass('releaseKept ignores a name outside the pattern')
})

test('invalid kind, author, descriptor or bytes are refused', async (t) => {
  reset()
  const keep = await load()
  const d = desc()
  for (const author of ['../' + A.slice(3), A.slice(1), 'x'.repeat(64), null, 7]) {
    t.is(keep.keep('posts', author, d, bytesOf(4)), null, 'author ' + String(author).slice(0, 8))
    t.is(keep.keptUrl('posts', author, d), null)
  }
  const bad = [
    desc({ core: '../' + CORE.slice(3) }),
    desc({ mime: 'text/html' }),
    desc({ sha256: 'zz'.repeat(32) }),
    desc({ start: 0 }),
    desc({ bytes: 40000 }),
    { ...desc(), extra: 1 },
    null,
    'core'
  ]
  for (const b of bad) {
    t.is(keep.keep('posts', A, b, bytesOf(4)), null)
    t.is(keep.keptUrl('posts', A, b), null)
  }
  t.is(keep.keep('profile', A, d, bytesOf(4)), null, 'unknown kind')
  t.is(keep.keep('../posts', A, d, bytesOf(4)), null)
  t.is(keep.keep('posts', A, d, bytesOf(3)), null, 'byte count must match the descriptor')
  t.is(keep.keep('posts', A, d, [1, 2, 3, 4]), null, 'bytes only')
  t.alike(keptFiles(), [], 'nothing written')
})

test('a write or move failure leaves nothing and returns null', async (t) => {
  reset()
  const keep = await load()
  globalThis.__stubWriteFails = true
  t.is(keep.keep('posts', A, desc(), bytesOf(4)), null)
  globalThis.__stubWriteFails = false
  globalThis.__stubMoveFails = true
  t.is(keep.keep('posts', A, desc(), bytesOf(4)), null)
  globalThis.__stubMoveFails = false
  t.alike(keptFiles(), [], 'no partial or temporary file')
})

test('a size mismatch returns null and deletes the file', async (t) => {
  reset()
  const keep = await load()
  const d = desc()
  const uri = keep.keep('posts', A, d, bytesOf(4))
  files().get(uri).bytes = bytesOf(2)
  t.is(keep.keptUrl('posts', A, d), null)
  t.absent(files().has(uri), 'the cut file is gone')
})

test('avatars and posts are separate', async (t) => {
  reset()
  const keep = await load()
  const d = desc()
  const post = keep.keep('posts', A, d, bytesOf(4))
  t.is(keep.keptUrl('avatars', A, d), null, 'a post photo never answers for an avatar')
  const avatar = keep.keep('avatars', A, d, bytesOf(4, 2))
  t.ok(avatar.startsWith(ROOT + 'avatars/'))
  t.not(avatar, post)
  t.is(keep.keptUrl('avatars', A, d), avatar)
  t.is(keep.keptUrl('posts', A, d), post)
})

test('dropKeptRanges removes overlapping files only, in both kinds', async (t) => {
  reset()
  const keep = await load()
  const a = keep.keep('posts', A, desc({ start: 1, blocks: 2, bytes: 40000 }), bytesOf(40000))
  const b = keep.keep('posts', A, desc({ start: 3, blocks: 1 }), bytesOf(4))
  const c = keep.keep('avatars', B, desc({ start: 2, blocks: 1 }), bytesOf(4))
  const d = keep.keep('posts', A, desc({ core: OTHER, start: 2 }), bytesOf(4))
  keep.dropKeptRanges([{ core: CORE, start: 2, blocks: 1 }, { core: 'bad', start: 1, blocks: 1 }])
  t.absent(files().has(a), 'overlaps 1..2')
  t.absent(files().has(c), 'an avatar of the same range')
  t.ok(files().has(b), 'adjacent interval stays')
  t.ok(files().has(d), 'another core stays')
  keep.dropKeptRanges(null)
  keep.dropKeptRanges([{ core: CORE, start: 0, blocks: 0 }])
  t.ok(files().has(b), 'invalid ranges drop nothing')
})

test('dropKeptAuthors and keepOnlyKeptAuthors work by author', async (t) => {
  reset()
  const keep = await load()
  const a1 = keep.keep('posts', A, desc(), bytesOf(4))
  const a2 = keep.keep('avatars', A, desc({ start: 2 }), bytesOf(4))
  const b1 = keep.keep('posts', B, desc({ start: 3 }), bytesOf(4))
  keep.dropKeptAuthors([B.toUpperCase(), 'junk'])
  t.absent(files().has(b1))
  t.ok(files().has(a1) && files().has(a2))
  const b2 = keep.keep('posts', B, desc({ start: 3 }), bytesOf(4))
  keep.keepOnlyKeptAuthors(undefined)
  t.is(keptFiles().length, 3, 'a missing set deletes nothing')
  keep.keepOnlyKeptAuthors(new Set([B]))
  t.absent(files().has(a1) || files().has(a2), 'authors outside the set go')
  t.ok(files().has(b2))
  keep.keepOnlyKeptAuthors(new Set())
  t.alike(keptFiles(), [], 'an empty set deletes everything')
})

// A kept file left by an earlier run: written straight to the stub, so this
// process never handed out its URI (keep() would mark it in use).
function placeKept (kind, author, d, mtime) {
  const dir = ROOT + kind + '/'
  dirs().add(ROOT)
  dirs().add(dir)
  const uri = dir + [author, d.core, d.start, d.blocks, d.bytes, d.sha256, d.width + 'x' + d.height].join('-') + '.jpg'
  files().set(uri, { bytes: bytesOf(d.bytes), mtime: BASE + mtime })
  return uri
}

test('trimKept removes oldest first by mtime under both caps', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const uris = []
  for (let i = 0; i < 5; i++) uris.push(placeKept('posts', A, desc({ start: i + 1 }), 5000 - i * 100))
  // Oldest is the last written: uris[4] (4600), then uris[3] ...
  const tmp = ROOT + 'posts/' + uris[0].slice((ROOT + 'posts/').length) + '.tmp'
  files().set(tmp, { bytes: bytesOf(1), mtime: BASE + 9999 })
  keep.trimKept({ maxFiles: 3 })
  t.absent(files().has(tmp), 'a leftover temporary file goes')
  t.absent(files().has(uris[4]) || files().has(uris[3]), 'the two oldest go')
  t.ok(files().has(uris[0]) && files().has(uris[1]) && files().has(uris[2]))
  keep.trimKept({ maxBytes: 8 })
  t.absent(files().has(uris[2]), 'bytes cap: oldest again')
  t.ok(files().has(uris[0]) && files().has(uris[1]))
  keep.trimKept()
  t.is(keptFiles().length, 2, 'defaults keep small stores whole')
  t.is(keep.KEEP_MAX_BYTES, 64 * 1024 * 1024)
  t.is(keep.KEEP_MAX_FILES, 2000)
})

test('trimKept never deletes a file whose URI this process handed out', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const uris = []
  for (let i = 0; i < 4; i++) uris.push(placeKept('posts', A, desc({ start: i + 1 }), 4000 - i * 100))
  // uris[3] is the oldest; reading it marks it in use.
  t.is(keep.keptUrl('posts', A, desc({ start: 4 })), uris[3])
  keep.trimKept({ maxFiles: 2 })
  t.ok(files().has(uris[3]), 'the shown file stays although oldest')
  t.absent(files().has(uris[2]) || files().has(uris[1]), 'the next oldest go instead')
  t.ok(files().has(uris[0]))
  keep.trimKept({ maxFiles: 0 })
  t.alike(keptFiles(), [uris[3]], 'only in-use files over the cap: trimming stops')
  globalThis.__stubNow = BASE + 1
  const fresh = keep.keep('posts', B, desc(), bytesOf(4))
  keep.trimKept({ maxFiles: 0 })
  t.ok(files().has(fresh), 'a file written by keep is in use too')
  keep.dropKeptAuthors([A])
  t.absent(files().has(uris[3]), 'a purge still deletes an in-use file')
  placeKept('posts', A, desc({ start: 4 }), 1)
  keep.trimKept({ maxFiles: 1 })
  t.absent(files().has(uris[3]), 'and it is no longer protected afterwards')
  t.ok(files().has(fresh))
  keep.wipeKept()
  placeKept('posts', B, desc(), 1)
  keep.trimKept({ maxFiles: 0 })
  t.alike(keptFiles(), [], 'wipeKept forgets every in-use file')
})

test('wipeKept empties the whole store; nothing throws without one', async (t) => {
  reset()
  const keep = await load()
  keep.keep('posts', A, desc(), bytesOf(4))
  keep.keep('avatars', B, desc(), bytesOf(4))
  files().set('file:///stub/Caches/varanda-media/' + 'ab'.repeat(16) + '.jpg', { bytes: bytesOf(1), mtime: BASE + 1 })
  keep.wipeKept()
  t.alike(keptFiles(), [])
  t.absent(dirs().has(ROOT), 'the directory is gone')
  t.is(files().size, 1, 'the display cache is not touched')
  keep.wipeKept()
  keep.trimKept()
  keep.dropKeptRanges([{ core: CORE, start: 1, blocks: 1 }])
  keep.dropKeptAuthors([A])
  keep.keepOnlyKeptAuthors([])
  t.is(keep.keptUrl('posts', A, desc()), null)
  t.ok(keep.keep('posts', A, desc(), bytesOf(4)), 'recreated on demand')
})

// Moves Date.now forward by `ms` for the rest of the test.
function advance (t, ms) {
  const real = Date.now
  const at = real() + ms
  Date.now = () => at
  t.teardown(() => { Date.now = real })
}

const fileCount = () => keptFiles().filter((k) => !k.endsWith('.tmp')).length
const keptBytes = () => keptFiles().reduce((n, k) => n + files().get(k).bytes.byteLength, 0)

test('keep over the file cap trims the oldest files not in use first', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const old = []
  for (let i = 0; i < keep.KEEP_MAX_FILES; i++) old.push(placeKept('posts', A, desc({ start: i + 1 }), i + 1))
  t.is(keep.keptUrl('posts', A, desc({ start: 1 })), old[0], 'the oldest is shown: in use')
  const fresh = keep.keep('posts', B, desc(), bytesOf(4))
  t.ok(fresh, 'the new photo is kept')
  t.ok(fileCount() <= keep.KEEP_MAX_FILES, 'the file cap holds')
  t.ok(files().has(old[0]), 'the file in use stays')
  t.absent(files().has(old[1]) || files().has(old[2]), 'the oldest files not in use go')
  t.ok(files().has(old[old.length - 1]), 'the newest stay')
  const after = fileCount()
  keep.keep('posts', B, desc({ start: 2 }), bytesOf(4))
  t.is(fileCount(), after + 1, 'room was left: the next keep trims nothing')
})

test('keep over the byte cap trims, and refuses when only files in use are left', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const big = (start) => desc({ start, blocks: 256, bytes: 256 * 32768 })
  const n = keep.KEEP_MAX_BYTES / (256 * 32768)
  const old = []
  for (let i = 0; i < n; i++) old.push(placeKept('posts', A, big(1 + i * 256), i + 1))
  t.is(keptBytes(), keep.KEEP_MAX_BYTES, 'the store is exactly full')
  const fresh = keep.keep('posts', B, big(1), bytesOf(256 * 32768))
  t.ok(fresh, 'kept after a trim')
  t.ok(keptBytes() <= keep.KEEP_MAX_BYTES, 'the byte cap holds')
  t.absent(files().has(old[0]), 'the oldest went')

  keep.wipeKept()
  for (let i = 0; i < n; i++) old[i] = placeKept('posts', A, big(1 + i * 256), i + 1)
  for (let i = 0; i < n; i++) t.is(keep.keptUrl('posts', A, big(1 + i * 256)), old[i])
  t.is(keep.keep('posts', B, big(1), bytesOf(256 * 32768)), null, 'every file is in use: not kept')
  t.is(keptBytes(), keep.KEEP_MAX_BYTES, 'nothing deleted, nothing written')
  t.is(keep.keep('posts', B, desc(), bytesOf(4)), null, 'not even a small one')
  keep.releaseKept(old[3])
  t.is(keep.keep('posts', B, desc(), bytesOf(4)), null, 'released just now: still protected')
  t.ok(files().has(old[3]))
  advance(t, keep.KEEP_RELEASE_GRACE_MS + 1000)
  t.ok(keep.keep('posts', B, desc(), bytesOf(4)), 'a released file makes room after the grace')
  t.absent(files().has(old[3]), 'the released file went')
  t.ok(files().has(old[0]), 'files in use stay')
  t.ok(keptBytes() <= keep.KEEP_MAX_BYTES)
})

test('a failed write trims nothing', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const old = []
  for (let i = 0; i < keep.KEEP_MAX_FILES; i++) old.push(placeKept('posts', A, desc({ start: i + 1 }), i + 1))
  globalThis.__stubWriteFails = true
  t.is(keep.keep('posts', B, desc(), bytesOf(4)), null)
  globalThis.__stubWriteFails = false
  t.is(fileCount(), keep.KEEP_MAX_FILES, 'no kept file was deleted')
  t.ok(files().has(old[0]))
  t.absent(keptFiles().some((k) => k.endsWith('.tmp')), 'no temporary file left')
  t.ok(keep.keep('posts', B, desc(), bytesOf(4)), 'a later write trims and keeps')
  t.absent(files().has(old[0]))
})

test('a failed move trims nothing', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  for (let i = 0; i < keep.KEEP_MAX_FILES; i++) placeKept('posts', A, desc({ start: i + 1 }), i + 1)
  globalThis.__stubMoveFails = true
  t.is(keep.keep('posts', B, desc(), bytesOf(4)), null)
  globalThis.__stubMoveFails = false
  t.is(fileCount(), keep.KEEP_MAX_FILES, 'no kept file was deleted')
  t.absent(keptFiles().some((k) => k.endsWith('.tmp')), 'no temporary file left')
})

test('a delete that fails still counts toward the caps', async (t) => {
  reset()
  const keep = await load()
  const { File } = await import(stub)
  keep.wipeKept()
  const stuckUri = placeKept('avatars', A, desc({ start: 8000 }), 0)
  for (let i = 0; i < keep.KEEP_MAX_FILES - 2; i++) placeKept('posts', A, desc({ start: i + 1 }), i + 1)
  t.ok(keep.keep('posts', B, desc({ start: 2 }), bytesOf(4)), 'fits: the store is now full')
  t.is(fileCount(), keep.KEEP_MAX_FILES)
  const realDelete = File.prototype.delete
  File.prototype.delete = function () { if (this.uri === stuckUri) throw new Error('busy'); return realDelete.call(this) }
  t.teardown(() => { File.prototype.delete = realDelete })
  keep.dropKeptRanges([{ core: CORE, start: 8000, blocks: 1 }])
  t.ok(files().has(stuckUri), 'the delete failed')
  t.ok(keep.keep('posts', B, desc({ start: 3 }), bytesOf(4)), 'kept')
  t.ok(fileCount() <= keep.KEEP_MAX_FILES, 'the file left behind is still counted: the cap holds')
})

test('when the files in use leave no room, nothing is trimmed', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const big = (start) => desc({ start, blocks: 256, bytes: 256 * 32768 })
  const n = keep.KEEP_MAX_BYTES / (256 * 32768)
  for (let i = 0; i < n; i++) {
    placeKept('posts', A, big(1 + i * 256), i + 2)
    keep.keptUrl('posts', A, big(1 + i * 256))
  }
  const spare = placeKept('avatars', A, desc(), 1)
  t.is(keep.keep('posts', B, desc(), bytesOf(4)), null, 'cannot fit beside the files in use')
  t.ok(files().has(spare), 'the unused file was not deleted for nothing')
  t.absent(keptFiles().some((k) => k.endsWith('.tmp')))
})

test('releaseKept lets trimKept delete a file again, and ignores other URIs', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const uri = placeKept('posts', A, desc(), 1)
  t.is(keep.keptUrl('posts', A, desc()), uri)
  for (const other of [null, 7, 'blob:x', 'file:///stub/Caches/varanda-media/x.jpg', ROOT + 'posts/../' + uri.slice(ROOT.length + 6), ROOT + 'other/' + uri.slice(ROOT.length + 6)]) keep.releaseKept(other)
  keep.trimKept({ maxFiles: 0 })
  t.ok(files().has(uri), 'still in use')
  keep.releaseKept(uri)
  t.ok(files().has(uri), 'releasing deletes nothing')
  keep.trimKept({ maxFiles: 0 })
  t.ok(files().has(uri), 'a view may still show it: kept during the grace')
  t.is(keep.KEEP_RELEASE_GRACE_MS, 120000)
  advance(t, keep.KEEP_RELEASE_GRACE_MS + 1000)
  keep.trimKept({ maxFiles: 0 })
  t.absent(files().has(uri), 'trimmed once the grace ran out')
})

test('keep with replace swaps a kept file for new bytes under the same name', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const uri = placeKept('avatars', A, desc(), 1)
  t.is(keep.keptUrl('avatars', A, desc()), uri, 'shown')
  t.is(keep.keep('avatars', A, desc(), bytesOf(4, 9)), uri, 'without replace the file is served as is')
  t.alike(files().get(uri).bytes, bytesOf(4), 'untouched')
  t.is(keep.keep('avatars', A, desc(), bytesOf(4, 9), { replace: true }), uri, 'same URI')
  t.alike(files().get(uri).bytes, bytesOf(4, 9), 'the new bytes')
  t.is(fileCount(), 1)
  t.absent(keptFiles().some((k) => k.endsWith('.tmp')), 'no temporary file left')
  keep.trimKept({ maxFiles: 0 })
  t.ok(files().has(uri), 'in use: a trim leaves it')
  const fresh = keep.keep('avatars', B, desc(), bytesOf(4, 7), { replace: true })
  t.ok(fresh, 'replace with nothing kept yet writes the file')
  t.alike(files().get(fresh).bytes, bytesOf(4, 7))
})

test('a replace that cannot move the old file aside, or write the new one, leaves the old file protected', async (t) => {
  reset()
  const keep = await load()
  const { File } = await import(stub)
  keep.wipeKept()
  const uri = placeKept('avatars', A, desc(), -40 * DAY)
  t.is(keep.keptUrl('avatars', A, desc()), uri, 'shown')
  const realMove = File.prototype.move
  File.prototype.move = function (dest) { if (this.uri === uri) throw new Error('busy'); return realMove.call(this, dest) }
  t.teardown(() => { File.prototype.move = realMove })
  t.is(keep.keep('avatars', A, desc(), bytesOf(4, 9), { replace: true }), null, 'not replaced')
  t.alike(files().get(uri).bytes, bytesOf(4), 'the old file is as it was')
  t.absent(keptFiles().some((k) => k.endsWith('.tmp') || k.endsWith('.old')), 'no leftover')
  File.prototype.move = realMove
  globalThis.__stubWriteFails = true
  t.is(keep.keep('avatars', A, desc(), bytesOf(4, 9), { replace: true }), null, 'a failed write replaces nothing')
  globalThis.__stubWriteFails = false
  t.alike(files().get(uri).bytes, bytesOf(4))
  t.absent(keptFiles().some((k) => k.endsWith('.tmp') || k.endsWith('.old')))
  keep.trimKept()
  t.ok(files().has(uri), 'still protected: older than 30 days, yet not trimmed')
})

test('a replace whose move into place fails puts the old file back, protected and counted', async (t) => {
  reset()
  const keep = await load()
  const { File } = await import(stub)
  keep.wipeKept()
  for (let i = 0; i < keep.KEEP_MAX_FILES - 1; i++) placeKept('posts', A, desc({ start: i + 1 }), i + 1)
  const uri = placeKept('avatars', A, desc(), -40 * DAY)
  t.is(keep.keptUrl('avatars', A, desc()), uri, 'shown')
  t.is(fileCount(), keep.KEEP_MAX_FILES, 'the store is at its cap')
  const realMove = File.prototype.move
  File.prototype.move = function (dest) { if (this.uri.endsWith('.tmp')) throw new Error('busy'); return realMove.call(this, dest) }
  t.teardown(() => { File.prototype.move = realMove })
  t.is(keep.keep('avatars', A, desc(), bytesOf(4, 9), { replace: true }), null, 'not replaced')
  File.prototype.move = realMove
  t.ok(files().has(uri), 'the old file is still under its name')
  t.alike((files().get(uri) || {}).bytes, bytesOf(4), 'with its bytes')
  t.absent(keptFiles().some((k) => k.endsWith('.tmp') || k.endsWith('.old')), 'no leftover')
  t.is(keep.keptUrl('avatars', A, desc()), uri, 'and served')
  t.ok(keep.keep('posts', B, desc({ start: 3000 }), bytesOf(4)), 'a new file')
  t.ok(fileCount() <= keep.KEEP_MAX_FILES, 'the old file still counts: the cap holds')
  t.ok(files().has(uri), 'and it is still protected from that trim')
  keep.trimKept()
  t.ok(files().has(uri), 'and from the age bound')
})

test('a .old left by a replace is moved back when its name is empty, deleted otherwise', async (t) => {
  reset()
  const keep = await load()
  const { File } = await import(stub)
  keep.wipeKept()
  const uri = keep.keep('avatars', A, desc(), bytesOf(4))
  const realDelete = File.prototype.delete
  File.prototype.delete = function () { if (this.uri.endsWith('.old')) throw new Error('busy'); return realDelete.call(this) }
  t.teardown(() => { File.prototype.delete = realDelete })
  t.is(keep.keep('avatars', A, desc(), bytesOf(4, 9), { replace: true }), uri, 'replaced, though the old copy could not be deleted')
  File.prototype.delete = realDelete
  t.alike(files().get(uri).bytes, bytesOf(4, 9), 'the new file is served')
  t.ok(files().has(uri + '.old'), 'the old copy is left over')
  t.is(keep.keptUrl('avatars', A, desc()), uri)
  keep.trimKept()
  t.absent(files().has(uri + '.old'), 'the sweep deletes it')
  t.alike(files().get(uri).bytes, bytesOf(4, 9), 'and keeps the new file')

  // A crash after the old file moved aside, before the new one moved in.
  const other = placeKept('avatars', B, desc(), 1)
  files().set(other + '.old', files().get(other))
  files().delete(other)
  files().set(other + '.tmp', { bytes: bytesOf(2), mtime: BASE })
  keep.trimKept()
  t.ok(files().has(other), 'the old file is back under its name')
  t.absent(files().has(other + '.old') || files().has(other + '.tmp'), 'and no leftover stays')
  t.is(keep.keptUrl('avatars', B, desc()), other, 'served again')
})

test('trim keeps a .old it cannot move back, and does not age out the file it restores', async (t) => {
  reset()
  const keep = await load()
  const { File } = await import(stub)
  keep.wipeKept()
  // A crash after the old file moved aside; the copy is older than 30 days.
  const uri = placeKept('avatars', A, desc(), -40 * DAY)
  files().set(uri + '.old', files().get(uri))
  files().delete(uri)
  const realMove = File.prototype.move
  File.prototype.move = function (dest) { if (this.uri === uri + '.old') throw new Error('busy'); return realMove.call(this, dest) }
  t.teardown(() => { File.prototype.move = realMove })
  keep.trimKept()
  t.ok(files().has(uri + '.old'), 'a .old that could not move back is the only copy: kept')
  t.absent(files().has(uri))
  File.prototype.move = realMove
  keep.trimKept()
  t.ok(files().has(uri), 'the next trim moves it back and does not delete it for its age')
  t.absent(files().has(uri + '.old'))
  t.is(keep.keptUrl('avatars', A, desc()), uri, 'served again')
})

test('a purge whose delete fails keeps the file protected', async (t) => {
  reset()
  const keep = await load()
  const { File } = await import(stub)
  keep.wipeKept()
  const shown = placeKept('avatars', A, desc(), -40 * DAY)
  const released = placeKept('avatars', B, desc(), -40 * DAY)
  t.is(keep.keptUrl('avatars', A, desc()), shown)
  t.is(keep.keptUrl('avatars', B, desc()), released)
  keep.releaseKept(released)
  const realDelete = File.prototype.delete
  File.prototype.delete = function () { if (this.uri === shown || this.uri === released) throw new Error('busy'); return realDelete.call(this) }
  t.teardown(() => { File.prototype.delete = realDelete })
  keep.dropKeptAuthors([A, B])
  t.ok(files().has(shown) && files().has(released), 'the deletes failed')
  File.prototype.delete = realDelete
  keep.trimKept()
  t.ok(files().has(shown), 'a file in use is still protected')
  t.ok(files().has(released), 'and so is one inside its release grace')
  keep.dropKeptAuthors([A, B])
  t.absent(files().has(shown) || files().has(released), 'a later purge deletes them')
})

test('releaseKept ignores every URI that is not exactly a kept file', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const uri = placeKept('avatars', A, desc(), 1)
  t.is(keep.keptUrl('avatars', A, desc()), uri)
  const name = uri.slice(ROOT.length + 'avatars/'.length)
  const tries = [
    null, 7, {}, [], '', 'blob:x', 'https://example.test/' + name, 'content://media/' + name,
    'file:///stub/Caches/varanda-media/' + 'ab'.repeat(16) + '.jpg',
    'file:///stub/Caches/' + name,
    ROOT + name,
    ROOT + 'other/' + name,
    ROOT + 'posts/' + name,
    ROOT + 'avatars/../avatars/' + name,
    ROOT + '../' + name,
    ROOT + 'avatars/./' + name,
    ROOT + 'avatars//' + name,
    ROOT + 'avatars/' + name + '/..',
    ROOT + 'avatars/' + name + '.tmp',
    ROOT + 'avatars/' + name + '?x',
    ROOT + 'avatars/' + name + '#x',
    ROOT + 'avatars/' + name.replace('-', '%2F'),
    ROOT.toUpperCase() + 'avatars/' + name,
    ROOT.slice('file://'.length) + 'avatars/' + name,
    '/' + ROOT + 'avatars/' + name,
    'x' + ROOT + 'avatars/' + name
  ]
  for (const other of tries) keep.releaseKept(other)
  advance(t, keep.KEEP_RELEASE_GRACE_MS + 1000)
  keep.trimKept({ maxFiles: 0 })
  t.ok(files().has(uri), 'still in use: none of them released it')
})

test('trimKept deletes files older than 30 days unless in use', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  t.is(keep.KEEP_MAX_AGE_MS, 30 * DAY)
  const stale = placeKept('posts', A, desc({ start: 1 }), -31 * DAY)
  const recent = placeKept('posts', A, desc({ start: 2 }), -29 * DAY)
  const shown = placeKept('avatars', A, desc({ start: 3 }), -40 * DAY)
  t.is(keep.keptUrl('avatars', A, desc({ start: 3 })), shown)
  t.is(keep.keptUrl('posts', A, desc({ start: 1 })), stale, 'a read does not refresh the age')
  keep.releaseKept(stale)
  advance(t, keep.KEEP_RELEASE_GRACE_MS + 1000)
  keep.trimKept()
  t.absent(files().has(stale), 'older than 30 days: gone')
  t.ok(files().has(recent), 'younger: stays')
  t.ok(files().has(shown), 'in use: stays')
})

test('keep.web: same names; no file URI; only the HTTP cache flag differs', async (t) => {
  const native = await load()
  const web = await import('../src/media/keep.web.js')
  t.alike(Object.keys(web).sort(), Object.keys(native).sort())
  for (const kind of ['posts', 'avatars']) {
    t.is(web.keep(kind, A, desc(), bytesOf(4)), null, 'kept on the web, but no URL handed out')
    t.is(web.keptUrl(kind, A, desc()), null)
    t.is(await web.keptBytes(kind, A, desc()), null, 'read back as bytes (the store is off without IndexedDB)')
  }
  t.is(web.retainKept(['posts', 'avatars'], []), null, 'no peek kind: nothing to retain')
  for (const fn of ['keepOnlyKeptAuthors', 'releaseKept', 'trimKept']) t.is(web[fn](), null)
  // The web stores are tested in test/peekKeepWeb.test.js.
  for (const c of ['KEEP_MAX_BYTES', 'KEEP_MAX_FILES', 'KEEP_MAX_AGE_MS', 'KEEP_PEEK_MAX_BYTES', 'KEEP_PEEK_MAX_FILES', 'KEEP_PEEK_MAX_AGE_MS', 'KEEP_COPY_MAX_BYTES', 'KEEP_COPY_MAX_FILES', 'KEEP_COPY_MAX_AGE_MS']) t.is(web[c], native[c], c)
  t.is(native.httpCacheKeeps, true, 'native: a followed author may use the HTTP cache')
  t.is(web.httpCacheKeeps, false, 'web: nothing can purge the browser HTTP cache')
})

test('peek kinds: separate directories and their own constants', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  t.is(keep.KEEP_PEEK_MAX_BYTES, 8 * 1024 * 1024)
  t.is(keep.KEEP_PEEK_MAX_FILES, 200)
  t.is(keep.KEEP_PEEK_MAX_AGE_MS, 7 * DAY)
  const d = desc()
  const uri = keep.keep('peekPosts', B, d, bytesOf(4))
  t.ok(uri.startsWith(ROOT + 'peekPosts/'), 'under peekPosts')
  t.is(keep.keptUrl('peekPosts', B, d), uri)
  t.is(keep.keptUrl('posts', B, d), null, 'a peek file never answers for a main entry')
  t.is(keep.keptUrl('peekAvatars', B, d), null, 'nor for a peek avatar')
  const av = keep.keep('peekAvatars', B, d, bytesOf(4))
  t.ok(av.startsWith(ROOT + 'peekAvatars/'))
  t.is(keep.keptBytes('peekPosts', B, d), null, 'files are read by URI natively')
  t.is(keep.bindPeek(), null)
})

test('peek caps are independent of the main caps', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const main = []
  for (let i = 0; i < keep.KEEP_MAX_FILES; i++) main.push(placeKept('posts', A, desc({ start: i + 1 }), i + 1))
  const peek = []
  for (let i = 0; i < keep.KEEP_PEEK_MAX_FILES; i++) peek.push(placeKept('peekPosts', B, desc({ start: i + 1 }), i + 1))
  const fresh = keep.keep('peekPosts', OTHER, desc(), bytesOf(4))
  t.ok(fresh, 'a peek keep over its file cap is admitted')
  const peekLeft = keptFiles().filter((k) => k.includes('/peekPosts/')).length
  t.ok(peekLeft <= keep.KEEP_PEEK_MAX_FILES, 'the peek file cap holds')
  t.absent(files().has(peek[0]), 'the oldest peek file goes')
  t.is(main.filter((u) => files().has(u)).length, keep.KEEP_MAX_FILES, 'no main file was trimmed for it')
  const mainFresh = keep.keep('posts', OTHER, desc(), bytesOf(4))
  t.ok(mainFresh, 'a main keep over its cap is admitted')
  t.is(keptFiles().filter((k) => k.includes('/peekPosts/')).length, peekLeft, 'no peek file was trimmed for it')
  t.ok(keptFiles().filter((k) => k.includes('/posts/') && !k.includes('/peekPosts/')).length <= keep.KEEP_MAX_FILES)
})

test('the peek byte cap refuses when only peek files in use are left, the main budget still keeps', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const blocks = 256
  const big = desc({ blocks, bytes: blocks * 32768 })
  t.is(big.bytes, keep.KEEP_PEEK_MAX_BYTES, 'one largest photo fills the peek budget')
  const shown = keep.keep('peekPosts', B, big, bytesOf(big.bytes))
  t.ok(shown, 'kept and in use')
  const other = desc({ blocks, bytes: blocks * 32768, start: 300 })
  t.is(keep.keep('peekPosts', B, other, bytesOf(other.bytes)), null, 'no room beside a file in use')
  t.ok(files().has(shown), 'nothing deleted')
  t.ok(keep.keep('posts', B, other, bytesOf(other.bytes)), 'the main budget takes it')
})

test('trimKept ages peek files out after 7 days, main files keep 30', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const peekOld = placeKept('peekPosts', B, desc({ start: 1 }), -8 * DAY)
  const peekNew = placeKept('peekAvatars', B, desc({ start: 2 }), -6 * DAY)
  const mainOld = placeKept('posts', A, desc({ start: 3 }), -8 * DAY)
  keep.trimKept()
  t.absent(files().has(peekOld), 'older than 7 days: gone')
  t.ok(files().has(peekNew), 'younger: stays')
  t.ok(files().has(mainOld), 'the main kinds keep their 30 days')
})

test('a follow reconcile leaves peek files; a block, a range revoke and a wipe remove them', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const peekB = placeKept('peekPosts', B, desc({ start: 1 }), 1)
  const peekAvB = placeKept('peekAvatars', B, desc({ start: 2 }), 2)
  const peekOther = placeKept('peekPosts', OTHER, desc({ start: 3, core: OTHER }), 3)
  const mainB = placeKept('posts', B, desc({ start: 4 }), 4)
  keep.keepOnlyKeptAuthors([A])
  t.absent(files().has(mainB), 'the main copy of an unfollowed author goes')
  t.ok(files().has(peekB) && files().has(peekAvB) && files().has(peekOther), 'peek files stay')
  keep.dropKeptRanges([{ core: OTHER, start: 3, blocks: 1 }])
  t.absent(files().has(peekOther), 'a revoked range removes a peek file')
  keep.dropKeptAuthors([B])
  t.absent(files().has(peekB) || files().has(peekAvB), 'a block removes every peek file of the author')
  const again = placeKept('peekPosts', B, desc({ start: 5 }), 5)
  keep.wipeKept()
  t.absent(files().has(again), 'a wipe removes them')
  t.alike(keptFiles(), [])
})

test('retainKept deletes the files of the given kinds not named', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const d1 = desc({ start: 1 })
  const d2 = desc({ start: 2 })
  const a = placeKept('peekPosts', B, d1, 1)
  const b = placeKept('peekPosts', B, d2, 2)
  const c = placeKept('peekAvatars', B, d1, 3)
  const m = placeKept('posts', B, d1, 4)
  files().set(ROOT + 'peekPosts/' + a.slice((ROOT + 'peekPosts/').length) + '.tmp', { bytes: bytesOf(4), mtime: BASE })
  keep.retainKept(['peekPosts', 'peekAvatars'], [{ kind: 'peekPosts', author: B.toUpperCase(), d: d1 }, null, { kind: 'peekAvatars', author: 'nope', d: d1 }])
  t.ok(files().has(a), 'a named file stays')
  t.absent(files().has(b), 'an unnamed file of a given kind goes')
  t.absent(files().has(c), 'an entry with an invalid author names nothing')
  t.ok(files().has(m), 'other kinds are untouched')
  t.absent(keptFiles().some((k) => k.endsWith('.tmp')), 'a leftover .tmp goes')
  keep.retainKept(['peekPosts'], 'not a list')
  t.ok(files().has(a), 'a non-array is ignored')
  keep.retainKept('peekPosts', [])
  t.ok(files().has(a), 'kinds must be an array')
  keep.retainKept(['peekPosts'], [])
  t.absent(files().has(a), 'an empty list deletes them all')
  t.ok(files().has(m))
})

test('keptUrl refuses and deletes a peek file past 7 days; a main file of that age still answers', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const d = desc({ start: 1 })
  const old = placeKept('peekPosts', B, d, -8 * DAY)
  const young = placeKept('peekAvatars', B, d, -6 * DAY)
  const main = placeKept('posts', B, d, -8 * DAY)
  t.is(keep.keptUrl('peekPosts', B, d), null, 'an 8-day-old peek file does not answer')
  t.absent(files().has(old), 'and is deleted')
  t.is(keep.keptUrl('peekAvatars', B, d), young, 'a younger one does')
  t.is(keep.keptUrl('posts', B, d), main, 'the main kinds keep their 30 days')
})

test('the first peek use of a start trims the peek kinds once', async (t) => {
  reset()
  // A fresh module instance stands for a new start.
  const keep = await import('../src/media/keep.native.js?start=' + Date.now())
  const stale = placeKept('peekPosts', OTHER, desc({ start: 7 }), -8 * DAY)
  const fresh = placeKept('peekPosts', OTHER, desc({ start: 8 }), -1 * DAY)
  t.is(keep.keptUrl('peekPosts', B, desc({ start: 9 })), null, 'an unrelated miss')
  t.absent(files().has(stale), 'the stale peek file went at the first use')
  t.ok(files().has(fresh), 'the young one stays')
  const later = placeKept('peekPosts', OTHER, desc({ start: 10 }), -8 * DAY)
  keep.keptUrl('peekPosts', B, desc({ start: 9 }))
  t.ok(files().has(later), 'only once per start')
  const keep2 = await import('../src/media/keep.native.js?start=b' + Date.now())
  keep2.bindPeek()
  t.absent(files().has(later), 'bindPeek also runs it')
})

const SHA = 'f7'.repeat(32)
const SHA2 = '8a'.repeat(32)

// A decrypted group picture left by an earlier run.
function placeThumb (author, sha, mtime, size = 10, ext = 'jpg') {
  const dir = ROOT + 'copyGroupThumbs/'
  dirs().add(ROOT)
  dirs().add(dir)
  const uri = dir + author + '-' + sha + '.' + ext
  files().set(uri, { bytes: bytesOf(size), mtime: BASE + mtime })
  return uri
}

const inDir = (kind) => keptFiles().filter((k) => k.startsWith(ROOT + kind + '/') && !k.endsWith('.tmp'))

test('copy kinds: separate directories and their own constants', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  t.is(keep.KEEP_COPY_MAX_BYTES, 8 * 1024 * 1024)
  t.is(keep.KEEP_COPY_MAX_FILES, 200)
  t.is(keep.KEEP_COPY_MAX_AGE_MS, 14 * DAY)
  t.is(keep.KEEP_GROUP_THUMB_MAX_BYTES, 256 * 1024)
  const d = desc()
  const uri = keep.keep('copyPosts', B, d, bytesOf(4))
  t.ok(uri.startsWith(ROOT + 'copyPosts/'), 'under copyPosts')
  t.is(keep.keptUrl('copyPosts', B, d), uri)
  t.is(keep.keptUrl('posts', B, d), null, 'a copy file never answers for a main entry')
  t.is(keep.keptUrl('peekPosts', B, d), null, 'nor for a peek entry')
  t.is(keep.keptUrl('copyAvatars', B, d), null, 'nor for a copy avatar')
  const av = keep.keep('copyAvatars', B, d, bytesOf(4))
  t.ok(av.startsWith(ROOT + 'copyAvatars/'))
  t.is(keep.keep('copyGroupThumbs', B, d, bytesOf(4)), null, 'a group picture is kept through keepGroupThumb only')
  t.is(keep.keptUrl('copyGroupThumbs', B, d), null)
})

test('a copy file survives every retainKept; a peek file is still deleted by its retain', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const copyPost = placeKept('copyPosts', B, desc({ start: 1 }), 1)
  const copyAv = placeKept('copyAvatars', B, desc({ start: 2 }), 2)
  const thumb = placeThumb(B, SHA, 3)
  const peek = placeKept('peekPosts', B, desc({ start: 3 }), 4)
  const peekAv = placeKept('peekAvatars', B, desc({ start: 4 }), 5)
  keep.retainKept(['peekAvatars', 'peekPosts'], [])
  t.absent(files().has(peek) || files().has(peekAv), 'the peek retain deletes the peek files')
  t.ok(files().has(copyPost) && files().has(copyAv) && files().has(thumb), 'and leaves the copy files')
  keep.retainKept(['copyPosts'], [])
  keep.retainKept(['copyPosts', 'copyAvatars', 'copyGroupThumbs'], [])
  t.ok(files().has(copyPost) && files().has(copyAv) && files().has(thumb), 'a retain naming the copy kinds deletes nothing')
})

test('the copy pool holds 200 files on its own counters and never evicts a main or peek file', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const main = []
  for (let i = 0; i < keep.KEEP_MAX_FILES; i++) main.push(placeKept('posts', A, desc({ start: i + 1 }), i + 1))
  const peek = []
  for (let i = 0; i < keep.KEEP_PEEK_MAX_FILES; i++) peek.push(placeKept('peekPosts', B, desc({ start: i + 1 }), i + 1))
  const copy = []
  for (let i = 0; i < keep.KEEP_COPY_MAX_FILES; i++) copy.push(placeKept('copyPosts', B, desc({ start: i + 1 }), i + 1))
  const fresh = keep.keep('copyPosts', OTHER, desc(), bytesOf(4))
  t.ok(fresh, 'a copy keep over its file cap is admitted')
  const copyLeft = inDir('copyPosts').length
  t.ok(copyLeft <= keep.KEEP_COPY_MAX_FILES, 'the copy file cap holds')
  t.absent(files().has(copy[0]), 'the oldest copy file goes')
  t.ok(files().has(copy[copy.length - 1]), 'the newest stays')
  t.is(main.filter((u) => files().has(u)).length, keep.KEEP_MAX_FILES, 'no main file was trimmed for it')
  t.is(peek.filter((u) => files().has(u)).length, keep.KEEP_PEEK_MAX_FILES, 'no peek file was trimmed for it')
  t.ok(keep.keep('peekPosts', OTHER, desc(), bytesOf(4)), 'a peek keep over its cap is admitted')
  t.ok(keep.keep('posts', OTHER, desc(), bytesOf(4)), 'so is a main keep')
  t.is(inDir('copyPosts').length, copyLeft, 'no copy file was trimmed for them')
  t.ok(keep.keepGroupThumb(B, SHA, bytesOf(10), 'image/jpeg'), 'a group picture is admitted')
  t.is(inDir('copyPosts').length + inDir('copyGroupThumbs').length, copyLeft + 1, 'and counts in the copy pool')
})

test('the copy byte cap refuses when only copy files in use are left, the other budgets still keep', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const blocks = 256
  const big = desc({ blocks, bytes: blocks * 32768 })
  t.is(big.bytes, keep.KEEP_COPY_MAX_BYTES, 'one largest photo fills the copy budget')
  const shown = keep.keep('copyPosts', B, big, bytesOf(big.bytes))
  t.ok(shown, 'kept and in use')
  const other = desc({ blocks, bytes: blocks * 32768, start: 300 })
  t.is(keep.keep('copyAvatars', B, other, bytesOf(other.bytes)), null, 'no room beside a file in use')
  t.is(keep.keepGroupThumb(B, SHA, bytesOf(10), 'image/jpeg'), null, 'nor for a group picture')
  t.ok(files().has(shown), 'nothing deleted')
  t.ok(keep.keep('peekPosts', B, other, bytesOf(other.bytes)), 'the peek budget takes it')
  t.ok(keep.keep('posts', B, other, bytesOf(other.bytes)), 'so does the main budget')
})

test('copy files age out after 14 days, at trim and on read', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const d = desc({ start: 1 })
  const copyOld = placeKept('copyPosts', B, desc({ start: 1 }), -15 * DAY)
  const copyNew = placeKept('copyAvatars', B, desc({ start: 2 }), -13 * DAY)
  const thumbOld = placeThumb(B, SHA, -15 * DAY)
  const thumbNew = placeThumb(B, SHA2, -13 * DAY)
  const peekOld = placeKept('peekPosts', B, desc({ start: 3 }), -8 * DAY)
  const mainOld = placeKept('posts', A, desc({ start: 4 }), -15 * DAY)
  keep.trimKept()
  t.absent(files().has(copyOld) || files().has(thumbOld), 'older than 14 days: gone')
  t.ok(files().has(copyNew) && files().has(thumbNew), 'younger: stays')
  t.absent(files().has(peekOld), 'the peek kinds keep their 7 days')
  t.ok(files().has(mainOld), 'the main kinds keep their 30 days')

  const stale = placeKept('copyPosts', B, d, -15 * DAY)
  t.is(keep.keptUrl('copyPosts', B, d), null, 'a 15-day-old copy file does not answer')
  t.absent(files().has(stale), 'and is deleted')
  t.is(keep.keptUrl('copyAvatars', B, desc({ start: 2 })), copyNew, 'a younger one does')
  const staleThumb = placeThumb(B, SHA, -15 * DAY)
  t.is(keep.keptGroupThumb(B, SHA), null, 'nor does a 15-day-old group picture')
  t.absent(files().has(staleThumb))
  t.is(keep.keptGroupThumb(B, SHA2), thumbNew)
})

test('a block, a range revoke and a wipe remove copy files; a follow reconcile keeps them', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const copyB = placeKept('copyPosts', B, desc({ start: 1 }), 1)
  const copyAvB = placeKept('copyAvatars', B, desc({ start: 2 }), 2)
  const copyOther = placeKept('copyPosts', OTHER, desc({ start: 3, core: OTHER }), 3)
  const thumbB = placeThumb(B, SHA, 4)
  const thumbA = placeThumb(A, SHA, 5)
  const mainB = placeKept('posts', B, desc({ start: 4 }), 6)
  keep.keepOnlyKeptAuthors([A])
  t.absent(files().has(mainB), 'the main copy of an unfollowed author goes')
  t.ok(files().has(copyB) && files().has(copyAvB) && files().has(copyOther) && files().has(thumbB), 'copy files stay')
  keep.keepOnlyKeptAuthors([])
  t.ok(files().has(copyB) && files().has(thumbA), 'even with nobody followed')
  keep.dropKeptRanges([{ core: OTHER, start: 3, blocks: 1 }, { core: CORE, start: 1, blocks: 1 }])
  t.absent(files().has(copyOther) || files().has(copyB), 'a revoked range removes a copy file')
  t.ok(files().has(thumbB), 'a group picture has no range')
  keep.dropKeptAuthors([B])
  t.absent(files().has(copyAvB) || files().has(thumbB), 'a block removes every copy file and group picture of the author')
  t.ok(files().has(thumbA), 'of that author only')
  placeKept('copyPosts', B, desc({ start: 5 }), 7)
  keep.wipeKept()
  t.alike(keptFiles(), [], 'a wipe removes them')
})

test('group pictures: keep, read back, limits and retainGroupThumbs', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const uri = keep.keepGroupThumb(B, SHA, bytesOf(10), 'image/jpeg')
  t.is(uri, ROOT + 'copyGroupThumbs/' + B + '-' + SHA + '.jpg', 'named by image author and plaintext hash')
  t.is(keep.keptGroupThumb(B.toUpperCase(), SHA), uri, 'the author is lowercased')
  t.is(keep.keepGroupThumb(B, SHA, bytesOf(10), 'image/jpeg'), uri, 'keeping again is idempotent')
  t.is(keep.keptGroupThumb(B, SHA2), null, 'another picture is not kept')
  t.is(keep.keptGroupThumb(A, SHA), null, 'nor another author\'s')
  for (const [author, sha, bytes, mime, why] of [
    ['x'.repeat(64), SHA, bytesOf(10), 'image/jpeg', 'author'],
    [A, '../' + SHA.slice(3), bytesOf(10), 'image/jpeg', 'hash'],
    [A, SHA.toUpperCase().replace(/F/g, 'G'), bytesOf(10), 'image/jpeg', 'non-hex hash'],
    [A, SHA, bytesOf(10), 'text/html', 'mime'],
    [A, SHA, bytesOf(10), 'image/png', 'a type the live draw never shows'],
    [A, SHA, new Uint8Array(0), 'image/jpeg', 'empty'],
    [A, SHA, bytesOf(keep.KEEP_GROUP_THUMB_MAX_BYTES + 1), 'image/jpeg', 'over 256 KiB'],
    [A, SHA, [1, 2], 'image/jpeg', 'bytes only']
  ]) t.is(keep.keepGroupThumb(author, sha, bytes, mime), null, why)
  t.ok(keep.keepGroupThumb(A, SHA, bytesOf(keep.KEEP_GROUP_THUMB_MAX_BYTES), 'image/jpeg'), 'exactly 256 KiB is kept')
  const big = placeThumb(A, SHA2, 1, keep.KEEP_GROUP_THUMB_MAX_BYTES + 1)
  t.is(keep.keptGroupThumb(A, SHA2), null, 'an oversized file does not answer')
  t.absent(files().has(big), 'and is deleted')

  const other = placeThumb(A, SHA2, 2)
  keep.retainGroupThumbs('not a list')
  keep.retainGroupThumbs(null)
  t.ok(files().has(other), 'a non-array is ignored')
  keep.retainGroupThumbs([{ author: B.toUpperCase(), sha: SHA }, null, { author: 'nope', sha: SHA2 }])
  t.ok(files().has(uri), 'a named picture stays')
  t.absent(files().has(other), 'an unnamed one goes')
  t.absent(inDir('copyGroupThumbs').some((k) => k.startsWith(ROOT + 'copyGroupThumbs/' + A)), 'whatever its extension')
  const post = keep.keep('copyPosts', B, desc(), bytesOf(4))
  keep.retainGroupThumbs([])
  t.alike(inDir('copyGroupThumbs'), [], 'an empty list deletes every group picture')
  t.ok(files().has(post), 'and no other copy file')
})

test('releaseKept lets a trim delete a copy file or group picture again', async (t) => {
  reset()
  const keep = await load()
  keep.wipeKept()
  const post = keep.keep('copyPosts', B, desc(), bytesOf(4))
  const thumb = keep.keepGroupThumb(B, SHA, bytesOf(10), 'image/jpeg')
  files().get(post).mtime = BASE - 15 * DAY
  files().get(thumb).mtime = BASE - 15 * DAY
  keep.trimKept()
  t.ok(files().has(post) && files().has(thumb), 'in use: kept past its age')
  keep.releaseKept(post)
  keep.releaseKept(thumb)
  advance(t, keep.KEEP_RELEASE_GRACE_MS + 1000)
  keep.trimKept()
  t.absent(files().has(post) || files().has(thumb), 'released and past the grace: gone')
})

test('the first copy use of a start trims the copy kinds once', async (t) => {
  reset()
  const keep = await import('../src/media/keep.native.js?copystart=' + Date.now())
  const stale = placeKept('copyPosts', OTHER, desc({ start: 7 }), -15 * DAY)
  const fresh = placeKept('copyPosts', OTHER, desc({ start: 8 }), -1 * DAY)
  t.is(keep.keptUrl('copyPosts', B, desc({ start: 9 })), null, 'an unrelated miss')
  t.absent(files().has(stale), 'the stale copy file went at the first use')
  t.ok(files().has(fresh), 'the young one stays')
  const later = placeKept('copyPosts', OTHER, desc({ start: 10 }), -15 * DAY)
  keep.keptUrl('copyPosts', B, desc({ start: 9 }))
  t.ok(files().has(later), 'only once per start')
  const keep2 = await import('../src/media/keep.native.js?copystart=b' + Date.now())
  keep2.bindPeek()
  t.absent(files().has(later), 'bindPeek also runs it')
})
