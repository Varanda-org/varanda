'use strict'

// src/media/keep.native.js over the in-memory expo-file-system stub
// (helpers/stub-file-system.mjs), and the keep.web.js no-ops.
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

test('keep.web: same names, all no-ops', async (t) => {
  const native = await load()
  const web = await import('../src/media/keep.web.js')
  t.alike(Object.keys(web).sort(), Object.keys(native).sort())
  t.is(web.keep('posts', A, desc(), bytesOf(4)), null)
  t.is(web.keptUrl('posts', A, desc()), null)
  for (const fn of ['dropKeptRanges', 'dropKeptAuthors', 'keepOnlyKeptAuthors', 'releaseKept', 'wipeKept', 'trimKept']) t.is(web[fn](), null)
  t.is(web.KEEP_MAX_AGE_MS, native.KEEP_MAX_AGE_MS)
})
