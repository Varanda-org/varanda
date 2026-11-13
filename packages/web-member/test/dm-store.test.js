'use strict'

// The local direct message store (lib/dm-store.js): ciphertext at rest,
// readable only after unlock, nothing after lock.
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const { memoryNodeStorage } = require('../lib/node-storage')
const { createDmStore } = require('../lib/dm-store')
const nodeStore = require('../lib/node-store')
const gc = require('@varanda/core/lib/group-crypto')
const { DM_REACT_REV_MAX } = require('@varanda/core/lib/dm')

const PEER = 'ab'.repeat(32)
const OWN = 'cd'.repeat(32)
const ID = '12'.repeat(16)

function key (byte) {
  return new Uint8Array(32).fill(byte)
}

function msg (filedAt) {
  return { t: 'msg', id: ID, peer: PEER, from: PEER, text: 'segredo à vista', replyTo: null, at: '2026-11-03T10:00:00.000Z', mine: false, filedAt }
}

async function rawBlocks (storage) {
  const core = new Hypercore(storage.core('dm-local'), { valueEncoding: 'binary' })
  await core.ready()
  const out = []
  for (let i = 0; i < core.length; i++) out.push(b4a.toString(await core.get(i), 'utf8'))
  await core.close()
  return out.join('\n')
}

test('rows survive a reopen under the same key and are ciphertext at rest', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  t.ok(s.unlocked())
  const filed = s.nextFiled()
  await s.append([msg(filed), { t: 'ctl', id: '34'.repeat(16), op: 'accepted', peer: PEER, at: '2026-11-03T10:00:01.000Z', filedAt: s.nextFiled() }])
  const snap = s.snapshot()
  t.is(snap.messages.length, 1)
  t.is(snap.ops.length, 1)
  t.ok(snap.ops[0].filedAt > snap.messages[0].filedAt, 'monotonic filing time')
  t.ok(s.hasMessage(PEER, ID))
  await s.close()

  const raw = await rawBlocks(storage)
  t.absent(raw.includes('segredo'), 'no plaintext text')
  t.absent(raw.includes(PEER), 'no plaintext peer key')
  t.absent(raw.includes(OWN))

  const again = createDmStore({ storage })
  await again.unlock(key(7))
  t.is(again.snapshot().messages[0].text, 'segredo à vista')
  t.ok(again.nextFiled(0) > filed, 'filing time continues after the stored rows')
  again.lock()
  t.absent(again.unlocked())
  t.exception(() => again.snapshot(), /bloqueada/)
  await t.exception(again.append([msg(1)]), /bloqueada/)
})

test('another key reads nothing and starts an empty store', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(1))
  await s.append([msg(s.nextFiled())])
  await s.close()
  const other = createDmStore({ storage })
  await other.unlock(key(2))
  t.is(other.snapshot().messages.length, 0)
  await other.append([msg(other.nextFiled())])
  t.is(other.snapshot().messages.length, 1)
  await other.close()
})

