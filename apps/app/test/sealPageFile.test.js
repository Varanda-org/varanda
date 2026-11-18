'use strict'

// worklet/web-node-parts.js sealPageMedia (media.sealPageFile, docs/rpc.md
// 5.114): a Página's private group photo or voice note read from a cache
// file, sealed by the session's pageSealMedia and handed back as a read-dir
// file, never over the IPC.
const test = require('brittle')
const { sealPageMedia } = require('../worklet/web-node-parts')

const PAGE = '12'.repeat(32)
const ITEM = { mime: 'application/octet-stream', blocks: 1, bytes: 65536, sha256: 'ab'.repeat(32), key: 'cd'.repeat(32), nonce: 'ef'.repeat(24), plainMime: 'image/jpeg', plainSha256: '34'.repeat(32), w: 2, h: 3, ms: 0 }

function harness ({ seal, generations = [1] } = {}) {
  const seen = []
  const unlinked = []
  const written = []
  const removed = []
  const bytes = new Uint8Array([1, 2, 3])
  let g = 0
  const session = {
    pageSealMedia: seal || ((args) => {
      seen.push({ ...args, copy: new Uint8Array(args.bytes) })
      return Promise.resolve({ cipher: new Uint8Array([9, 9]), item: ITEM })
    })
  }
  const io = {
    read: async () => ({ file: '/cache/p.bin', bytes }),
    session,
    unlink: (f) => unlinked.push(f),
    write: async (b) => { written.push(new Uint8Array(b)); return '0'.repeat(32) + '.bin' },
    remove: (name) => removed.push(name),
    generation: () => generations[Math.min(g++, generations.length - 1)],
    isClosing: () => false
  }
  return { io, seen, unlinked, written, removed, bytes }
}

test('sealPageMedia seals the photo and writes the ciphertext to a read file', async (t) => {
  const h = harness()
  const out = await sealPageMedia(h.io, { page: PAGE, mime: 'image/jpeg', width: 2, height: 3, ms: 5, kind: 'video' })
  t.alike(out, { name: '0'.repeat(32) + '.bin', item: ITEM })
  t.alike(Object.keys(h.seen[0]), ['page', 'bytes', 'mime', 'width', 'height', 'copy'], 'an image carries no duration or kind')
  t.is(h.seen[0].page, PAGE)
  t.alike(h.seen[0].copy, new Uint8Array([1, 2, 3]))
  t.ok(h.bytes.every((b) => b === 0), 'the plaintext is zeroed')
  t.alike(h.written, [new Uint8Array([9, 9])], 'the ciphertext goes to the read file')
  t.alike(h.unlinked, ['/cache/p.bin'], 'the upload file goes once sealed')
})

test('sealPageMedia passes a voice note with its duration and kind', async (t) => {
  const h = harness()
  await sealPageMedia(h.io, { page: PAGE, mime: 'audio/mp4', width: 0, height: 0, ms: 3000, kind: 'voice' })
  t.is(h.seen[0].ms, 3000)
  t.is(h.seen[0].kind, 'voice')
})

test('sealPageMedia refuses without writing, and a lock in between removes the file', async (t) => {
  const refused = harness({ seal: () => { throw new TypeError('mídia inválida') } })
  const err = await sealPageMedia(refused.io, { page: PAGE, mime: 'image/jpeg', width: 1, height: 1 }).catch((e) => e)
  t.is(err.code, 'USAGE')
  t.is(err.message, 'mídia inválida')
  t.alike(refused.written, [], 'nothing written')
  t.alike(refused.unlinked, [], 'a refused file is not unlinked')

  const noKey = harness({ seal: () => Promise.reject(Object.assign(new Error('sem chave da página'), { code: 'USAGE' })) })
  const err2 = await sealPageMedia(noKey.io, { page: PAGE, mime: 'image/jpeg', width: 1, height: 1 }).catch((e) => e)
  t.is(err2.message, 'sem chave da página', 'the session refusal passes through')
  t.alike(noKey.written, [])

  const locked = harness({ generations: [1, 1, 2] })
  const err3 = await sealPageMedia(locked.io, { page: PAGE, mime: 'image/jpeg', width: 1, height: 1 }).catch((e) => e)
  t.is(err3.code, 'LOCKED')
  t.alike(locked.removed, ['0'.repeat(32) + '.bin'], 'a file written across a lock is removed')

  const early = harness({ generations: [1, 2] })
  const err4 = await sealPageMedia(early.io, { page: PAGE, mime: 'image/jpeg', width: 1, height: 1 }).catch((e) => e)
  t.is(err4.code, 'LOCKED')
  t.alike(early.written, [], 'a lock before the write writes nothing')

  const closing = harness()
  const err5 = await sealPageMedia({ ...closing.io, isClosing: () => true }, { page: PAGE, mime: 'image/jpeg', width: 1, height: 1 }).catch((e) => e)
  t.is(err5.code, 'LOCKED')
  t.alike(closing.seen, [], 'a closing node seals nothing')
})
