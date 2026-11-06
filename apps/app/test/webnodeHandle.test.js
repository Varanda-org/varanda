'use strict'

// src/client/webnode.native.js (the in-app web node's host handle) with
// expo-file-system, the passkey identity and ./native replaced by stubs (a
// module hook), driven by a mock request: photos go out as an upload-dir
// file named over the IPC (media.uploadFile, dm.putMedia) and come back as a
// read-dir file named by media.readFile, which the handle releases on
// eviction, lock, sign-out and reset. src/client/browser.js mediaOf gives
// the web facade the same shape, with the bytes in the page.
const { register } = require('node:module')
const test = require('brittle')

const fileSystem = `
const box = globalThis.__fs = globalThis.__fs || { files: new Map(), deleted: [] }
export const Paths = { document: { uri: 'file:///stub/Documents/' }, cache: { uri: 'file:///stub/Caches/' } }
export class Directory {
  constructor (a, b) { this.uri = b === undefined ? a : a.uri + b + '/' }
  get exists () { return true }
  create () {}
  list () {
    const out = []
    for (const uri of box.files.keys()) {
      if (uri.startsWith(this.uri) && !uri.slice(this.uri.length).includes('/')) out.push(new File(uri))
    }
    return out
  }
}
export class File {
  constructor (a, b) { this.uri = b === undefined ? a : a.uri + b }
  get name () { return this.uri.slice(this.uri.lastIndexOf('/') + 1) }
  get exists () { return box.files.has(this.uri) }
  create () { if (box.files.has(this.uri)) throw new Error('exists'); box.files.set(this.uri, new Uint8Array(0)) }
  write (bytes) { box.files.set(this.uri, new Uint8Array(bytes)) }
  delete () { box.files.delete(this.uri); box.deleted.push(this.uri) }
}
`
const identity = `
const box = globalThis.__identity = globalThis.__identity || { calls: [] }
export function createNativeIdentity () {
  const call = (name) => async () => { box.calls.push(name) }
  return { resume () {}, status: call('status'), unlock: call('unlock'), complete: call('complete'), lock: call('lock'), signOut: call('signOut'), reset: call('reset') }
}
`
const native = `
import { Directory, Paths } from 'expo-file-system'
export function uploadDirectory () { return new Directory(Paths.cache, 'varanda-upload') }
`
const audio = `
export function sweepVoiceCache () { globalThis.__voiceSweeps = (globalThis.__voiceSweeps || 0) + 1 }
`
const installation = `
export function rpIdOf () { return 'varanda.test' }
export function installationOrigin () { return 'https://varanda.test' }
`
// @varanda/rpc is CommonJS and Node cannot see all its named exports (Metro
// does): the real package, re-exported by name.
const rpc = `
import { createRequire } from 'node:module'
const rpc = createRequire(${JSON.stringify(__filename)})('@varanda/rpc')
export const { createClient, parseMessage, EVENTS, MAX_MESSAGE, mediaBounds } = rpc
`
const hooks = `
const url = (src) => 'data:text/javascript,' + encodeURIComponent(src)
const stubs = {
  'expo-file-system': url(${JSON.stringify(fileSystem)}),
  '../identity': url(${JSON.stringify(identity)}),
  './native': url(${JSON.stringify(native)}),
  '../media/audio': url(${JSON.stringify(audio)}),
  '../installation': url(${JSON.stringify(installation)}),
  '@varanda/rpc': url(${JSON.stringify(rpc)})
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

const load = () => import('../src/client/webnode.native.js')
const box = () => globalThis.__fs
const UPLOAD = 'file:///stub/Caches/varanda-upload/'
const READS = 'file:///stub/Documents/varanda/media-read/'
const NAME_RE = /^[0-9a-f]{32}\.bin$/

function mockRequest (answer) {
  const calls = []
  const request = async (method, params) => {
    calls.push({ method, params, file: params && params.name ? box().files.get(UPLOAD + params.name) : undefined })
    return answer(method, params)
  }
  return { request, calls }
}

test('upload writes an upload-dir file and names it, sealed passes through', async (t) => {
  const { webNodeHandle } = await load()
  const descriptor = { core: 'ab'.repeat(32) }
  const { request, calls } = mockRequest((method) => method === 'identity.status' ? {} : descriptor)
  const { media } = webNodeHandle(request)
  const bytes = new Uint8Array([1, 2, 3])
  const progress = []
  t.is(await media.upload({ bytes, mime: 'image/jpeg', width: 4, height: 3, onProgress: (v) => progress.push(v) }), descriptor)
  const up = calls.find((c) => c.method === 'media.uploadFile')
  t.ok(NAME_RE.test(up.params.name), 'only a generated name crosses the IPC')
  t.alike(up.params, { name: up.params.name, mime: 'image/jpeg', width: 4, height: 3 }, 'no bytes, no path, no sealed when absent')
  t.alike(up.file, bytes, 'the file held the bytes when the worklet was asked')
  t.alike(progress, [0.25, 1])

  await media.upload({ bytes, mime: 'image/png', width: 1, height: 1, sealed: true })
  const sealed = calls.filter((c) => c.method === 'media.uploadFile')[1]
  t.is(sealed.params.sealed, true, 'sealed reaches the worklet')
  await media.upload({ bytes, mime: 'image/png', width: 1, height: 1, sealed: 'yes' })
  t.absent('sealed' in calls.filter((c) => c.method === 'media.uploadFile')[2].params, 'only true seals')
})

test('putDm goes through dm.putMedia; a failure deletes the file here', async (t) => {
  const { webNodeHandle } = await load()
  const item = { id: 'cd'.repeat(32) }
  let fail = false
  const { request, calls } = mockRequest((method) => {
    if (method === 'dm.putMedia' && fail) throw Object.assign(new Error('x'), { code: 'USAGE' })
    return item
  })
  const { media } = webNodeHandle(request)
  t.is(await media.putDm({ bytes: new Uint8Array([9]), mime: 'image/webp', width: 2, height: 2 }), item)
  const put = calls.find((c) => c.method === 'dm.putMedia')
  t.alike(put.params, { name: put.params.name, mime: 'image/webp', width: 2, height: 2 })
  t.alike(put.file, new Uint8Array([9]))

  fail = true
  await t.exception(media.putDm({ bytes: new Uint8Array([9]), mime: 'image/webp', width: 2, height: 2 }))
  const failed = calls.filter((c) => c.method === 'dm.putMedia')[1]
  t.absent(box().files.has(UPLOAD + failed.params.name), 'a failed put leaves no upload file')
  await t.exception.all(media.putDm({ bytes: new Uint8Array(0), mime: 'image/webp', width: 2, height: 2 }), /mídia inválida/)
})

test('read names a read-dir file and the handle releases it', async (t) => {
  const mod = await load()
  const names = []
  const { request, calls } = mockRequest((method) => {
    if (method !== 'media.readFile') return {}
    const name = String(names.length).padStart(32, '0') + '.bin'
    names.push(name)
    box().files.set(READS + name, new Uint8Array([7]))
    return { name, mime: 'image/jpeg', w: 10, h: 20 }
  })
  const handle = mod.webNodeHandle(request)
  const { media, identity } = handle

  const dmRef = { kind: 'dm', from: 'ab'.repeat(32), id: 'cd'.repeat(16), index: 1, extra: 'dropped' }
  const a = await media.read(dmRef)
  t.alike(a, { uri: READS + names[0], mime: 'image/jpeg', w: 10, h: 20 })
  t.alike(calls.at(-1).params, { kind: 'dm', from: 'ab'.repeat(32), id: 'cd'.repeat(16), index: 1 }, 'only the dm fields cross')

  const item = { core: 'ab'.repeat(32) }
  const b = await media.read({ kind: 'group', diary: 'ef'.repeat(32), item })
  t.alike(calls.at(-1).params, { kind: 'group', diary: 'ef'.repeat(32), item })
  t.is(b.uri, READS + names[1])

  media.forgetReadFile(names[0])
  t.absent(box().files.has(READS + names[0]), 'eviction deletes the file')
  t.ok(box().files.has(READS + names[1]))
  media.forgetReadFile('../escape.bin')
  t.absent(box().deleted.includes(READS + '../escape.bin'), 'a foreign name is ignored')

  await identity.lock()
  t.absent(box().files.has(READS + names[1]), 'lock deletes every read file')

  await media.read(dmRef)
  await identity.signOut()
  t.absent(box().files.has(READS + names[2]), 'sign-out deletes them')
  await media.read(dmRef)
  await identity.reset()
  t.absent(box().files.has(READS + names[3]), 'reset deletes them')
  await media.read(dmRef)
  mod.clearReadFiles()
  t.absent(box().files.has(READS + names[4]), 'the cache can clear them all')
  t.alike(globalThis.__identity.calls.filter((c) => c !== 'status'), ['lock', 'signOut', 'reset'])
})

test('creating the handle sweeps leftover read files, nothing else', async (t) => {
  const { webNodeHandle } = await load()
  const leftover = READS + 'ab'.repeat(16) + '.bin'
  const others = [READS + 'notes.txt', READS + 'AB'.repeat(16) + '.bin', UPLOAD + 'cd'.repeat(16) + '.bin']
  box().files.set(leftover, new Uint8Array([1]))
  for (const uri of others) box().files.set(uri, new Uint8Array([2]))
  let asked = false
  webNodeHandle(async () => { asked = true; return {} })
  t.absent(box().files.has(leftover), 'a crash leftover is deleted')
  for (const uri of others) t.ok(box().files.has(uri), 'kept: ' + uri)
  t.absent(asked, 'swept before any request')
  for (const uri of others) box().files.delete(uri)
})

test('creating the handle sweeps a voice recording left in the cache', async (t) => {
  const { webNodeHandle } = await load()
  const before = globalThis.__voiceSweeps || 0
  let asked = false
  webNodeHandle(async () => { asked = true; return {} })
  t.is(globalThis.__voiceSweeps, before + 1, 'sweepVoiceCache runs once per handle')
  t.absent(asked, 'before any request')
})

test('read refuses an answer that is not a read-dir name', async (t) => {
  const { webNodeHandle } = await load()
  for (const name of ['../x.bin', 'AB'.repeat(16) + '.bin', '/abs/' + 'a'.repeat(32) + '.bin', null]) {
    const { media } = webNodeHandle(async () => ({ name, mime: 'image/jpeg', w: 1, h: 1 }))
    await t.exception(media.read({ kind: 'dm', from: 'ab'.repeat(32), id: 'cd'.repeat(16), index: 0 }), String(name))
  }
  const { media } = webNodeHandle(async () => ({}))
  await t.exception.all(media.read(null), /mídia inválida/)
})

test('web: mediaOf gives the facade the same shape, bytes in the page', async (t) => {
  const { mediaOf } = await import('../src/client/browser.js')
  t.is(mediaOf(null), null)
  t.is(mediaOf({}), null, 'no facade method, no capability')
  const calls = []
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 5, 0, 0, 0, 0])
  const facade = {
    upload: async (args) => { calls.push(['upload', args]); return { core: 'd' } },
    putDm: async (args) => { calls.push(['putDm', args]); return { id: 'i' } },
    readDm: async (args) => { calls.push(['readDm', args]); return { bytes: gif, mime: 'image/gif' } },
    readGroup: async (args) => { calls.push(['readGroup', args]); return { bytes: new Uint8Array([1]), mime: 'image/png', w: 8, h: 9 } }
  }
  const media = mediaOf(facade)
  const bytes = new Uint8Array([1])
  t.alike(await media.upload({ bytes, mime: 'image/png', width: 1, height: 1, sealed: true }), { core: 'd' })
  t.is(calls[0][1].sealed, true, 'sealed reaches the node')
  t.is(calls[0][1].bytes, bytes, 'the bytes pass directly')
  t.alike(await media.putDm({ bytes, mime: 'image/png', width: 1, height: 1 }), { id: 'i' })
  const dm = await media.read({ kind: 'dm', from: 'a', id: 'b', index: 0 })
  t.alike(calls.at(-1), ['readDm', { from: 'a', id: 'b', index: 0 }])
  t.is(dm.bytes, gif)
  t.is(dm.mime, 'image/gif')
  t.absent('uri' in dm)
  const g = await media.read({ kind: 'group', diary: 'd', item: { x: 1 } })
  t.alike(calls.at(-1), ['readGroup', { diary: 'd', item: { x: 1 } }])
  t.alike({ w: g.w, h: g.h }, { w: 8, h: 9 })

  const uploadOnly = mediaOf({ upload: facade.upload })
  t.alike(Object.keys(uploadOnly), ['upload'], 'a missing facade method is an absent capability')
  const dmOnly = mediaOf({ readDm: facade.readDm })
  await t.exception.all(dmOnly.read({ kind: 'group', diary: 'd', item: {} }), /mídia inválida/)
})

test('a voice note keeps its duration and kind across the IPC; an image request keeps its exact keys', async (t) => {
  const { webNodeHandle } = await load()
  const { request, calls } = mockRequest(() => ({ ok: true }))
  const { media } = webNodeHandle(request)
  await media.putDm({ bytes: new Uint8Array([1]), mime: 'audio/mp4', width: 0, height: 0, ms: 1500, kind: 'voice' })
  await media.upload({ bytes: new Uint8Array([2]), mime: 'audio/mp4', width: 0, height: 0, ms: 1500, kind: 'voice', sealed: true })
  await media.upload({ bytes: new Uint8Array([3]), mime: 'image/png', width: 2, height: 2, ms: 9, kind: 'other' })
  const put = calls.find((c) => c.method === 'dm.putMedia')
  const ups = calls.filter((c) => c.method === 'media.uploadFile')
  t.alike(put.params, { name: put.params.name, mime: 'audio/mp4', width: 0, height: 0, ms: 1500, kind: 'voice' })
  t.alike(ups[0].params, { name: ups[0].params.name, mime: 'audio/mp4', width: 0, height: 0, ms: 1500, kind: 'voice', sealed: true })
  t.alike(ups[1].params, { name: ups[1].params.name, mime: 'image/png', width: 2, height: 2 })
})