test('an unlock superseded while it reads never deletes the core of another key', async (t) => {
  const base = memoryNodeStorage()
  const first = createDmStore({ storage: base })
  await first.unlock(key(1))
  await first.append([msg(first.nextFiled())])
  await first.close()

  let s = null
  let tripped = false
  const storage = new Proxy(base, {
    get (target, prop) {
      if (prop === 'hasCore') {
        return async (name) => {
          if (!tripped && name === 'dm-local') {
            tripped = true
            s.lock()
          }
          return target.hasCore(name)
        }
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  s = createDmStore({ storage })
  await s.unlock(key(2))
  t.ok(tripped)
  t.absent(s.unlocked(), 'superseded: nothing installed')
  t.ok(await base.hasCore('dm-local'), 'the other key\'s core is kept')
  const again = createDmStore({ storage: base })
  await again.unlock(key(1))
  t.is(again.snapshot().messages.length, 1)
  await again.close()
})

test('rows are padded to one size class: text length and msg vs ctl do not show on disk', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(9))
  await s.append([
    { ...msg(s.nextFiled()), text: 'a' },
    { ...msg(s.nextFiled()), id: '56'.repeat(16), text: 'b'.repeat(300) },
    { t: 'ctl', id: '34'.repeat(16), op: 'blocked', peer: PEER, at: '2026-11-03T10:00:01.000Z', filedAt: s.nextFiled() },
    { ...msg(s.nextFiled()), id: '78'.repeat(16), text: '\u{1F600}'.repeat(1000) }
  ])
  await s.close()
  const core = new Hypercore(storage.core('dm-local'), { valueEncoding: 'binary' })
  await core.ready()
  const sizes = []
  for (let i = 0; i < core.length; i++) sizes.push((await core.get(i)).byteLength)
  await core.close()
  t.is(sizes[0], sizes[1], 'texts of 1 and 300 characters: equal block lengths')
  t.is(sizes[0], sizes[2], 'a ctl row is in the same class')
  t.ok(sizes[3] > sizes[0], 'a long text takes a larger class')

  const again = createDmStore({ storage })
  await again.unlock(key(9))
  const snap = again.snapshot()
  t.alike(snap.messages.map((m) => m.text.length), [1, 300, 2000], 'the padding is stripped on open')
  t.absent('pad' in snap.messages[0])
  t.absent('pad' in snap.ops[0])
  await again.close()
})

function mediaItem (byte) {
  return { id: byte.repeat(32), key: 'ee'.repeat(32), nonce: 'ff'.repeat(24), chunks: 1, bytes: 1016, sha256: 'aa'.repeat(32), mime: 'image/png', w: 64, h: 48, ms: 0 }
}

async function kvText (storage) {
  const index = await storage.readJson('dmMediaIndex')
  const out = [JSON.stringify(index)]
  for (const e of (index && index.items) || []) {
    for (let i = 0; i < e.c; i++) out.push(JSON.stringify(await storage.readJson('dmMedia/' + e.n + '/' + i)))
  }
  return out.join('\n')
}

test('a message row keeps its media descriptors, key included, across a reopen; a row without media reads as null', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  const media = [mediaItem('01'), mediaItem('02')]
  await s.append([msg(s.nextFiled()), { ...msg(s.nextFiled()), id: '56'.repeat(16), text: '', media }])
  await s.close()
  const raw = await rawBlocks(storage)
  t.absent(raw.includes('ee'.repeat(32)), 'no blob key in clear at rest')
  t.absent(raw.includes('01'.repeat(32)), 'no blob id in clear at rest')

  const again = createDmStore({ storage })
  await again.unlock(key(7))
  const [plain, withMedia] = again.snapshot().messages
  t.is(plain.media, null)
  t.alike(withMedia.media, media, 'the descriptors come back exactly')
  t.is(withMedia.text, '')
  await t.exception.all(again.append([{ ...msg(again.nextFiled()), id: '78'.repeat(16), media: [{ ...mediaItem('03'), extra: 1 }] }]), /linha inválida/)
  await t.exception.all(again.append([{ ...msg(again.nextFiled()), id: '78'.repeat(16), media: [] }]), /linha inválida/)
  await again.close()
})

test('a voice note row: audio/mp4 with no sides and its duration, alone in its message', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  const voice = { ...mediaItem('04'), mime: 'audio/mp4', w: 0, h: 0, ms: 4200, bytes: 40016, chunks: 1 }
  await s.append([{ ...msg(s.nextFiled()), text: '', media: [voice] }])
  t.alike(s.snapshot().messages[0].media, [voice], 'kept exactly')
  const bad = {
    'with sides': { ...voice, w: 1, h: 1 },
    'ms 0': { ...voice, ms: 0 },
    'ms over': { ...voice, ms: 120001 },
    'over the byte cap': { ...voice, bytes: 1572864 + 17 },
    'video mime': { ...voice, mime: 'video/mp4' },
    'photo with ms': { ...mediaItem('05'), ms: 10 }
  }
  for (const [name, item] of Object.entries(bad)) {
    await t.exception.all(s.append([{ ...msg(s.nextFiled()), id: '78'.repeat(16), media: [item] }]), /linha inválida/, name)
  }
  await t.exception.all(s.append([{ ...msg(s.nextFiled()), id: '78'.repeat(16), media: [voice, mediaItem('06')] }]), /linha inválida/, 'never next to a photo')
  await s.close()
})

