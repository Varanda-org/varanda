// A page's voice note: the recorder's file (udta, meta, times) is stripped
// before it is hashed and uploaded, so the service's strict check passes.
'use strict'

const test = require('brittle')
const { audioBounds } = require('@varanda/rpc')
const load = () => import('../src/pageVoice.js')

const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))
const box = (type, ...parts) => { const body = parts.flat(); return [...be32(8 + body.length), ...ascii(type), ...body] }
const tag = (type) => box(type, ascii('iPhone 15 Pro, 2026-11-06 10:31'))

// An AudioSpecificConfig with an explicit 1024000 Hz rate, mono: an access
// unit lasts 1 ms.
function asc () {
  const bits = []
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2) }
  put(2, 5)
  put(15, 4)
  put(1024000, 24)
  put(1, 4)
  put(0, 3)
  while (bits.length % 8) bits.push(0)
  const out = []
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  return out
}
const config = asc()
const esds = () => {
  const dc = [0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, config.length, ...config]
  const es = [0, 1, 0, 0x04, dc.length, ...dc, 0x06, 0x01, 0x02]
  return box('esds', [0, 0, 0, 0], [0x03, es.length, ...es])
}

// A recorder-like 3 s file: times, udta and meta all carry device tags.
function recorded () {
  const mvhd = box('mvhd', [0, 0, 0, 0], be32(0xdeadbeef), be32(0xcafef00d), be32(1000), be32(3000), new Array(80).fill(0))
  const tkhd = box('tkhd', [0, 0, 0, 7], be32(0), be32(0), be32(1), be32(0), be32(3000), new Array(60).fill(0))
  const mdhd = box('mdhd', [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(3000), [0, 0, 0, 0])
  const hdlr = box('hdlr', [0, 0, 0, 0], be32(0), ascii('soun'), be32(0), be32(0), be32(0), [0])
  const entry = box('mp4a', new Array(28).fill(0), esds())
  const stbl = box('stbl', box('stsd', [0, 0, 0, 0], be32(1), entry), box('stts', [0, 0, 0, 0], be32(1), be32(3000), be32(1)),
    box('stsz', [0, 0, 0, 0], be32(1), be32(3000)), box('stsc', [0, 0, 0, 0], be32(1), be32(1), be32(3000), be32(1)), box('stco', [0, 0, 0, 0], be32(1), be32(0)))
  const minf = box('minf', box('smhd', new Array(8).fill(0)), box('dinf', box('dref', [0, 0, 0, 0], be32(1), box('url ', [0, 0, 0, 1]))), stbl)
  const trk = box('trak', tkhd, box('mdia', mdhd, hdlr, minf), tag('udta'))
  return new Uint8Array([...box('ftyp', ascii('M4A '), be32(0), ascii('M4A '), ascii('isom')), ...box('moov', mvhd, trk, tag('udta'), box('meta', [0, 0, 0, 0], tag('ilst'))), ...box('mdat', new Array(3100).fill(1))])
}

test('pageVoice: the recorder file fails the strict check, its stripped copy passes', async (t) => {
  const { pageVoice } = await load()
  const raw = recorded()
  t.is(audioBounds(raw), null, 'the raw file is refused by the service check')
  t.alike(audioBounds(raw, { metadata: true }), { ms: 3000 }, 'a valid recording for its sender')
  const out = pageVoice({ bytes: raw, ms: 3100 })
  t.ok(out !== null, 'within the tolerance')
  t.is(out.ms, 3000, 'the container ms is what is sent')
  t.alike(audioBounds(out.bytes), { ms: 3000 }, 'the stripped copy passes the strict check')
})

test('pageVoice: refuses a wrong length, a non-recording and bad arguments', async (t) => {
  const { pageVoice } = await load()
  const raw = recorded()
  t.is(pageVoice({ bytes: raw, ms: 5000 }), null, 'ms off by more than the tolerance')
  t.is(pageVoice({ bytes: new Uint8Array(100), ms: 3000 }), null)
  t.is(pageVoice({ bytes: raw, ms: 0 }), null)
  t.is(pageVoice({ bytes: raw }), null)
  t.is(pageVoice(), null)
})
