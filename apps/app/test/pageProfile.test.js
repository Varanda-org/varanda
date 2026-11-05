'use strict'

const test = require('brittle')

const load = () => import('../src/pageProfile.js')
const PHOTO = { mime: 'image/jpeg', ref: 'x' }
const PHOTO2 = { mime: 'image/jpeg', ref: 'y' }

test('untouched fields come from the fresh read, not the first snapshot', async (t) => {
  const { mergeProfile, profileOp } = await load()
  const base = { name: 'Padaria', bio: 'pão', avatar: PHOTO }
  const fresh = { name: 'Padaria Nova', bio: 'pão quente', avatar: PHOTO2 }
  const merged = mergeProfile({ base, form: { name: 'Padaria', bio: 'pão e café' }, draft: undefined, fresh })
  t.alike(merged, { name: 'Padaria Nova', bio: 'pão e café', avatar: PHOTO2 })
  t.alike(profileOp(merged), { name: 'Padaria Nova', bio: 'pão e café', avatar: PHOTO2 })
})

test('an edited name wins; a removed photo stays removed', async (t) => {
  const { mergeProfile, profileOp } = await load()
  const base = { name: 'A', bio: '', avatar: PHOTO }
  const fresh = { name: 'B', bio: 'nova', avatar: PHOTO }
  const merged = mergeProfile({ base, form: { name: 'C', bio: '' }, draft: null, fresh })
  t.alike(merged, { name: 'C', bio: 'nova', avatar: null })
  t.alike(profileOp(merged), { name: 'C', bio: 'nova' })
})

test('a fresh profile without a photo never brings the old one back', async (t) => {
  const { mergeProfile, profileOp } = await load()
  const merged = mergeProfile({ base: { name: 'A', bio: '', avatar: PHOTO }, form: { name: 'A', bio: 'x' }, draft: undefined, fresh: { name: 'A', bio: '', avatar: null } })
  t.is(merged.avatar, null)
  t.is(Object.hasOwn(profileOp(merged), 'avatar'), false)
})

test('no fresh read: no save', async (t) => {
  const { mergeProfile, FRESH_FAILED } = await load()
  t.is(FRESH_FAILED, 'Não deu para conferir o perfil atual. Tente de novo.')
  for (const fresh of [null, undefined, {}, { name: 1 }]) {
    try {
      mergeProfile({ base: { name: 'A', bio: '' }, form: { name: 'B', bio: '' }, draft: undefined, fresh })
      t.fail('did not throw')
    } catch (err) {
      t.is(err.message, FRESH_FAILED)
    }
  }
})