test('the media cache: sealed at rest, keyed by an opaque name, readable only under the key, wiped without it', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  const photo = b4a.from('PNG-bytes-segredo-' + 'x'.repeat(100))
  const second = b4a.from('second-item-segredo')
  t.absent(s.hasMedia(PEER, ID))
  t.is(await s.getMedia(PEER, ID), null)
  await s.putMedia(PEER, ID, [photo, second])
  t.ok(s.hasMedia(PEER, ID))
  const got = await s.getMedia(PEER, ID)
  t.is(got.length, 2)
  t.ok(b4a.equals(got[0], photo) && b4a.equals(got[1], second), 'the plaintext comes back')
  t.not(got[0], photo, 'a fresh buffer')
  const at = await kvText(storage)
  t.absent(at.includes('segredo'), 'no plaintext in kv')
  t.absent(at.includes(b4a.toString(photo, 'base64').slice(0, 24)), 'not even its base64')
  t.absent(at.includes(PEER) || at.includes(ID), 'no sender or message id in kv')
  await s.close()

  const again = createDmStore({ storage })
  await again.unlock(key(7))
  t.ok(again.hasMedia(PEER, ID), 'the cache survives a reopen')
  t.ok(b4a.equals((await again.getMedia(PEER, ID))[0], photo))
  again.lock()
  t.absent(again.hasMedia(PEER, ID), 'locked: nothing is known')
  await t.exception(again.getMedia(PEER, ID), /bloqueada/)
  t.exception(() => again.putMedia(PEER, ID, [photo]), /bloqueada/)
  await again.wipeCache()
  t.is(await storage.readJson('dmMediaIndex'), null, 'the index is gone')
  t.is(await storage.readJson('dmMedia/' + 'x'), null)
  await again.unlock(key(7))
  t.absent(again.hasMedia(PEER, ID), 'nothing cached after the wipe')
  t.is(await again.getMedia(PEER, ID), null)
  await again.close()
})

test('another key does not open the cache and its unlock wipes it', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  await s.append([msg(s.nextFiled())])
  await s.putMedia(PEER, ID, [b4a.from('foto')])
  const index = await storage.readJson('dmMediaIndex')
  await s.close()
  const other = createDmStore({ storage })
  await other.unlock(key(9))
  t.absent(other.hasMedia(PEER, ID))
  t.is(await storage.readJson('dmMediaIndex'), null, 'the index of another key is wiped')
  t.is(await storage.readJson('dmMedia/' + index.items[0].n + '/0'), null, 'and its entries')
  await other.close()
})

test('a cache write issued before a lock is dropped, and a wipe after it runs last', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  const put = s.putMedia(PEER, ID, [b4a.from('foto')])
  s.lock()
  const wiped = s.wipeCache()
  await t.exception(put, /bloqueada/)
  await wiped
  t.is(await storage.readJson('dmMediaIndex'), null)
  await s.unlock(key(7))
  t.absent(s.hasMedia(PEER, ID))
  await s.close()
})

// Records every dmMedia/<name>/<i> key written; onItem(key) runs after each.
function itemSpy (storage, onItem) {
  const written = new Set()
  return {
    written,
    storage: {
      ...storage,
      async writeJson (k, v) {
        await storage.writeJson(k, v)
        if (k.startsWith('dmMedia/') && v !== null) {
          written.add(k)
          await onItem(k)
        }
      }
    }
  }
}

test('a lock between two items of one cache write leaves nothing a wipe cannot find', async (t) => {
  const base = memoryNodeStorage()
  let s = null
  const spy = itemSpy(base, () => { if (s.unlocked()) s.lock() })
  s = createDmStore({ storage: spy.storage })
  await s.unlock(key(7))
  await t.exception(s.putMedia(PEER, ID, [b4a.from('foto-um'), b4a.from('foto-dois')]), /bloqueada/)
  t.is(spy.written.size, 1, 'the first item was written before the lock')
  await s.wipeCache()
  for (const k of spy.written) t.is(await base.readJson(k), null, 'the written item is wiped')
  t.is(await base.readJson('dmMediaIndex'), null)
  await s.close()
})

