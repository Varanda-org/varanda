'use strict'

const test = require('brittle')
const crypto = require('node:crypto')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const {
  SEALED_MEDIA_MIME, MAX_SEALED_MEDIA_PLAIN_BYTES, PRIVATE_ITEM_KEYS,
  validPublicItem, validPrivateItem, validGroupMedia, copyGroupItem, copyGroupMedia, sealMedia, openMedia
} = require('../lib/group-media')
const { MEDIA_BLOCK_BYTES, MAX_MEDIA_BLOCKS, MAX_MEDIA_ITEM_BLOCKS, MAX_MEDIA_PER_POST, MAX_AUDIO_MS, MAX_AUDIO_BYTES, validDescriptor } = require('../lib/records')

const MAC = sodium.crypto_secretbox_MACBYTES
const CORE = 'a'.repeat(64)
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const bytesOf = (n, seed = 7) => b4a.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251 + 1))
const isZero = (b) => b.every((x) => x === 0)

const PUBLIC = { core: CORE, mime: 'image/webp', start: 1, blocks: 3, bytes: 81234, sha256: 'b'.repeat(64), width: 2048, height: 1536 }

function sealed (n = 1000, at = { core: CORE, start: 1 }) {
  const plain = bytesOf(n)
  const { cipher, item } = sealMedia(plain, { plainMime: 'image/jpeg', w: 640, h: 480 })
  return { plain, cipher, item: { ...at, ...item } }
}

test('sealMedia fills every block and opens back to the image', (t) => {
  const { plain, cipher, item } = sealed(1000)
  t.alike(Object.keys(item).sort(), [...PRIVATE_ITEM_KEYS].sort())
  t.is(item.mime, SEALED_MEDIA_MIME)
  t.is(item.blocks, 1)
  t.is(item.bytes, MEDIA_BLOCK_BYTES, 'the short block is padded to a full one')
  t.is(cipher.byteLength, MEDIA_BLOCK_BYTES)
  t.is(item.sha256, sha(cipher), 'sha256 names the stored ciphertext')
  t.is(item.plainSha256, sha(plain))
  t.ok(/^[0-9a-f]{64}$/.test(item.key) && /^[0-9a-f]{48}$/.test(item.nonce))
  t.is(item.ms, 0)
  t.ok(validPrivateItem(item))
  const out = openMedia(cipher, item)
  t.alike(out, plain)

  const again = sealMedia(plain, { plainMime: 'image/jpeg', w: 640, h: 480 })
  t.not(again.item.key, item.key, 'a fresh key per item')
  t.not(again.item.nonce, item.nonce, 'a fresh nonce per item')
})

test('padding: the ciphertext size only says how many blocks', (t) => {
  const fit = MEDIA_BLOCK_BYTES - MAC - 1
  for (const [n, blocks] of [[1, 1], [fit, 1], [fit + 1, 2], [MEDIA_BLOCK_BYTES, 2], [2 * MEDIA_BLOCK_BYTES - MAC - 1, 2], [2 * MEDIA_BLOCK_BYTES - MAC, 3]]) {
    const { plain, cipher, item } = sealed(n)
    t.is(item.blocks, blocks, n + ' bytes take ' + blocks + ' blocks')
    t.is(cipher.byteLength, blocks * MEDIA_BLOCK_BYTES)
    t.alike(openMedia(cipher, item), plain, n + ' bytes open')
  }
  // A plaintext that ends in zero bytes keeps them (the pad mark comes after).
  const zeros = b4a.concat([bytesOf(10), b4a.alloc(20)])
  const s = sealMedia(zeros, { plainMime: 'image/png', w: 1, h: 1 })
  t.alike(openMedia(s.cipher, { core: CORE, start: 1, ...s.item }), zeros)
  t.is(MAX_SEALED_MEDIA_PLAIN_BYTES, MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES - MAC - 1)
})

