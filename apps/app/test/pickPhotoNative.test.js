'use strict'

// src/pickPhoto.native.js with expo-image-picker, expo-image-manipulator and
// expo-file-system replaced by stubs (a module hook), so no native module is
// loaded. The stubs keep their state on globalThis for the tests to drive.
const { register } = require('node:module')
const test = require('brittle')

const picker = `
const box = globalThis.__pick = globalThis.__pick || { result: null, options: [], deleted: [] }
export async function launchImageLibraryAsync () { return box.result }
`
const manipulator = `
const box = globalThis.__pick = globalThis.__pick || { result: null, options: [], deleted: [] }
export const SaveFormat = { JPEG: 'jpeg', PNG: 'png' }
export async function manipulateAsync (uri, actions, options) {
  box.options.push(options)
  if (box.throws) throw new Error('decode failed')
  return { uri: 'file:///cache/out.x' }
}
`
const fileSystem = `
const box = globalThis.__pick = globalThis.__pick || { result: null, options: [], deleted: [] }
export const Paths = { cache: { uri: 'file:///cache/' } }
export class File {
  constructor (uri) { this.uri = uri }
  get exists () { return true }
  get size () { return box.size === undefined ? 3 : box.size }
  async bytes () { box.read = true; return new Uint8Array(3) }
  delete () { box.deleted.push(this.uri) }
}
`
const hooks = `
const stubs = {
  'expo-image-picker': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(picker)}),
  'expo-image-manipulator': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(manipulator)}),
  'expo-file-system': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(fileSystem)})
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

const load = () => import('../src/pickPhoto.native.js')
const PICKED = 'file:///cache/ImagePicker/in.img'
const OUT = 'file:///cache/out.x'

function reset (result) {
  globalThis.__pick = globalThis.__pick || {}
  globalThis.__pick.result = result
  globalThis.__pick.options = []
  globalThis.__pick.deleted = []
  globalThis.__pick.size = undefined
  globalThis.__pick.read = false
  globalThis.__pick.throws = false
}
const box = () => globalThis.__pick

test('a PNG is saved again as PNG', async (t) => {
  const { pickPhoto } = await load()
  reset({ canceled: false, assets: [{ uri: PICKED, mimeType: 'image/png' }] })
  const out = await pickPhoto()
  t.is(box().options.length, 1)
  t.is(box().options[0].format, 'png')
  t.is(out.type, 'image/png')
  t.is(out.size, 3)
  t.is(out.bytes.byteLength, 3)
  t.alike(box().deleted.slice().sort(), [OUT, PICKED].sort(), 'both temporary files deleted')
})

test('a PNG with no mimeType is told by its extension', async (t) => {
  const { pickPhoto } = await load()
  reset({ canceled: false, assets: [{ uri: 'file:///cache/ImagePicker/SCAN.PNG' }] })
  const out = await pickPhoto()
  t.is(box().options[0].format, 'png')
  t.is(out.type, 'image/png')
  t.alike(box().deleted.slice().sort(), [OUT, 'file:///cache/ImagePicker/SCAN.PNG'].sort())
})

test('a GIF, which may carry transparency, is saved as PNG', async (t) => {
  const { pickPhoto } = await load()
  reset({ canceled: false, assets: [{ uri: PICKED, mimeType: 'image/gif' }] })
  const out = await pickPhoto()
  t.is(box().options[0].format, 'png')
  t.is(out.type, 'image/png')
})

test('a result over 10 MiB is refused before it is read', async (t) => {
  const { pickPhoto } = await load()
  reset({ canceled: false, assets: [{ uri: PICKED, mimeType: 'image/jpeg' }] })
  box().size = 10 * 1024 * 1024 + 1
  const out = await pickPhoto()
  t.is(out, false, 'a failure, not a cancel')
  t.is(box().read, false, 'bytes never read')
  t.alike(box().deleted.slice().sort(), [OUT, PICKED].sort(), 'both temporary files deleted')
})

test('an empty result is a failure', async (t) => {
  const { pickPhoto } = await load()
  reset({ canceled: false, assets: [{ uri: PICKED, mimeType: 'image/jpeg' }] })
  box().size = 0
  t.is(await pickPhoto(), false)
  t.is(box().read, false, 'bytes never read')
  t.alike(box().deleted.slice().sort(), [OUT, PICKED].sort())
})

test('a photo that cannot be decoded is a failure, not a cancel', async (t) => {
  const { pickPhoto } = await load()
  reset({ canceled: false, assets: [{ uri: PICKED, mimeType: 'image/jpeg' }] })
  box().throws = true
  t.is(await pickPhoto(), false)
  t.is(box().read, false)
  t.alike(box().deleted, [PICKED], 'the picked copy deleted')
})

test('a WebP, which may carry transparency, is saved as PNG', async (t) => {
  const { pickPhoto } = await load()
  reset({ canceled: false, assets: [{ uri: PICKED, mimeType: 'image/webp' }] })
  const out = await pickPhoto()
  t.is(box().options[0].format, 'png')
  t.is(out.type, 'image/png')
  t.alike(box().deleted.slice().sort(), [OUT, PICKED].sort())
})

test('a JPEG is saved again as JPEG at 0.92', async (t) => {
  const { pickPhoto } = await load()
  reset({ canceled: false, assets: [{ uri: PICKED, mimeType: 'image/jpeg' }] })
  const out = await pickPhoto()
  t.is(box().options[0].format, 'jpeg')
  t.is(box().options[0].compress, 0.92)
  t.is(out.type, 'image/jpeg')
  t.is(out.size, 3)
  t.alike(box().deleted.slice().sort(), [OUT, PICKED].sort())
})

test('a HEIC is saved as JPEG at 0.92', async (t) => {
  const { pickPhoto } = await load()
  reset({ canceled: false, assets: [{ uri: 'file:///cache/ImagePicker/in.heic', mimeType: 'image/heic' }] })
  const out = await pickPhoto()
  t.is(box().options[0].format, 'jpeg')
  t.is(box().options[0].compress, 0.92)
  t.is(out.type, 'image/jpeg')
  t.alike(box().deleted.slice().sort(), [OUT, 'file:///cache/ImagePicker/in.heic'].sort())
})

test('a canceled pick returns null', async (t) => {
  const { pickPhoto } = await load()
  reset({ canceled: true, assets: null })
  t.is(await pickPhoto(), null)
  t.is(box().options.length, 0, 'nothing re-encoded')
  t.alike(box().deleted, [], 'nothing to delete')
})