test('an interrupted cache write is never read as cached after a reopen, and is wiped', async (t) => {
  const base = memoryNodeStorage()
  let fail = true
  const spy = itemSpy(base, () => { if (fail) throw new Error('disco cheio') })
  const s = createDmStore({ storage: spy.storage })
  await s.unlock(key(7))
  await t.exception(s.putMedia(PEER, ID, [b4a.from('foto-um'), b4a.from('foto-dois')]), /disco cheio/)
  t.absent(s.hasMedia(PEER, ID))
  await s.close()
  fail = false
  const again = createDmStore({ storage: spy.storage })
  await again.unlock(key(7))
  t.absent(again.hasMedia(PEER, ID), 'an unfinished entry is not cached')
  t.is(await again.getMedia(PEER, ID), null)
  again.lock()
  await again.wipeCache()
  for (const k of spy.written) t.is(await base.readJson(k), null, 'the item of the unfinished entry is wiped')
  await again.close()
})

test('a cache write copies the items at once: the caller may wipe its buffers right away', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  const photo = b4a.from('PNG-bytes-real')
  const put = s.putMedia(PEER, ID, [photo])
  photo.fill(0)
  await put
  const got = await s.getMedia(PEER, ID)
  t.ok(b4a.equals(got[0], b4a.from('PNG-bytes-real')), 'the real bytes were cached, not zeros')
  await s.close()
})

test('the media cache stays within its byte budget: the oldest entries go first, an oversized set is not cached', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage, cacheBytesMax: 1000 })
  await s.unlock(key(7))
  const ids = ['01', '02', '03', '04'].map((b) => b.repeat(16))
  const total = async () => (await storage.readJson('dmMediaIndex')).items.reduce((n, e) => n + e.b, 0)
  t.is(await s.putMedia(PEER, ids[0], [b4a.alloc(300, 1)]), true)
  t.is(await s.putMedia(PEER, ids[1], [b4a.alloc(200, 2), b4a.alloc(200, 2)]), true)
  t.is(await total(), 700)
  const first = (await storage.readJson('dmMediaIndex')).items[0].n
  t.is(await s.putMedia(PEER, ids[2], [b4a.alloc(400, 3)]), true)
  t.absent(s.hasMedia(PEER, ids[0]), 'the oldest entry is evicted')
  t.ok(s.hasMedia(PEER, ids[1]) && s.hasMedia(PEER, ids[2]))
  t.is(await storage.readJson('dmMedia/' + first + '/0'), null, 'its item is wiped')
  t.is(await s.getMedia(PEER, ids[0]), null)
  t.ok((await total()) <= 1000, 'within the budget')
  t.is(await total(), 800)
  t.is(await s.putMedia(PEER, ids[3], [b4a.alloc(600, 4), b4a.alloc(401, 4)]), false, 'larger than the whole budget')
  t.absent(s.hasMedia(PEER, ids[3]))
  t.ok(s.hasMedia(PEER, ids[1]) && s.hasMedia(PEER, ids[2]), 'nothing evicted for it')
  t.is(await s.putMedia(PEER, ids[3], [b4a.alloc(1000, 4)]), true, 'exactly the budget fits')
  t.absent(s.hasMedia(PEER, ids[1]) || s.hasMedia(PEER, ids[2]), 'both older entries evicted')
  t.is(await total(), 1000)
  await s.close()
  const again = createDmStore({ storage, cacheBytesMax: 1000 })
  await again.unlock(key(7))
  t.ok(again.hasMedia(PEER, ids[3]), 'the sizes survive a reopen')
  again.lock()
  await again.wipeCache()
  t.is(await storage.readJson('dmMediaIndex'), null, 'lock still wipes')
  await again.close()
})