test('sealMedia refuses bad input', (t) => {
  const ok = { plainMime: 'image/jpeg', w: 1, h: 1 }
  t.exception.all(() => sealMedia(b4a.alloc(0), ok), /plain/)
  t.exception.all(() => sealMedia('x', ok), /plain/)
  t.exception.all(() => sealMedia({ byteLength: MAX_SEALED_MEDIA_PLAIN_BYTES + 1 }, ok), /plain/)
  t.exception.all(() => sealMedia(bytesOf(4), { ...ok, plainMime: 'image/svg+xml' }), /plainMime/)
  t.exception.all(() => sealMedia(bytesOf(4), { ...ok, plainMime: SEALED_MEDIA_MIME }), /plainMime/)
  t.exception.all(() => sealMedia(bytesOf(4), { ...ok, w: 0 }), /w and h/)
  t.exception.all(() => sealMedia(bytesOf(4), { ...ok, h: 16385 }), /w and h/)
  t.exception.all(() => sealMedia(bytesOf(4), { ...ok, ms: 1 }), /ms/)
})

test('openMedia: anything but the exact sealed item is null', (t) => {
  const { cipher, item } = sealed(5000)
  const flip = (b, i) => {
    const c = b4a.from(b)
    c[i] ^= 1
    return c
  }
  t.is(openMedia(flip(cipher, 0), item), null, 'a changed ciphertext fails the hash')
  t.is(openMedia(flip(cipher, 0), { ...item, sha256: sha(flip(cipher, 0)) }), null, 'and the MAC')
  t.is(openMedia(cipher.subarray(1), item), null, 'wrong length')
  t.is(openMedia(b4a.concat([cipher, b4a.alloc(1)]), item), null)
  const other = sealed(5000)
  t.is(openMedia(cipher, { ...item, key: other.item.key }), null, 'another key')
  t.is(openMedia(cipher, { ...item, nonce: other.item.nonce }), null, 'another nonce')
  t.is(openMedia(cipher, { ...item, plainSha256: 'c'.repeat(64) }), null, 'another image hash')
  t.is(openMedia(cipher, { ...item, extra: 1 }), null, 'an invalid item')
  t.is(openMedia(null, item), null)
  t.is(openMedia(cipher, null), null)
  t.is(openMedia(cipher, { get key () { throw new Error('x') } }), null, 'never throws')

  // A well-sealed block whose pad is not sealMedia's: no mark, a mark with
  // nothing before it, or a pad wider than the last block.
  const forge = (padded, blocks) => {
    const key = b4a.alloc(32)
    const nonce = b4a.alloc(24)
    sodium.randombytes_buf(key)
    sodium.randombytes_buf(nonce)
    const c = b4a.alloc(padded.byteLength + MAC)
    sodium.crypto_secretbox_easy(c, padded, nonce, key)
    const it = { core: CORE, start: 1, mime: SEALED_MEDIA_MIME, blocks, bytes: c.byteLength, sha256: sha(c), key: b4a.toString(key, 'hex'), nonce: b4a.toString(nonce, 'hex'), plainMime: 'image/png', plainSha256: '', w: 1, h: 1, ms: 0 }
    return { c, it }
  }
  const one = MEDIA_BLOCK_BYTES - MAC
  const noMark = bytesOf(one)
  noMark[one - 1] = 7
  let f = forge(noMark, 1)
  t.is(openMedia(f.c, { ...f.it, plainSha256: sha(noMark.subarray(0, one - 1)) }), null, 'no pad mark')
  const onlyMark = b4a.alloc(one)
  onlyMark[0] = 0x80
  f = forge(onlyMark, 1)
  t.is(openMedia(f.c, { ...f.it, plainSha256: sha(b4a.alloc(0)) }), null, 'an empty image')
  const wide = b4a.alloc(2 * MEDIA_BLOCK_BYTES - MAC)
  wide.set(bytesOf(10))
  wide[10] = 0x80
  f = forge(wide, 2)
  t.is(openMedia(f.c, { ...f.it, plainSha256: sha(bytesOf(10)) }), null, 'a whole block of padding')
})

