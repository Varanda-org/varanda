'use strict'

const test = require('brittle')
const load = () => import('../src/groupImage.js')
const AUTHOR = 'ab'.repeat(32)
const GROUP = 'cd'.repeat(32)
const image = (over = {}) => ({
  core: 'ef'.repeat(32),
  mime: 'image/jpeg',
  start: 1,
  blocks: 1,
  bytes: 1000,
  sha256: '12'.repeat(32),
  width: 512,
  height: 512,
  ...over
})

test('group images accept only bounded square JPEG avatar descriptors', async (t) => {
  const { validGroupImage } = await load()
  t.ok(validGroupImage(image()))
  t.ok(validGroupImage(image({ blocks: 8, bytes: 262144 })))
  for (const value of [null, undefined, [], {}, 'image', 1]) t.absent(validGroupImage(value))
  for (const over of [
    { mime: 'image/webp' }, { mime: 'image/png' }, { width: 511 }, { height: 513 },
    { blocks: 9, bytes: 262145 }, { bytes: 0 }, { blocks: 8, bytes: 262145 },
    { start: 0 }, { core: 'bad' }, { sha256: 'bad' }, { extra: true }
  ]) t.absent(validGroupImage(image(over)), JSON.stringify(over))
})

test('pictureProps copies the descriptor and requires its own media author', async (t) => {
  const { pictureProps } = await load()
  const row = { group: GROUP, visibility: 'public', image: image(), imageAuthor: AUTHOR }
  const props = pictureProps(row)
  t.alike(props, { picture: row.image, mediaAuthor: AUTHOR })
  t.not(props.picture, row.image, 'no peer object is retained')
  t.alike(pictureProps({ community: GROUP, image: row.image, imageAuthor: AUTHOR }), props)
  const empty = { picture: null, mediaAuthor: null }
  for (const value of [null, undefined, {}, [], 'x']) t.alike(pictureProps(value), empty)
  for (const value of [undefined, null, '', 'bad', AUTHOR.toUpperCase(), 1, {}]) {
    t.alike(pictureProps({ ...row, imageAuthor: value }), empty)
  }
  t.alike(pictureProps({ ...row, image: null }), empty)
  t.alike(pictureProps({ ...row, image: image({ mime: 'image/webp' }) }), empty)
  t.alike(pictureProps({ ...row, visibility: 'private' }), empty)
})

test('canEdit requires the creator, a public root and an upload capability', async (t) => {
  const { canEdit } = await load()
  const node = { media: { upload () {} } }
  const info = { group: GROUP, role: 'creator', visibility: 'public', rootHere: true }
  t.ok(canEdit(info, node))
  const community = { community: GROUP, role: 'creator', rootHere: true, rootAuthority: true, repair: false }
  t.ok(canEdit(community, node), 'the creating device can write the community root')
  t.ok(canEdit({ ...community, authorityHere: false }, node), 'generation retirement does not end root authority')
  t.ok(canEdit({ ...community, rootHere: false, rootAuthority: false, repair: true }, node), 'a live repair writer can edit')
  for (const rootHere of [false, undefined]) {
    t.absent(canEdit({ ...info, rootHere, authorityHere: true }, node), 'a group needs this device to own the uncut root')
    t.absent(canEdit({ ...community, rootHere }, node), 'community creator on another device cannot edit')
  }
  for (const rootAuthority of [false, undefined]) {
    t.absent(canEdit({ ...community, rootAuthority, authorityHere: true }, node), 'holding the community root alone grants nothing')
  }
  for (const value of [null, undefined, {}, [], 'x']) t.absent(canEdit(value, node))
  for (const role of [undefined, null, 'admin', 'member', 'left', 'banned', 'pending']) {
    t.absent(canEdit({ ...info, role }, node))
  }
  for (const visibility of [undefined, null, '', 'private', 'unknown']) {
    t.absent(canEdit({ ...info, community: GROUP, visibility }, node), 'a community parent does not make a group public')
  }
  for (const community of [undefined, null, '', 'bad', 1]) t.absent(canEdit({ community, role: 'creator' }, node))
  t.absent(canEdit({ community: GROUP, role: 'creator', visibility: 'private' }, node))
  for (const value of [null, undefined, {}, { media: null }, { media: {} }, { media: { upload: true } }]) {
    t.absent(canEdit(info, value))
  }
})

test('group image words are shared pt-BR labels and errors', async (t) => {
  const { words } = await load()
  t.alike(words, {
    add: 'Adicionar imagem',
    change: 'Trocar imagem',
    remove: 'Remover imagem',
    title: 'Imagem',
    save: 'Salvar',
    cancel: 'Cancelar',
    failed: 'Não foi possível salvar a imagem. Tente de novo.',
    uncertain: 'Não foi possível confirmar a alteração. Confira a imagem antes de tentar de novo.'
  })
  t.ok(Object.isFrozen(words))
})