test('an eviction interrupted after an item is gone never leaves that entry read as cached', async (t) => {
  const base = memoryNodeStorage()
  let fail = false
  const storage = {
    ...base,
    async writeJson (k, v) {
      await base.writeJson(k, v)
      if (fail && k.startsWith('dmMedia/') && v === null) throw new Error('aba fechada')
    }
  }
  const s = createDmStore({ storage, cacheBytesMax: 1000 })
  await s.unlock(key(7))
  const ids = ['01', '02'].map((b) => b.repeat(16))
  t.is(await s.putMedia(PEER, ids[0], [b4a.alloc(600, 1)]), true)
  fail = true
  await t.exception(s.putMedia(PEER, ids[1], [b4a.alloc(600, 2)]), /aba fechada/)
  fail = false
  t.absent(s.hasMedia(PEER, ids[0]), 'the evicted entry is not cached')
  await s.close()
  const again = createDmStore({ storage, cacheBytesMax: 1000 })
  await again.unlock(key(7))
  t.absent(again.hasMedia(PEER, ids[0]), 'nor after a reopen, so it is downloaded again')
  t.is(await again.getMedia(PEER, ids[0]), null)
  again.lock()
  await again.wipeCache()
  t.is(await base.readJson('dmMediaIndex'), null)
  await again.close()
})

test('a finished entry with a lost item reads as not cached from then on', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  await s.putMedia(PEER, ID, [b4a.from('foto-um'), b4a.from('foto-dois')])
  const name = (await storage.readJson('dmMediaIndex')).items[0].n
  await storage.writeJson('dmMedia/' + name + '/1', null)
  t.ok(s.hasMedia(PEER, ID), 'the index still says cached')
  t.is(await s.getMedia(PEER, ID), null)
  t.absent(s.hasMedia(PEER, ID), 'the failed read drops it')
  await s.close()
  const again = createDmStore({ storage })
  await again.unlock(key(7))
  t.absent(again.hasMedia(PEER, ID), 'not cached after a reopen')
  t.is(await again.putMedia(PEER, ID, [b4a.from('foto-nova')]), true, 'a new download caches it again')
  t.ok(b4a.equals((await again.getMedia(PEER, ID))[0], b4a.from('foto-nova')))
  again.lock()
  await again.wipeCache()
  t.is(await storage.readJson('dmMedia/' + name + '/0'), null)
  t.is(await storage.readJson('dmMedia/' + name + '/1'), null)
  await again.close()
})

