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
const privateImage = (over = {}) => ({
  core: 'ef'.repeat(32),
  mime: 'application/octet-stream',
  start: 1,
  blocks: 1,
  bytes: 32768,
  sha256: '12'.repeat(32),
  key: '34'.repeat(32),
  nonce: '56'.repeat(24),
  plainMime: 'image/jpeg',
  plainSha256: '78'.repeat(32),
  w: 512,
  h: 512,
  ms: 0,
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

test('private group images require exact private keys and bounded square JPEG metadata', async (t) => {
  const { validGroupImage, validPrivateGroupImage, pictureProps } = await load()
  const item = privateImage()
  t.ok(validPrivateGroupImage(item))
  t.ok(validGroupImage(item))
  t.ok(validPrivateGroupImage(privateImage({ start: 8183, blocks: 9, bytes: 9 * 32768 })), 'room for the sealed maximum avatar')
  t.ok(validPrivateGroupImage(privateImage({ start: 7936, blocks: 256, bytes: 256 * 32768 })), 'private media bounds')
  for (const value of [null, undefined, [], {}, 'image', 1, image()]) t.absent(validPrivateGroupImage(value))
  const invalid = [
    ...Object.keys(item).map((key) => {
      const copy = { ...item }
      delete copy[key]
      return copy
    }),
    ...[
      { mime: 'image/jpeg' }, { plainMime: 'image/webp' }, { w: 511 }, { h: 513 }, { ms: 1 },
      { core: 1 }, { core: 'bad' }, { sha256: null }, { key: 'bad' }, { plainSha256: 'bad' },
      { nonce: 1 }, { nonce: 'ab'.repeat(23) }, { nonce: 'AB'.repeat(24) },
      { start: 0 }, { start: 1.5 }, { start: 8192 }, { blocks: 0 }, { blocks: 1.5 },
      { blocks: 257, bytes: 257 * 32768 }, { bytes: 32767 }, { bytes: '32768' }, { extra: true }
    ].map(privateImage)
  ]
  for (const value of invalid) {
    t.absent(validPrivateGroupImage(value))
    t.absent(validGroupImage(value))
    t.alike(pictureProps({ image: value, imageAuthor: AUTHOR, visibility: 'private' }), { picture: null, mediaAuthor: null })
  }
})

test('pictureProps identifies private items by their shape and copies them with their author', async (t) => {
  const { pictureProps } = await load()
  const item = privateImage()
  for (const visibility of ['private', 'public', undefined]) {
    const props = pictureProps({ group: GROUP, visibility, image: item, imageAuthor: AUTHOR })
    t.alike(props, { privateItem: item, mediaAuthor: AUTHOR })
    t.not(props.privateItem, item)
    t.absent(Object.hasOwn(props, 'picture'))
  }
  for (const imageAuthor of [undefined, null, '', 'bad', AUTHOR.toUpperCase(), 1, {}]) {
    t.alike(pictureProps({ image: item, imageAuthor }), { picture: null, mediaAuthor: null })
  }
})

test('canEdit requires the creator, root authority and an upload capability for either group visibility', async (t) => {
  const { canEdit } = await load()
  const node = { media: { upload () {} } }
  const info = { group: GROUP, role: 'creator', visibility: 'public', rootHere: true }
  t.ok(canEdit(info, node))
  t.ok(canEdit({ ...info, visibility: 'private' }, node))
  t.ok(canEdit({ ...info, visibility: 'private' }, { hosted: false, media: node.media }), 'capability, not hosting')
  const community = { community: GROUP, role: 'creator', rootHere: true, rootAuthority: true, repair: false }
  t.ok(canEdit(community, node), 'the creating device can write the community root')
  t.ok(canEdit({ ...community, authorityHere: false }, node), 'generation retirement does not end root authority')
  t.ok(canEdit({ ...community, rootHere: false, rootAuthority: false, repair: true }, node), 'a live repair writer can edit')
  for (const rootHere of [false, undefined]) {
    t.absent(canEdit({ ...info, rootHere, authorityHere: true }, node), 'a group needs this device to own the uncut root')
    t.absent(canEdit({ ...info, rootHere, visibility: 'private' }, node), 'a private group also needs its root')
    t.absent(canEdit({ ...community, rootHere }, node), 'community creator on another device cannot edit')
  }
  for (const rootAuthority of [false, undefined]) {
    t.absent(canEdit({ ...community, rootAuthority, authorityHere: true }, node), 'holding the community root alone grants nothing')
  }
  for (const value of [null, undefined, {}, [], 'x']) t.absent(canEdit(value, node))
  for (const role of [undefined, null, 'admin', 'member', 'left', 'banned', 'pending']) {
    t.absent(canEdit({ ...info, role }, node))
    t.absent(canEdit({ ...info, role, visibility: 'private' }, node))
  }
  for (const visibility of [undefined, null, '', 'unknown']) {
    t.absent(canEdit({ ...info, community: GROUP, visibility }, node), 'a community parent does not make a group public')
  }
  for (const community of [undefined, null, '', 'bad', 1]) t.absent(canEdit({ community, role: 'creator' }, node))
  t.absent(canEdit({ community: GROUP, role: 'creator', visibility: 'private' }, node))
  for (const value of [null, undefined, {}, { media: null }, { media: {} }, { media: { upload: true } }]) {
    t.absent(canEdit(info, value))
    t.absent(canEdit({ ...info, visibility: 'private' }, value))
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
