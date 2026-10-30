'use strict'

// src/media/display.native.js with expo-file-system replaced by an in-memory
// stub (the hook below resolves the bare specifier), and display.web.js.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const fileSystem = `
const files = globalThis.__mediaFiles = globalThis.__mediaFiles || new Map()
const dirs = globalThis.__mediaDirs = globalThis.__mediaDirs || new Set()
export const Paths = { cache: { uri: 'file:///stub/Caches/' }, document: { uri: 'file:///stub/Documents/' } }
export class Directory {
  constructor (parent, name) { this.uri = parent.uri + name + '/' }
  get exists () { return dirs.has(this.uri) }
  create (opts = {}) {
    if (dirs.has(this.uri) && !opts.idempotent) throw new Error('exists')
    dirs.add(this.uri)
  }
  delete () {
    if (!dirs.has(this.uri)) throw new Error('missing')
    dirs.delete(this.uri)
    for (const k of [...files.keys()]) if (k.startsWith(this.uri)) files.delete(k)
  }
}
export class File {
  constructor (dir, name) { this.dir = dir.uri; this.uri = dir.uri + name }
  get exists () { return files.has(this.uri) }
  create () {
    if (!dirs.has(this.dir)) throw new Error('no directory')
    if (files.has(this.uri)) throw new Error('exists')
    files.set(this.uri, new Uint8Array(0))
  }
  write (bytes) {
    if (globalThis.__mediaWriteFails) throw new Error('disk full')
    files.set(this.uri, Uint8Array.from(bytes))
  }
  delete () {
    if (!files.has(this.uri)) throw new Error('missing')
    files.delete(this.uri)
  }
}
`
const hooks = `
const stub = 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(fileSystem)})
export async function resolve (specifier, context, next) {
  if (specifier === 'expo-file-system') return { url: stub, shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const DIR = 'file:///stub/Caches/varanda-media/'
const files = () => globalThis.__mediaFiles
const dirs = () => globalThis.__mediaDirs

test('display.native: writes under the cache, returns file://, deletes and sweeps', async (t) => {
  // A photo left by an earlier run, before the module's first use.
  const { Directory, File, Paths } = await import('expo-file-system')
  const old = new Directory(Paths.cache, 'varanda-media')
  old.create()
  const stale = new File(old, 'ab'.repeat(16) + '.jpg')
  stale.create()
  stale.write(new Uint8Array([1]))

  const display = await import('../src/media/display.native.js')
  const bytes = new Uint8Array([1, 2, 3, 4])
  const url = display.urlFromBytes(bytes, 'image/png')
  t.ok(/^file:\/\/\/stub\/Caches\/varanda-media\/[0-9a-f]{32}\.png$/.test(url), 'random name, mime extension, cache directory')
  t.absent(files().has(stale.uri), 'the first use swept the earlier run')
  t.alike(files().get(url), bytes, 'the verified bytes')
  t.absent([...files().keys()].some((k) => k.startsWith('file:///stub/Documents/')), 'nothing in Documents')

  const second = display.urlFromBytes(new Uint8Array([5]), 'image/jpeg')
  t.ok(second.endsWith('.jpg'))
  t.not(second, url)
  t.ok(files().has(url), 'later uses do not sweep')
  t.ok(display.urlFromBytes(new Uint8Array([6]), 'image/webp').endsWith('.webp'))
  t.ok(display.urlFromBytes(new Uint8Array([7]), 'image/gif').endsWith('.gif'))

  display.revokeUrl(url)
  t.absent(files().has(url), 'revoke deletes the file')
  display.revokeUrl(url)
  t.pass('revoking twice does not throw')

  // Only files this module wrote can be deleted.
  const outside = 'file:///stub/Documents/' + 'cd'.repeat(16) + '.jpg'
  files().set(outside, new Uint8Array([9]))
  display.revokeUrl(outside)
  display.revokeUrl(DIR + '../' + 'cd'.repeat(16) + '.jpg')
  display.revokeUrl(DIR + 'varanda-config.json')
  display.revokeUrl('blob:x')
  display.revokeUrl(null)
  t.ok(files().has(outside), 'a file outside the media directory stays')

  t.exception(() => display.urlFromBytes(bytes, 'text/html'), /inválida/, 'unknown mime')
  t.exception(() => display.urlFromBytes(bytes, 'constructor'), /inválida/, 'prototype key is not a mime')
  t.exception(() => display.urlFromBytes('abc', 'image/png'), /inválida/, 'bytes only')

  globalThis.__mediaWriteFails = true
  const before = files().size
  t.exception(() => display.urlFromBytes(bytes, 'image/png'), /disk full/)
  globalThis.__mediaWriteFails = false
  t.is(files().size, before, 'a failed write leaves no file')

  display.sweepMediaCache()
  t.absent(dirs().has(DIR), 'sweep removes the directory')
  t.absent([...files().keys()].some((k) => k.startsWith(DIR)), 'and every photo')
  t.ok(files().has(outside), 'and nothing else')
  display.sweepMediaCache()
  t.pass('sweeping again is a no-op')
  const again = display.urlFromBytes(bytes, 'image/png')
  t.ok(files().has(again), 'the directory is recreated on demand')
})

test('display.web: blob URL typed with the mime, revoked with revokeObjectURL', async (t) => {
  const display = await import('../src/media/display.web.js')
  const made = []
  const revoked = []
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  URL.createObjectURL = (blob) => { made.push(blob); return 'blob:test/1' }
  URL.revokeObjectURL = (url) => { revoked.push(url) }
  t.teardown(() => {
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
  })
  t.is(display.urlFromBytes(new Uint8Array([1, 2]), 'image/webp'), 'blob:test/1')
  t.is(made[0].type, 'image/webp')
  t.is(made[0].size, 2)
  display.revokeUrl('blob:test/1')
  t.alike(revoked, ['blob:test/1'])
  URL.revokeObjectURL = () => { throw new Error('boom') }
  display.revokeUrl('blob:test/1')
  t.pass('a throwing revoke is swallowed')
})