test('sealMedia and openMedia wipe the key and the padded plaintext', (t) => {
  const origRandom = sodium.randombytes_buf
  const origSeal = sodium.crypto_secretbox_easy
  const origOpen = sodium.crypto_secretbox_open_easy
  const keys = []
  const pads = []
  try {
    sodium.randombytes_buf = (buf) => {
      origRandom(buf)
      if (buf.byteLength === 32) keys.push(buf)
    }
    sodium.crypto_secretbox_easy = (c, m, n, k) => {
      pads.push(m)
      return origSeal(c, m, n, k)
    }
    sodium.crypto_secretbox_open_easy = (m, c, n, k) => {
      pads.push(m)
      keys.push(k)
      return origOpen(m, c, n, k)
    }
    const plain = bytesOf(3000)
    const { cipher, item } = sealMedia(plain, { plainMime: 'image/webp', w: 9, h: 9 })
    t.is(keys.length, 1)
    t.ok(isZero(keys[0]), 'the seal key buffer is zeroed')
    t.ok(isZero(pads[0]), 'the padded plaintext is zeroed')
    const out = openMedia(cipher, { core: CORE, start: 1, ...item })
    t.alike(out, plain)
    t.is(keys.length, 2)
    t.ok(isZero(keys[1]), 'the open key buffer is zeroed')
    t.ok(isZero(pads[1]), 'the opened padded buffer is zeroed')
    t.absent(isZero(out), 'the result is the caller\'s copy')
  } finally {
    sodium.randombytes_buf = origRandom
    sodium.crypto_secretbox_easy = origSeal
    sodium.crypto_secretbox_open_easy = origOpen
  }
})

test('private item shape', (t) => {
  const { item } = sealed(100)
  t.ok(validPrivateItem(item))
  t.absent(validPublicItem(item), 'never a public item')
  t.absent(validPrivateItem(PUBLIC), 'a post descriptor is never private')
  const bad = {
    'extra key': { ...item, width: 1 },
    'image mime': { ...item, mime: 'image/jpeg' },
    'start 0': { ...item, start: 0 },
    'past the core': { ...item, start: MAX_MEDIA_BLOCKS - 1, blocks: 2, bytes: 2 * MEDIA_BLOCK_BYTES },
    'too many blocks': { ...item, blocks: MAX_MEDIA_ITEM_BLOCKS + 1, bytes: (MAX_MEDIA_ITEM_BLOCKS + 1) * MEDIA_BLOCK_BYTES },
    'a short last block': { ...item, bytes: MEDIA_BLOCK_BYTES - 1 },
    'uppercase key': { ...item, key: item.key.toUpperCase() },
    'short key': { ...item, key: item.key.slice(2) },
    'short nonce': { ...item, nonce: item.nonce.slice(2) },
    'uppercase nonce': { ...item, nonce: 'A'.repeat(48) },
    'svg plainMime': { ...item, plainMime: 'image/svg+xml' },
    'octet plainMime': { ...item, plainMime: SEALED_MEDIA_MIME },
    'bad plainSha256': { ...item, plainSha256: 'x' },
    'w 0': { ...item, w: 0 },
    'h float': { ...item, h: 1.5 },
    'ms 1': { ...item, ms: 1 },
    'no core': { ...item, core: null }
  }
  for (const [name, d] of Object.entries(bad)) t.absent(validPrivateItem(d), name)
  const { core, ...noCore } = item
  t.absent(validPrivateItem(noCore), 'missing key')
  t.absent(validPrivateItem(null))
  t.absent(validPrivateItem({ get core () { throw new Error('x') } }), 'never throws')
})

test('validGroupMedia: 1..4 items of one kind at distinct places', (t) => {
  const priv = (start) => sealed(10, { core: CORE, start }).item
  const pub = (start) => ({ ...PUBLIC, start })
  t.ok(validGroupMedia([pub(1)], false))
  t.ok(validGroupMedia([pub(1), pub(4), pub(7), pub(10)], false))
  t.absent(validGroupMedia([pub(1), pub(4), pub(7), pub(10), pub(13)], false), 'five')
  t.is(MAX_MEDIA_PER_POST, 4)
  t.absent(validGroupMedia([], false), 'empty')
  t.absent(validGroupMedia(null, false), 'null')
  t.absent(validGroupMedia([pub(1), pub(1)], false), 'one place twice')
  t.ok(validGroupMedia([pub(1), { ...pub(1), core: 'c'.repeat(64) }], false), 'same start, other core')
  t.absent(validGroupMedia([priv(1)], false), 'a plain post refuses a private item')
  t.absent(validGroupMedia([pub(1)], true), 'a sealed inner refuses a public item')
  t.ok(validGroupMedia([priv(1), priv(2)], true))
  t.absent(validGroupMedia([priv(1), priv(1)], true), 'one place twice')
  t.absent(validGroupMedia([priv(1), pub(2)], true), 'never mixed')
  // eslint-disable-next-line no-sparse-arrays
  t.absent(validGroupMedia([pub(1), , pub(7)], false), 'a hole')
  const hostile = [pub(1)]
  Object.defineProperty(hostile, 0, { get () { throw new Error('x') } })
  t.absent(validGroupMedia(hostile, false), 'never throws')
})

