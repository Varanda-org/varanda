'use strict'

// What one Salvar in Perfil sends (src/profileSave.js): the avatar key only
// for a real change, one upload for a new photo, the plain first profile
// before an upload, and the uncertain re-read check.
const test = require('brittle')

const load = () => import('../src/profileSave.js')

const desc = (fill) => ({
  core: fill.repeat(64),
  mime: 'image/webp',
  start: 0,
  blocks: 1,
  bytes: 1000,
  sha256: fill.repeat(64),
  width: 512,
  height: 512
})
const A = desc('a')
const B = desc('b')
const encoded = { bytes: new Uint8Array([1]), mime: 'image/webp', width: 512, height: 512 }

test('planSave: no photo change sends no avatar key', async (t) => {
  const { planSave } = await load()
  for (const avatar of [null, A]) {
    const plan = planSave({ name: 'Ana', bio: '', draft: undefined, current: { name: 'Ana', avatar } })
    t.alike(plan, { firstPlain: false, needsUpload: false, params: { name: 'Ana', bio: '' } })
    t.absent(Object.hasOwn(plan.params, 'avatar'))
  }
})

test('planSave: removal sends null only when a photo exists', async (t) => {
  const { planSave } = await load()
  const withPhoto = planSave({ name: 'Ana', bio: 'oi', draft: null, current: { name: 'Ana', avatar: A } })
  t.alike(withPhoto.params, { name: 'Ana', bio: 'oi', avatar: null })
  t.is(withPhoto.needsUpload, false)
  const without = planSave({ name: 'Ana', bio: 'oi', draft: null, current: { name: 'Ana', avatar: null } })
  t.absent(Object.hasOwn(without.params, 'avatar'))
  const unknown = planSave({ name: 'Ana', bio: 'oi', draft: null, current: null })
  t.absent(Object.hasOwn(unknown.params, 'avatar'))
})

test('planSave: a new photo needs one upload, a kept descriptor none', async (t) => {
  const { planSave } = await load()
  const fresh = planSave({ name: 'Ana', bio: '', draft: { encoded, previewUrl: 'blob:x', descriptor: null }, current: { name: 'Ana', avatar: A } })
  t.is(fresh.needsUpload, true)
  t.is(fresh.firstPlain, false)
  t.absent(Object.hasOwn(fresh.params, 'avatar'))

  const uploaded = planSave({ name: 'Ana', bio: '', draft: { encoded, previewUrl: 'blob:x', descriptor: B }, current: { name: 'Ana', avatar: A } })
  t.is(uploaded.needsUpload, false)
  t.alike(uploaded.params, { name: 'Ana', bio: '', avatar: B })

  const same = planSave({ name: 'Ana', bio: '', draft: { encoded, previewUrl: 'blob:x', descriptor: { ...A } }, current: { name: 'Ana', avatar: A } })
  t.is(same.needsUpload, false)
  t.absent(Object.hasOwn(same.params, 'avatar'))
})

test('planSave: a first profile with a photo to upload goes plain first', async (t) => {
  const { planSave } = await load()
  const draft = { encoded, previewUrl: 'blob:x', descriptor: null }
  for (const current of [null, undefined, { avatar: null }, { name: '', avatar: null }]) {
    const plan = planSave({ name: 'Ana', bio: '', draft, current })
    t.is(plan.firstPlain, true)
    t.is(plan.needsUpload, true)
    t.alike(plan.params, { name: 'Ana', bio: '' })
  }
  // After the upload the same first save sends the photo in one profile.set.
  const after = planSave({ name: 'Ana', bio: '', draft: { ...draft, descriptor: A }, current: null })
  t.alike(after, { firstPlain: false, needsUpload: false, params: { name: 'Ana', bio: '', avatar: A } })
  // No photo, or an existing profile: never a plain step.
  t.is(planSave({ name: 'Ana', bio: '', draft: undefined, current: null }).firstPlain, false)
  t.is(planSave({ name: 'Ana', bio: '', draft, current: { name: 'Ana', avatar: null } }).firstPlain, false)
})

test('confirmSaved: name and bio', async (t) => {
  const { confirmSaved } = await load()
  const sent = { name: 'Ana', bio: '' }
  t.ok(confirmSaved(sent, { name: 'Ana' }))
  t.ok(confirmSaved(sent, { name: 'Ana', bio: '', avatar: A }))
  t.absent(confirmSaved(sent, { name: 'Bia', bio: '' }))
  t.absent(confirmSaved({ name: 'Ana', bio: 'oi' }, { name: 'Ana', bio: '' }))
  t.absent(confirmSaved(sent, null))
  t.absent(confirmSaved(sent, 'Ana'))
})

test('confirmSaved: photo set and removed', async (t) => {
  const { confirmSaved } = await load()
  const set = { name: 'Ana', bio: '', avatar: A }
  t.ok(confirmSaved(set, { name: 'Ana', bio: '', avatar: { ...A } }))
  t.absent(confirmSaved(set, { name: 'Ana', bio: '', avatar: B }))
  t.absent(confirmSaved(set, { name: 'Ana', bio: '', avatar: null }))
  t.absent(confirmSaved(set, { name: 'Ana', bio: '' }))

  const removed = { name: 'Ana', bio: '', avatar: null }
  t.ok(confirmSaved(removed, { name: 'Ana', bio: '', avatar: null }))
  t.ok(confirmSaved(removed, { name: 'Ana', bio: '' }))
  t.absent(confirmSaved(removed, { name: 'Ana', bio: '', avatar: A }))
})

test('planSave: a replaced photo uploads once and only then sends the new key', async (t) => {
  const { planSave } = await load()
  // A native draft keeps a file:// preview; the rules do not depend on it.
  const previewUrl = 'file:///cache/varanda-media/' + 'c'.repeat(32) + '.jpg'
  const current = { name: 'Ana', avatar: A }
  const before = planSave({ name: 'Ana', bio: 'oi', draft: { encoded, previewUrl, descriptor: null }, current })
  t.alike(before, { firstPlain: false, needsUpload: true, params: { name: 'Ana', bio: 'oi' } })
  const after = planSave({ name: 'Ana', bio: 'oi', draft: { encoded, previewUrl, descriptor: B }, current })
  t.alike(after, { firstPlain: false, needsUpload: false, params: { name: 'Ana', bio: 'oi', avatar: B } })
  // Name and bio edited with the photo kept: no avatar key, no upload.
  const kept = planSave({ name: 'Bia', bio: 'x', draft: undefined, current })
  t.alike(kept, { firstPlain: false, needsUpload: false, params: { name: 'Bia', bio: 'x' } })
})