test('an unlock superseded while it deletes the core of another key never wipes that key\'s media', async (t) => {
  const base = memoryNodeStorage()
  const first = createDmStore({ storage: base })
  await first.unlock(key(1))
  await first.append([msg(first.nextFiled())])
  await first.putMedia(PEER, ID, [b4a.from('foto')])
  await first.close()
  const index = await base.readJson('dmMediaIndex')

  let s = null
  let tripped = false
  const storage = new Proxy(base, {
    get (target, prop) {
      if (prop === 'deleteCore') {
        return async (name) => {
          const out = await target.deleteCore(name)
          if (!tripped && name === 'dm-local') {
            tripped = true
            s.lock()
          }
          return out
        }
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  s = createDmStore({ storage })
  await s.unlock(key(2))
  t.ok(tripped)
  t.absent(s.unlocked(), 'superseded: nothing installed')
  t.alike(await base.readJson('dmMediaIndex'), index, 'the index is kept')
  const again = createDmStore({ storage: base })
  await again.unlock(key(1))
  t.ok(again.hasMedia(PEER, ID))
  t.ok(b4a.equals((await again.getMedia(PEER, ID))[0], b4a.from('foto')), 'the media still opens')
  await again.close()
})

test('forward flags survive storage and legacy rows default to 0', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  await s.append([msg(s.nextFiled()), { ...msg(s.nextFiled()), id: '56'.repeat(16), fwd: 1, media: null }])
  t.alike(s.snapshot().messages.map(m => m.fwd), [0, 1])
  for (const fwd of [true, false, 2, -1, '1', null]) {
    await t.exception.all(s.append([{ ...msg(s.nextFiled()), fwd }]), /linha inválida/)
  }
  await s.close()
  const again = createDmStore({ storage })
  await again.unlock(key(7))
  t.alike(again.snapshot().messages.map(m => m.fwd), [0, 1])
  await again.close()
})

test('cards survive storage and reopen, legacy rows read null and malformed cards fail', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  const card = { url: 'https://example.org/post', host: 'example.org', title: 'Título', desc: 'Descrição', image: null }
  card.image = { id: PEER, key: OWN, nonce: 'ef'.repeat(24), chunks: 1, bytes: 100, sha256: PEER, mime: 'image/jpeg', w: 4, h: 4, ms: 0 }
  const row = { ...msg(s.nextFiled()), card }
  await s.append([row, { ...msg(s.nextFiled()), id: '34'.repeat(16) }])
  t.alike(s.snapshot().messages[0].card, card)
  s.snapshot().messages[0].card.image.w = 9
  t.is(s.snapshot().messages[0].card.image.w, 4, 'snapshots own their thumbnail')
  for (const bad of [{ ...card, host: 'wrong.org' }, { ...card, image: { ...card.image, mime: 'image/png' } }]) {
    await t.exception.all(s.append([{ ...row, card: bad }]), /linha inválida/)
  }
  await t.exception.all(s.append([{ ...row, media: [card.image] }]), /linha inválida/)
  await s.close()
  const reopened = createDmStore({ storage })
  await reopened.unlock(key(7))
  t.alike(reopened.snapshot().messages[0].card, card)
  t.is(reopened.snapshot().messages[1].card, null)
  await reopened.close()
})

test('reaction rows: stored apart from messages, survive a reopen, never count as a message, and malformed ones fail', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  const target = { from: PEER, id: ID, digest: 'ef'.repeat(32) }
  const rx = (rev, emoji, filedAt) => ({ t: 'rx', id: (rev + 10).toString(16).padStart(2, '0').repeat(16), peer: PEER, from: OWN, to: PEER, target, emoji, rev, at: '2026-11-03T10:00:02.000Z', mine: true, filedAt })
  await s.append([rx(1, '\u{1f44d}', s.nextFiled()), rx(2, '', s.nextFiled())])
  t.is(s.snapshot().messages.length, 0, 'not a message')
  t.is(s.snapshot().reactions.length, 2)
  t.absent(s.hasMessage(OWN, rx(1).id), 'a reaction id never takes a message slot')
  t.ok(s.hasReaction(OWN, rx(1).id))
  t.absent(s.hasReaction(PEER, rx(1).id))
  t.is(s.reactionRev(PEER, target, OWN), 2)
  t.is(s.reactionRev(PEER, target, PEER), 0, 'per reactor')
  t.is(s.reactionRev(PEER, { ...target, id: '99'.repeat(16) }, OWN), 0, 'per target')
  t.is(s.reactionRev(PEER, { ...target, digest: '01'.repeat(32) }, OWN), 0, 'per target digest')
  const peerRx = { ...rx(5, '❤️', s.nextFiled()), from: PEER, to: OWN, mine: false }
  await s.append([peerRx])
  t.is(s.reactionRev(PEER, target, PEER), 5)
  s.lock()

  const again = createDmStore({ storage })
  await again.unlock(key(7))
  const snap = again.snapshot()
  t.alike(snap.reactions.map((r) => [r.from, r.emoji, r.rev, r.mine]), [[OWN, '\u{1f44d}', 1, true], [OWN, '', 2, true], [PEER, '❤️', 5, false]])
  t.alike(snap.reactions[0].target, target)
  t.is(snap.messages.length, 0)

  const base = rx(3, '\u{1f44d}', again.nextFiled())
  for (const [bad, why] of [
    [{ ...base, emoji: 'oi' }, 'not an emoji'],
    [{ ...base, rev: 0 }, 'rev 0'],
    [{ ...base, rev: 1000001 }, 'rev past the max'],
    [{ ...base, target: { ...target, from: '11'.repeat(32) } }, 'target by a third key'],
    [{ ...base, target: { from: PEER, id: ID } }, 'target without a digest'],
    [{ ...base, target: { ...target, digest: '' } }, 'target digest empty'],
    [{ ...base, peer: OWN }, 'peer not the other person'],
    [{ ...base, to: OWN }, 'to itself']
  ]) await t.exception.all(again.append([bad]), /linha inválida/, why)
})

test('digests: a msg row keeps its digest and a reaction row its target.digest across a reopen; a message row without one stays readable', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  const D = 'ab'.repeat(32)
  const withDigest = { ...msg(s.nextFiled()), digest: D }
  const without = { ...msg(s.nextFiled()), id: '34'.repeat(16) }
  const rx = (id, target) => ({ t: 'rx', id, peer: PEER, from: OWN, to: PEER, target, emoji: '\u{1f44d}', rev: 1, at: '2026-11-03T10:00:02.000Z', mine: true, filedAt: s.nextFiled() })
  await s.append([withDigest, without, rx('56'.repeat(16), { from: PEER, id: ID, digest: D })])
  s.lock()

  const again = createDmStore({ storage })
  await again.unlock(key(7))
  const snap = again.snapshot()
  t.is(snap.messages.find((m) => m.id === ID).digest, D, 'the msg digest is persisted')
  t.absent('digest' in snap.messages.find((m) => m.id === without.id), 'a row filed without one has none')
  t.alike(snap.reactions.map((r) => r.target), [{ from: PEER, id: ID, digest: D }], 'target.digest kept')
  t.ok(again.hasMessage(PEER, ID), 'a message is still found by sender and id')

  const base = msg(again.nextFiled())
  for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), '', 1]) {
    await t.exception.all(again.append([{ ...base, id: '01'.repeat(16), digest: bad }]), /linha inválida/, 'bad msg digest ' + JSON.stringify(bad))
    await t.exception.all(again.append([rx('02'.repeat(16), { from: PEER, id: ID, digest: bad })]), /linha inválida/, 'bad target digest ' + JSON.stringify(bad))
  }
  await again.close()
})