test('copyGroupItem keeps exactly the keys of the expected kind', (t) => {
  const { item } = sealed(10)
  t.alike(Object.keys(copyGroupItem({ ...PUBLIC, extra: 1 }, false)), Object.keys(PUBLIC))
  t.alike(Object.keys(copyGroupItem({ ...item, extra: 1 }, true)), [...PRIVATE_ITEM_KEYS])
  t.absent(validPublicItem(copyGroupItem(item, false)), 'a private item copied as public is invalid')
  t.absent(validPrivateItem(copyGroupItem(PUBLIC, true)), 'a public item copied as private is invalid')
  t.is(copyGroupItem('x', true), 'x')
  t.is(copyGroupMedia(null, true), null)
  const list = [PUBLIC]
  const copy = copyGroupMedia(list, false)
  t.not(copy, list)
  t.not(copy[0], PUBLIC)
})

// A minimal MPEG-4 audio file (ftyp, moov with mvhd and one trak per
// handler with its sample table and a self-contained data reference, mdat):
// enough for audioBounds, nothing a player needs.
function m4a ({ ms = 3000, handlers = ['soun'], pad = 0 } = {}) {
  const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))
  const box = (type, ...parts) => { const body = parts.flat(); return [...be32(8 + body.length), ...ascii(type), ...body] }
  const trak = (h) => box('trak', box('mdia', box('mdhd', new Array(12).fill(0), be32(1000), be32(0), [0, 0, 0, 0]), box('hdlr', [0, 0, 0, 0], be32(0), ascii(h), be32(0), be32(0), be32(0), [0]),
    box('minf', box('dinf', box('dref', [0, 0, 0, 0], be32(1), box('url ', [0, 0, 0, 1]))), box('stbl', box('stsd', [0, 0, 0, 0], be32(1), box('mp4a', new Array(28).fill(0), box('esds', [0, 0, 0, 0], [3, 25, 0, 1, 0, 4, 17, 64, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 2, 18, 16, 6, 1, 2]))), box('stts', [0, 0, 0, 0], be32(1), be32(1), be32(ms)), box('stsz', [0, 0, 0, 0], be32(1), be32(1)), box('stsc', [0, 0, 0, 0], be32(1), be32(1), be32(1), be32(1)), box('stco', [0, 0, 0, 0], be32(1), be32(0))))))
  const head = [
    ...box('ftyp', ascii('M4A '), be32(0), ascii('isom')),
    ...box('moov', box('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(ms), new Array(80).fill(0)), ...handlers.map(trak))
  ]
  return b4a.concat([b4a.from(head), b4a.from(be32(8 + pad)), b4a.from('mdat'), bytesOf(pad)])
}

const AUDIO = { core: CORE, mime: 'audio/mp4', start: 1, blocks: 2, bytes: 40000, sha256: 'b'.repeat(64), width: 0, height: 0, ms: 4200 }

test('voice note: public descriptor', (t) => {
  t.ok(validPublicItem(AUDIO))
  t.absent(validDescriptor(AUDIO), 'diary posts stay still images')
  t.ok(validPublicItem({ ...AUDIO, blocks: 48, bytes: MAX_AUDIO_BYTES }), 'the largest')
  t.ok(validPublicItem({ ...AUDIO, ms: 1 }) && validPublicItem({ ...AUDIO, ms: MAX_AUDIO_MS }))
  const { ms, ...noMs } = AUDIO
  const bad = {
    'video mime': { ...AUDIO, mime: 'video/mp4' },
    'other audio mime': { ...AUDIO, mime: 'audio/mpeg' },
    'ogg audio': { ...AUDIO, mime: 'audio/ogg' },
    'upper mime': { ...AUDIO, mime: 'AUDIO/MP4' },
    'width 1': { ...AUDIO, width: 1 },
    'height 1': { ...AUDIO, height: 1 },
    'ms 0': { ...AUDIO, ms: 0 },
    'ms too long': { ...AUDIO, ms: MAX_AUDIO_MS + 1 },
    'ms float': { ...AUDIO, ms: 1.5 },
    'too many bytes': { ...AUDIO, blocks: 49, bytes: MAX_AUDIO_BYTES + 1 },
    'missing ms': noMs,
    'extra key': { ...AUDIO, alt: 'x' },
    'image with ms': { ...PUBLIC, ms: 0 }
  }
  for (const [name, d] of Object.entries(bad)) t.absent(validPublicItem(d), name)
  t.alike(Object.keys(copyGroupItem({ ...AUDIO, extra: 1 }, false)), Object.keys(AUDIO), 'the copy keeps ms')
  t.ok(validPublicItem(copyGroupItem(AUDIO, false)))
})

test('voice note: alone in its post, never next to images', (t) => {
  t.ok(validGroupMedia([AUDIO], false))
  t.absent(validGroupMedia([AUDIO, { ...AUDIO, start: 5 }], false), 'two voice notes')
  t.absent(validGroupMedia([AUDIO, { ...PUBLIC, start: 5 }], false), 'voice then image')
  t.absent(validGroupMedia([{ ...PUBLIC, start: 5 }, AUDIO], false), 'image then voice')
  const voice = sealMedia(m4a(), { plainMime: 'audio/mp4', w: 0, h: 0, ms: 3000 })
  const item = { core: CORE, start: 1, ...voice.item }
  t.ok(validGroupMedia([item], true))
  t.absent(validGroupMedia([item, sealed(10, { core: CORE, start: 9 }).item], true), 'sealed voice next to an image')
  t.absent(validGroupMedia([item, { ...item, start: 9 }], true), 'two sealed voice notes')
  t.absent(validGroupMedia([AUDIO], true), 'a sealed inner refuses a public voice note')
})

test('voice note: sealed, opened and checked by its bytes', (t) => {
  const plain = m4a({ pad: 50000 })
  const { cipher, item } = sealMedia(plain, { plainMime: 'audio/mp4', w: 0, h: 0, ms: 3000 })
  const full = { core: CORE, start: 1, ...item }
  t.ok(validPrivateItem(full))
  t.is(full.plainMime, 'audio/mp4')
  t.is(full.mime, SEALED_MEDIA_MIME)
  t.alike(openMedia(cipher, full), plain)

  t.exception.all(() => sealMedia(m4a({ handlers: ['soun', 'vide'] }), { plainMime: 'audio/mp4', w: 0, h: 0, ms: 3000 }), /audio-only/, 'a video track')
  t.exception.all(() => sealMedia(bytesOf(100), { plainMime: 'audio/mp4', w: 0, h: 0, ms: 3000 }), /audio-only/, 'not MPEG-4')
  t.exception.all(() => sealMedia(m4a({ ms: MAX_AUDIO_MS + 1 }), { plainMime: 'audio/mp4', w: 0, h: 0, ms: 3000 }), /audio-only/, 'container too long')
  t.exception.all(() => sealMedia(m4a({ pad: MAX_AUDIO_BYTES }), { plainMime: 'audio/mp4', w: 0, h: 0, ms: 3000 }), /at most/, 'too many bytes')
  t.exception.all(() => sealMedia(plain, { plainMime: 'audio/mp4', w: 1, h: 0, ms: 3000 }), /w and h 0/)
  t.exception.all(() => sealMedia(plain, { plainMime: 'audio/mp4', w: 0, h: 0, ms: 0 }), /ms 1/)
  t.exception.all(() => sealMedia(plain, { plainMime: 'audio/mpeg', w: 0, h: 0, ms: 3000 }), /plainMime/)
  t.exception.all(() => sealMedia(plain, { plainMime: 'video/mp4', w: 0, h: 0, ms: 3000 }), /plainMime/)

  // The mime is not trusted: a container with a video track sealed under an
  // image label and relabelled as a voice note does not open.
  const video = m4a({ handlers: ['vide', 'soun'] })
  const disguised = sealMedia(video, { plainMime: 'image/jpeg', w: 1, h: 1 })
  const relabelled = { core: CORE, start: 1, ...disguised.item, plainMime: 'audio/mp4', w: 0, h: 0, ms: 3000 }
  t.ok(validPrivateItem(relabelled), 'the shape alone passes')
  t.is(openMedia(disguised.cipher, relabelled), null, 'the bytes do not')

  const bad = {
    'w 1': { ...full, w: 1 },
    'ms 0': { ...full, ms: 0 },
    'ms too long': { ...full, ms: MAX_AUDIO_MS + 1 },
    'more blocks than a voice note': { ...full, blocks: 50, bytes: 50 * MEDIA_BLOCK_BYTES },
    'image with ms': { ...sealed(10).item, ms: 1000 }
  }
  for (const [name, d] of Object.entries(bad)) t.absent(validPrivateItem(d), name)
})

test('voice note: the item ms is the container duration, within AUDIO_MS_TOLERANCE', (t) => {
  const { AUDIO_MS_TOLERANCE } = require('@varanda/rpc')
  const plain = m4a({ ms: 3000 })
  const seal = (ms) => sealMedia(plain, { plainMime: 'audio/mp4', w: 0, h: 0, ms })
  t.is(sealMedia(plain, { plainMime: 'audio/mp4', w: 0, h: 0 }).item.ms, 3000, 'no ms: the container one')
  t.is(seal(3000 + AUDIO_MS_TOLERANCE).item.ms, 3000, 'a close ms: the container one')
  t.is(seal(3000 - AUDIO_MS_TOLERANCE).item.ms, 3000)
  t.exception.all(() => seal(3000 + AUDIO_MS_TOLERANCE + 1), /does not match/, 'too far above')
  t.exception.all(() => seal(1), /does not match/, 'a two-second gap')
  const long = m4a({ ms: MAX_AUDIO_MS })
  t.exception.all(() => sealMedia(long, { plainMime: 'audio/mp4', w: 0, h: 0, ms: 1 }), /does not match/, 'two minutes claiming 1 ms')

  // A peer's item claiming another length does not open.
  const { cipher, item } = seal(3000)
  const full = { core: CORE, start: 1, ...item }
  t.alike(openMedia(cipher, full), plain)
  t.alike(openMedia(cipher, { ...full, ms: 3000 + AUDIO_MS_TOLERANCE }), plain, 'within the tolerance')
  t.is(openMedia(cipher, { ...full, ms: 3000 + AUDIO_MS_TOLERANCE + 1 }), null, 'past it')
  t.is(openMedia(cipher, { ...full, ms: 1 }), null, 'claims 1 ms')
})

test('voice note: the largest sealed post still fits MAX_SEALED_INNER_BYTES', (t) => {
  const { groupPost } = require('../lib/group')
  const { sealRecord, MAX_SEALED_INNER_BYTES } = require('../lib/group-crypto')
  const { MAX_TEXT } = require('../lib/records')
  const voice = sealMedia(m4a({ ms: MAX_AUDIO_MS, pad: MAX_AUDIO_BYTES - 1000 }), { plainMime: 'audio/mp4', w: 0, h: 0, ms: MAX_AUDIO_MS })
  const item = { core: CORE, start: MAX_MEDIA_BLOCKS - voice.item.blocks, ...voice.item }
  t.ok(validPrivateItem(item))
  const record = groupPost({
    text: '\u{1F600}'.repeat(MAX_TEXT),
    replyTo: { writer: CORE, seq: Number.MAX_SAFE_INTEGER },
    seen: { writer: CORE, seq: Number.MAX_SAFE_INTEGER },
    media: [item],
    sealed: true
  })
  const size = b4a.byteLength(JSON.stringify(record))
  t.ok(size <= MAX_SEALED_INNER_BYTES, 'the largest voice post is ' + size + ' bytes')
  t.execution(() => sealRecord(record, b4a.alloc(32, 1)))
})
