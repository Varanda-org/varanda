'use strict'

const test = require('brittle')
const load = () => import('../src/groupImageCreate.js')
const key = 'ab'.repeat(32)
const picked = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' }
const publicImage = {
  core: 'cd'.repeat(32),
  mime: 'image/jpeg',
  start: 1,
  blocks: 1,
  bytes: 1000,
  sha256: 'ef'.repeat(32),
  width: 512,
  height: 512
}
const privateImage = {
  core: 'cd'.repeat(32),
  mime: 'application/octet-stream',
  start: 1,
  blocks: 1,
  bytes: 32768,
  sha256: 'ef'.repeat(32),
  key: '12'.repeat(32),
  nonce: '34'.repeat(24),
  plainMime: 'image/jpeg',
  plainSha256: '56'.repeat(32),
  w: 512,
  h: 512,
  ms: 0
}

function fake (over = {}) {
  const calls = []
  return {
    calls,
    options: {
      key,
      kind: 'group',
      visibility: 'public',
      picked,
      upload: async (params) => { calls.push(['upload', params]); return publicImage },
      setImage: async (...args) => { calls.push(['setImage', ...args]) },
      ...over
    }
  }
}

test('missing photo or returned key does nothing', async (t) => {
  const { imageAfterCreate } = await load()
  t.is(await imageAfterCreate(), 'none')
  for (const field of ['key', 'picked']) {
    for (const value of [undefined, null, '']) {
      const { calls, options } = fake({ [field]: value })
      t.is(await imageAfterCreate(options), 'none')
      t.alike(calls, [])
    }
  }
})

test('one upload precedes one setter with the created key and sent visibility', async (t) => {
  const { imageAfterCreate } = await load()
  for (const [kind, visibility] of [['group', 'public'], ['group', 'private'], ['community', undefined], ['community', 'private']]) {
    const sealed = kind === 'group' && visibility === 'private'
    const image = sealed ? privateImage : publicImage
    const { calls, options } = fake({ kind, visibility })
    options.upload = async (params) => {
      calls.push(['upload', params])
      options.visibility = sealed ? 'public' : 'private'
      return image
    }
    t.is(await imageAfterCreate(options), 'set')
    t.alike(calls, [
      ['upload', { ...picked, width: 512, height: 512, ...(sealed ? { sealed: true } : {}) }],
      ['setImage', kind + '.image', { [kind]: key, image }]
    ])
  }
})

test('invalid descriptors and mismatched sealing never reach the setter', async (t) => {
  const { imageAfterCreate } = await load()
  for (const visibility of ['public', 'private']) {
    for (const image of [null, undefined, {}, { ...publicImage, width: 511 }, { ...privateImage, nonce: 'bad' }, visibility === 'private' ? publicImage : privateImage]) {
      const { calls, options } = fake({ visibility })
      options.upload = async () => { calls.push('upload'); return image }
      t.is(await imageAfterCreate(options), 'failed')
      t.alike(calls, ['upload'])
    }
  }
  const { calls, options } = fake({ kind: 'community' })
  options.upload = async () => { calls.push('upload'); return privateImage }
  t.is(await imageAfterCreate(options), 'failed')
  t.alike(calls, ['upload'])
})

test('upload and setter failures never reject or retry, including uncertain writes', async (t) => {
  const { imageAfterCreate } = await load()
  for (const stage of ['upload', 'setImage']) {
    for (const error of [new Error('failed'), null, undefined, { uncertain: false }, { uncertain: 'true' }, { uncertain: true }]) {
      for (const asyncFailure of [false, true]) {
        const { calls, options } = fake()
        options[stage] = () => {
          calls.push([stage])
          if (asyncFailure) return Promise.reject(error)
          throw error
        }
        t.is(await imageAfterCreate(options), error?.uncertain === true ? 'uncertain' : 'failed')
        t.alike(calls.map(([name]) => name), stage === 'upload' ? ['upload'] : ['upload', 'setImage'])
      }
    }
  }
})

test('unknown kinds and group visibility fail before uploading', async (t) => {
  const { imageAfterCreate } = await load()
  for (const over of [{ kind: 'other' }, { visibility: undefined }, { visibility: 'unknown' }]) {
    const { calls, options } = fake(over)
    t.is(await imageAfterCreate(options), 'failed')
    t.alike(calls, [])
  }
})

test('creation exports the shared pt-BR photo wording', async (t) => {
  const { words } = await load()
  t.alike(words, {
    groupLabel: 'Foto do grupo (opcional)',
    communityLabel: 'Foto da comunidade (opcional)',
    groupPublic: 'A foto do grupo é pública, como o nome.',
    communityPublic: 'A foto da comunidade é pública, como o nome.',
    groupPrivate: 'Só quem participa do grupo vê a foto.',
    groupFailed: 'Grupo criado. A foto não foi salva. Você pode adicioná-la nos ajustes.',
    communityFailed: 'Comunidade criada. A foto não foi salva. Você pode adicioná-la nos ajustes.'
  })
  t.ok(Object.isFrozen(words))
})
