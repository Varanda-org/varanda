'use strict'

// The local direct message store (lib/dm-store.js): ciphertext at rest,
// readable only after unlock, nothing after lock.
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const { memoryNodeStorage } = require('../lib/node-storage')
const { createDmStore } = require('../lib/dm-store')

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