test('a reaction row stored without a target digest is skipped on load and the store still opens', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  const old = { t: 'rx', id: '56'.repeat(16), peer: PEER, from: OWN, to: PEER, target: { from: PEER, id: ID }, emoji: '\u{1f44d}', rev: 1, at: '2026-11-03T10:00:02.000Z', mine: true, filedAt: s.nextFiled() }
  const later = msg(s.nextFiled())
  const orig = nodeStore.openDmLocal
  nodeStore.openDmLocal = async (...args) => {
    nodeStore.openDmLocal = orig
    const core = await orig(...args)
    // The shape a build without target.digest filed.
    await core.append([{ v: 1, ...gc.sealRecord(old, key(7)) }])
    return core
  }
  try {
    await s.append([later])
  } finally {
    nodeStore.openDmLocal = orig
  }
  s.lock()

  const again = createDmStore({ storage })
  await again.unlock(key(7))
  const snap = again.snapshot()
  t.is(snap.reactions.length, 0, 'the old reaction row is skipped')
  t.alike(snap.messages.map((m) => m.id), [ID], 'the rows after it still load')
  await again.close()
})

test('reactionRev counts per message digest: a rev at the max on one digest leaves a first reaction to another', async (t) => {
  const storage = memoryNodeStorage()
  const s = createDmStore({ storage })
  await s.unlock(key(7))
  const one = { from: PEER, id: ID, digest: 'aa'.repeat(32) }
  const other = { ...one, digest: 'bb'.repeat(32) }
  await s.append([{ t: 'rx', id: '56'.repeat(16), peer: PEER, from: OWN, to: PEER, target: one, emoji: '\u{1f44d}', rev: DM_REACT_REV_MAX, at: '2026-11-03T10:00:02.000Z', mine: true, filedAt: s.nextFiled() }])
  t.is(s.reactionRev(PEER, one, OWN), DM_REACT_REV_MAX)
  t.is(s.reactionRev(PEER, other, OWN), 0, 'another digest under the same sender and id starts at 0')
  await s.close()
})
