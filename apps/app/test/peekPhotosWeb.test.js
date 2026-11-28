'use strict'

// src/media/peekPhotos.web.js: without IndexedDB the store is off, and source
// pins for the database, its one-transaction writes and onversionchange.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '../src/media/peekPhotos.web.js'), 'utf8')

const B = 'b2'.repeat(32)
const CORE = 'c3'.repeat(32)
const ME = { origin: 'https://bora.varanda.app', association: 'f6'.repeat(32), owner: B }
const desc = () => ({ core: CORE, mime: 'image/jpeg', start: 1, blocks: 1, bytes: 4, sha256: 'e5'.repeat(32), width: 10, height: 20 })

test('without indexedDB every call resolves null or false', async (t) => {
  t.is(globalThis.indexedDB, undefined, 'Node has no indexedDB')
  const { peekPhotos, backend } = await import('../src/media/peekPhotos.web.js')
  t.is(await peekPhotos.bind(ME), false)
  t.is(await peekPhotos.read('peekPosts', B, desc()), null)
  t.is(await peekPhotos.put('peekPosts', B, desc(), new Uint8Array(4)), false)
  t.is(await peekPhotos.dropAuthors([B]), false)
  t.is(await peekPhotos.dropRanges([{ core: CORE, start: 0, blocks: 2 }]), false)
  t.is(await peekPhotos.retain(['peekPosts'], []), false)
  t.is(await peekPhotos.wipe(), false)
  t.is(await backend.getBinding(), null)
  t.alike(await backend.list(), [])
  t.is(await backend.get('x'), null)
  t.is(await backend.setBinding(ME), false)
  t.is(await backend.put({ name: 'x' }, new Uint8Array(1)), false)
  t.is(await backend.remove(['x']), false)
  t.is(await backend.clear(), false)
})

test('without indexedDB the copy store is off too', async (t) => {
  const { copyPhotos, copyBackend } = await import('../src/media/peekPhotos.web.js')
  t.is(await copyPhotos.bind(ME), false)
  t.is(await copyPhotos.read('copyPosts', B, desc()), null)
  t.is(await copyPhotos.put('copyPosts', B, desc(), new Uint8Array(4)), false)
  t.is(await copyPhotos.readThumb(B, 'e5'.repeat(32)), null)
  t.is(await copyPhotos.putThumb(B, 'e5'.repeat(32), new Uint8Array(4), 'image/jpeg'), false)
  t.is(await copyPhotos.retainThumbs([]), false)
  t.is(await copyPhotos.wipe(), false)
  t.is(await copyBackend.clear(), false)
})

test('each backend opens its own database', async (t) => {
  const { createBackend } = await import('../src/media/peekPhotos.web.js')
  const opened = []
  const fakeDb = (name) => ({
    objectStoreNames: { contains: () => true },
    transaction () {
      const tx = { objectStore: () => ({ get: () => ({}), getAll: () => ({}), clear () {}, put () {}, delete () {} }) }
      setTimeout(() => tx.oncomplete(), 0)
      return tx
    },
    close () {},
    name
  })
  globalThis.indexedDB = {
    open (name, version) {
      opened.push([name, version])
      const req = {}
      setTimeout(() => { req.result = fakeDb(name); req.onsuccess() }, 0)
      return req
    }
  }
  t.teardown(() => { delete globalThis.indexedDB })
  t.is(await createBackend().clear(), true)
  t.is(await createBackend('varanda-copy-photos').clear(), true)
  t.is(await createBackend('varanda-kept-photos').clear(), true)
  t.alike(opened, [['varanda-peek-photos', 1], ['varanda-copy-photos', 1], ['varanda-kept-photos', 1]], 'the name is a parameter; the peek database is the default')
})

