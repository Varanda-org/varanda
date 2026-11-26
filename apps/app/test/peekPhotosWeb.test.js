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

test('native sibling answers nothing', async (t) => {
  const { peekPhotos } = await import('../src/media/peekPhotos.native.js')
  const web = await import('../src/media/peekPhotos.web.js')
  t.alike(Object.keys(peekPhotos).sort(), Object.keys(web.peekPhotos).sort(), 'same methods')
  t.is(await peekPhotos.bind(ME), false)
  t.is(await peekPhotos.read('peekPosts', B, desc()), null)
  t.is(await peekPhotos.put('peekPosts', B, desc(), new Uint8Array(4)), false)
  t.is(await peekPhotos.wipe(), false)
})

test('source pins: database, stores, one-transaction put and clear, onversionchange', (t) => {
  t.ok(SRC.includes("const DB_NAME = 'varanda-peek-photos'"), 'database name')
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