test('native sibling answers nothing', async (t) => {
  const native = await import('../src/media/peekPhotos.native.js')
  const web = await import('../src/media/peekPhotos.web.js')
  for (const store of ['peekPhotos', 'copyPhotos']) {
    t.alike(Object.keys(native[store]).sort(), Object.keys(web[store]).sort(), store + ': same methods')
    t.is(await native[store].bind(ME), false)
    t.is(await native[store].read('peekPosts', B, desc()), null)
    t.is(await native[store].put('peekPosts', B, desc(), new Uint8Array(4)), false)
    t.is(await native[store].readThumb(B, 'e5'.repeat(32)), null)
    t.is(await native[store].putThumb(B, 'e5'.repeat(32), new Uint8Array(4), 'image/jpeg'), false)
    t.is(await native[store].retainThumbs([]), false)
    t.is(await native[store].wipe(), false)
  }
})

test('source pins: database, stores, one-transaction put and clear, onversionchange', (t) => {
  t.ok(SRC.includes("const DB_NAME = 'varanda-peek-photos'"), 'database name')
  t.ok(SRC.includes("const COPY_DB_NAME = 'varanda-copy-photos'"), 'copy database name')
  t.ok(SRC.includes('export function createBackend (name = DB_NAME) {'), 'the name is a parameter, the peek database by default')
  t.ok(SRC.includes('idb.open(name, DB_VERSION)'))
  t.ok(SRC.includes('export const backend = createBackend()'))
  t.ok(SRC.includes('export const copyBackend = createBackend(COPY_DB_NAME)'))
  t.ok(/export const copyPhotos = createPeekPhotoStore\(\{\s*backend: copyBackend,\s*kinds: COPY_PHOTO_KINDS,\s*maxBytes: COPY_PHOTO_MAX_BYTES,\s*maxFiles: COPY_PHOTO_MAX_FILES,\s*maxAgeMs: COPY_PHOTO_MAX_AGE_MS\s*\}\)/.test(SRC), 'the copy store: its own kinds and caps')
  t.ok(SRC.includes('const DB_VERSION = 1'), 'version 1')
  t.ok(SRC.includes("createObjectStore(META, { keyPath: 'name' })"), 'meta keyed by name')
  t.ok(/inTx\(\[META, BYTES, BINDING\], 'readwrite', \(tx, set\) => \{\s*const req = tx\.objectStore\(BINDING\)\.get\(BINDING_KEY\)\s*req\.onsuccess = \(\) => \{\s*if \(!sameBinding\(req\.result, binding\)\) return set\(false\)\s*tx\.objectStore\(META\)\.put\(row\)\s*tx\.objectStore\(BYTES\)\.put\(buf, row\.name\)/.test(SRC), 'row and bytes in one transaction, after checking the stored binding in it')
  t.ok(SRC.includes('return !r.off && r.value === true'), 'a refused put resolves false')
  t.ok(/inTx\(\[META, BYTES, BINDING\], 'readwrite', \(tx\) => \{\s*tx\.objectStore\(META\)\.clear\(\)\s*tx\.objectStore\(BYTES\)\.clear\(\)\s*tx\.objectStore\(BINDING\)\.clear\(\)/.test(SRC), 'clear empties the three stores in one transaction')
  t.ok(/db\.onversionchange = \(\) => \{\s*try \{ db\.close\(\) \} catch \{\}/.test(SRC), 'onversionchange closes the connection')
  t.ok(/\} catch \{[^}]*try \{ event\.target\.transaction\.abort\(\) \} catch \{\}/.test(SRC), 'a failed store creation aborts the upgrade')
  t.ok(/if \(!\[META, BYTES, BINDING\]\.every\(\(name\) => db\.objectStoreNames\.contains\(name\)\)\) \{\s*try \{ db\.close\(\) \} catch \{\}\s*return resolve\(null\)/.test(SRC), 'a missing store fails the open')
  t.ok(SRC.includes('export const peekPhotos = createPeekPhotoStore({ backend })'), 'exports the store')
  t.absent(/^import .*(react|indexeddb)/m.test(SRC), 'no extra imports')
})
