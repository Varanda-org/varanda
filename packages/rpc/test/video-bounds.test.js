'use strict'

const test = require('brittle')
const rpc = require('..')
const { videoBounds, stripVideoMetadata, VIDEO_MS_TOLERANCE, MAX_VIDEO_SAMPLES } = rpc
const { MAX_VIDEO_MS, MAX_MOMENT_VIDEO_MS, MAX_VIDEO_DIMENSION, MAX_VIDEO_PIXELS } = require('../lib/video-bounds')

const be16 = (v) => [(v >>> 8) & 0xff, v & 0xff]
const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))
const flags = (v) => [0, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const zeros = (n) => new Array(n).fill(0)

function box (type, ...parts) {
  const body = parts.flat()
  return [...be32(8 + body.length), ...ascii(type), ...body]
}

const ftyp = (major = 'isom', compatible = ['isom', 'iso2', 'avc1', 'mp41']) => box('ftyp', ascii(major), be32(0x200), ...compatible.map(ascii))
const mvhd0 = (timescale, duration) => box('mvhd', [0, 0, 0, 0], be32(7), be32(9), be32(timescale), be32(duration), zeros(80))
const mvhd1 = (timescale, duration) => box('mvhd', [1, 0, 0, 0], be32(0), be32(7), be32(0), be32(9), be32(timescale), be32(0), be32(duration), zeros(80))
const ONE = 0x10000
const IDENTITY = [ONE, 0, 0, 0, ONE, 0, 0, 0, 0x40000000]
const TURN_90 = [0, ONE, 0, -ONE, 0, 0, 0, 0, 0x40000000]
const TURN_180 = [-ONE, 0, 0, 0, -ONE, 0, 0, 0, 0x40000000]
const TURN_270 = [0, -ONE, 0, ONE, 0, 0, 0, 0, 0x40000000]

function tkhd ({ id = 1, duration = 0, matrix = IDENTITY, width = 0, height = 0, version = 0 } = {}) {
  const head = version === 0
    ? [flags(7), be32(7), be32(9), be32(id), be32(0), be32(duration)]
    : [[1, 0, 0, 7], be32(0), be32(7), be32(0), be32(9), be32(id), be32(0), be32(0), be32(duration)]
  return box('tkhd', ...head, zeros(16), ...matrix.map((v) => be32(v >>> 0)), be32(width * ONE), be32(height * ONE))
}

const mdhd = (timescale, duration) => box('mdhd', [0, 0, 0, 0], be32(7), be32(9), be32(timescale), be32(duration), [0x55, 0xc4, 0, 0])
const hdlr = (type, name = '') => box('hdlr', [0, 0, 0, 0], be32(0), ascii(type), zeros(12), ascii(name), [0])
// entries: [segment_duration, media_time, rate_integer = 1]
const elst = (version, list) => box('elst', [version, 0, 0, 0], be32(list.length), ...list.map(([seg, time, ri = 1]) => version === 0
  ? [...be32(seg), ...be32(time >>> 0), ...be16(ri), 0, 0]
  : [...be32(0), ...be32(seg), ...(time === -1 ? be32(0xffffffff) : be32(0)), ...be32(time >>> 0), ...be16(ri), 0, 0]))
const edts = (version, list) => box('edts', elst(version, list))
const urlSelf = () => box('url ', flags(1))
const dref = (...list) => box('dref', [0, 0, 0, 0], be32(list.length), ...list)
const stsd = (...list) => box('stsd', [0, 0, 0, 0], be32(list.length), ...list)
const stts = (runs) => box('stts', [0, 0, 0, 0], be32(runs.length), ...runs.map(([c, d]) => [...be32(c), ...be32(d)]))
// runs: [[sample_count, offset], ...]
const ctts = (version, runs) => box('ctts', [version, 0, 0, 0], be32(runs.length), ...runs.map(([c, o]) => [...be32(c), ...be32(o >>> 0)]))
const stss = (list) => box('stss', [0, 0, 0, 0], be32(list.length), ...list.map(be32))
const samplesOf = (runs) => runs.reduce((n, [c]) => n + c, 0)
const ticksOf = (runs) => runs.reduce((n, [c, d]) => n + c * d, 0)

const sps = (profile = 100, level = 40) => [0x67, profile, 0, level, 0xac, 0xd9]
const pps = () => [0x68, 0xeb, 0xe3, 0xcb]
function avcC ({ profile = 100, level = 40, lengthSize = 4, spsList = [sps(profile, level)], ppsList = [pps()], version = 1, tail = [] } = {}) {
  return box('avcC', [version, profile, 0, level, 0xfc | (lengthSize - 1), 0xe0 | spsList.length],
    ...spsList.map((s) => [...be16(s.length), ...s]), [ppsList.length], ...ppsList.map((s) => [...be16(s.length), ...s]), tail)
}
// The High profile avcC tail: chroma_format, bit depths, SPS-ext count.
const highTail = ({ chroma = 1, luma = 0, chromaDepth = 0, ext = [] } = {}) =>
  [0xfc | chroma, 0xf8 | luma, 0xf8 | chromaDepth, ext.length, ...ext.flatMap((s) => [...be16(s.length), ...s])]
const pasp = (h = 1, v = 1) => box('pasp', be32(h), be32(v))
const btrt = () => box('btrt', be32(0), be32(800000), be32(600000))
const colr = () => box('colr', ascii('nclx'), be16(1), be16(1), be16(1), [0])
// [widthN, widthD, heightN, heightD, horizOffN, horizOffD, vertOffN, vertOffD]; full frame by default.
const clap = (v = [640, 1, 360, 1, 0, 1, 0, 1]) => box('clap', ...v.map((x) => be32(x >>> 0)))
function avc1 ({ type = 'avc1', width = 640, height = 360, name = 'x264', kids = [avcC(), pasp(), btrt()] } = {}) {
  const compressor = [name.length, ...ascii(name), ...zeros(31 - name.length)]
  return box(type, zeros(6), be16(1), zeros(16), be16(width), be16(height), be32(0x480000), be32(0x480000), be32(0), be16(1), compressor, be16(0x18), be16(0xffff), ...kids)
}
// dsi: the two-byte AudioSpecificConfig; its first five bits are the audio
// object type (2, AAC-LC, by default).
const esds = (oti = 0x40, dsi = [0x12, 0x10]) => box('esds', [0, 0, 0, 0], [0x03, 0x19, 0, 1, 0, 0x04, 0x11, oti, (5 << 2) | 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, ...dsi, 0x06, 0x01, 0x02])
const mp4a = (...kids) => box('mp4a', zeros(6), be16(1), zeros(20), ...(kids.length ? kids : [esds(), btrt()]))
const opus = () => box('Opus', zeros(6), be16(1), zeros(20), box('dOps', [0, 2, 0x01, 0x38, ...be32(48000), 0, 0, 0]))

// A video track: 90 samples of 100 ticks at 3000 a second (3 s at 30 fps),
// 10 bytes each. Every part can be swapped to build a bad one.
function videoSpec (over = {}) {
  return { kind: 'video', handler: 'vide', id: 1, timescale: 3000, runs: [[90, 100]], sampleSize: 10, perChunk: 90, name: 'VideoHandler', width: 640, height: 360, ...over }
}
// A sound track: AAC frames of 1024 ticks at 48000 a second, just under 3 s.
function soundSpec (over = {}) {
  return { kind: 'sound', handler: 'soun', id: 2, timescale: 48000, runs: [[140, 1024]], sampleSize: 4, perChunk: 140, name: 'SoundHandler', ...over }
}

function chunkCounts (spec) {
  const n = samplesOf(spec.runs)
  const out = []
  for (let left = n; left > 0; left -= spec.perChunk) out.push(Math.min(spec.perChunk, left))
  return out
}

function stscOf (counts) {
  const list = []
  counts.forEach((c, i) => { if (i === 0 || c !== counts[i - 1]) list.push([i + 1, c]) })
  return box('stsc', [0, 0, 0, 0], be32(list.length), ...list.map(([f, n]) => [...be32(f), ...be32(n), ...be32(1)]))
}

function trak (spec, offsets, movieScale) {
  const ticks = ticksOf(spec.runs)
  const n = samplesOf(spec.runs)
  const video = spec.kind === 'video'
  const head = spec.head || tkhd({ id: spec.id, duration: Math.round(ticks / spec.timescale * movieScale), width: video ? spec.width : 0, height: video ? spec.height : 0, matrix: spec.matrix })
  const entry = spec.entries || [video ? avc1({ width: spec.width, height: spec.height }) : mp4a()]
  const sizes = spec.sizes || box('stsz', [0, 0, 0, 0], be32(0), be32(n), ...new Array(n).fill(be32(spec.sampleSize)))
  const offsetBox = spec.co64
    ? box('co64', [0, 0, 0, 0], be32(offsets.length), ...offsets.map((o) => [...be32(0), ...be32(o)]))
    : box('stco', [0, 0, 0, 0], be32(offsets.length), ...offsets.map(be32))
  const stbl = box('stbl', stsd(...entry), stts(spec.runs), ...(spec.ctts ? [spec.ctts] : []), ...(spec.stss ? [spec.stss] : []),
    spec.stsc || stscOf(chunkCounts(spec)), sizes, offsetBox, ...(spec.stblExtra || []))
  const mediaHeader = spec.mediaHeader || (video ? box('vmhd', flags(1), zeros(8)) : box('smhd', zeros(8)))
  const minf = box('minf', mediaHeader, ...(spec.minfExtra || []), box('dinf', dref(...(spec.refs || [urlSelf()])), ...(spec.dinfExtra || [])), stbl)
  const media = spec.media || mdhd(spec.timescale, spec.mediaDuration !== undefined ? spec.mediaDuration : ticks)
  return box('trak', head, ...(spec.edits || []), ...(spec.trakExtra || []), box('mdia', media, hdlr(spec.handler, spec.name), minf, ...(spec.mdiaExtra || [])))
}

// ftyp, then moov and mdat in either order. mdat holds every chunk, the
// chunks of the tracks interleaved, with `gap` bytes no sample covers after
// the first chunk. Video samples are filled with 1, sound samples with 2.
function file ({
  brand,
  compatible,
  tracks = [videoSpec(), soundSpec()],
  ms = 3000,
  mvhd = mvhd0(1000, ms),
  movieScale = 1000,
  mdatFirst = false,
  head = [],
  moovExtra = [],
  tail = [],
  gap = 0,
  move = null
} = {}) {
  const chunks = tracks.map(chunkCounts)
  const payload = []
  const offsets = tracks.map(() => [])
  for (let i = 0; i < Math.max(0, ...chunks.map((c) => c.length)); i++) {
    tracks.forEach((spec, t) => {
      if (i >= chunks[t].length) return
      offsets[t].push(payload.length)
      for (let k = 0; k < chunks[t][i] * spec.sampleSize; k++) payload.push(spec.kind === 'video' ? 1 : 2)
      if (payload.length === offsets[0][0] + chunks[0][0] * tracks[0].sampleSize) for (let k = 0; k < gap; k++) payload.push(0xee)
    })
  }
  const moovOf = (base) => box('moov', mvhd, ...tracks.map((spec, t) => trak(spec, offsets[t].map((o) => (move ? move(t, o) : o) + base), movieScale)), ...moovExtra)
  const start = ftyp(brand, compatible).length + head.length
  const size = moovOf(0).length
  const base = mdatFirst ? start + 8 : start + size + 8
  const moov = moovOf(base)
  const mdat = box('mdat', payload)
  return new Uint8Array([...ftyp(brand, compatible), ...head, ...(mdatFirst ? [...mdat, ...moov] : [...moov, ...mdat]), ...tail])
}

const SOUND_MS = Math.round(140 * 1024 * 1000 / 48000)

function findSeq (hay, needle, from = 0) {
  for (let i = from; i + needle.length <= hay.length; i++) {
    let k = 0
    while (k < needle.length && hay[i + k] === needle[k]) k++
    if (k === needle.length) return i
  }
  return -1
}

// Every [start, end) of the boxes in b, descending into the containers this
// test builds, for truncation at every box boundary.
function boundaries (b) {
  const out = new Set()
  const walk = (start, end) => {
    let p = start
    while (p + 8 <= end) {
      const size = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7])
      if (size < 8 || p + size > end) return
      out.add(p)
      out.add(p + size)
      if (['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl', 'edts', 'udta'].includes(type)) walk(p + 8, p + size)
      if (type === 'stsd' || type === 'dref') walk(p + 16, p + size)
      if (type === 'avc1') walk(p + 8 + 78, p + size)
      if (type === 'mp4a') walk(p + 8 + 28, p + size)
      p += size
    }
  }
  walk(0, b.byteLength)
  return [...out].sort((x, y) => x - y)
}

test('videoBounds: H.264 with AAC gives its duration, size and sound', (t) => {
  t.alike(videoBounds(file()), { ms: 3000, width: 640, height: 360, audio: true })
  t.alike(videoBounds(file({ tracks: [videoSpec()] })), { ms: 3000, width: 640, height: 360, audio: false }, 'video only')
  t.alike(videoBounds(file({ tracks: [soundSpec(), videoSpec()] })), { ms: 3000, width: 640, height: 360, audio: true }, 'the sound track first')
  t.alike(videoBounds(file({ mdatFirst: true })), { ms: 3000, width: 640, height: 360, audio: true }, 'mdat before moov')
  t.alike(videoBounds(file({ mvhd: mvhd1(1000, 3000) })), { ms: 3000, width: 640, height: 360, audio: true }, 'mvhd version 1')
  t.alike(videoBounds(file({ tracks: [videoSpec({ head: tkhd({ version: 1, duration: 3000, width: 640, height: 360 }) })] })), { ms: 3000, width: 640, height: 360, audio: false }, 'tkhd version 1')
  t.alike(videoBounds(file({ tracks: [videoSpec({ co64: true }), soundSpec({ co64: true })] })), { ms: 3000, width: 640, height: 360, audio: true }, 'co64 chunk offsets')
  for (const profile of [66, 77, 100]) {
    const entries = [avc1({ kids: [avcC({ profile })] })]
    t.alike(videoBounds(file({ tracks: [videoSpec({ entries })] })), { ms: 3000, width: 640, height: 360, audio: false }, 'profile ' + profile)
  }
  for (const brand of ['iso5', 'mp42', 'avc1']) t.ok(videoBounds(file({ brand, compatible: [brand] })), 'brand ' + brand)
  const big = [videoSpec({ width: MAX_VIDEO_DIMENSION, height: 1080, entries: [avc1({ width: 1920, height: 1080 })] })]
  t.alike(videoBounds(file({ tracks: big })), { ms: 3000, width: 1920, height: 1080, audio: false }, 'the largest landscape')
  t.alike(videoBounds(file({ ms: MAX_VIDEO_MS, tracks: [videoSpec({ runs: [[900, 100]] })] })), { ms: MAX_VIDEO_MS, width: 640, height: 360, audio: false }, 'the longest')
  t.alike(videoBounds(file({ tracks: [videoSpec({ runs: [[MAX_VIDEO_SAMPLES, 1]], timescale: 1000, sampleSize: 1, perChunk: MAX_VIDEO_SAMPLES })], ms: MAX_VIDEO_SAMPLES })), { ms: MAX_VIDEO_SAMPLES, width: 640, height: 360, audio: false }, 'the most samples')
})

test('videoBounds: the tkhd matrix turns the display size', (t) => {
  const turned = (matrix) => videoBounds(file({ tracks: [videoSpec({ matrix }), soundSpec()] }))
  t.alike(turned(TURN_90), { ms: 3000, width: 360, height: 640, audio: true }, '90 degrees swaps the sides')
  t.alike(turned(TURN_270), { ms: 3000, width: 360, height: 640, audio: true }, '270 degrees swaps the sides')
  t.alike(turned(TURN_180), { ms: 3000, width: 640, height: 360, audio: true }, '180 degrees keeps them')
  const moved = [0, ONE, 0, -ONE, 0, 0, 360 * ONE, 0, 0x40000000]
  t.ok(turned(moved), 'a translation with the turn, as phone cameras write')
  t.is(turned([2 * ONE, 0, 0, 0, 2 * ONE, 0, 0, 0, 0x40000000]), null, 'a scale')
  t.is(turned([ONE, ONE, 0, 0, ONE, 0, 0, 0, 0x40000000]), null, 'a skew')
  t.is(turned([ONE, 0, 0, 0, -ONE, 0, 0, 0, 0x40000000]), null, 'a mirror')
  t.is(turned([ONE, 0, 1, 0, ONE, 0, 0, 0, 0x40000000]), null, 'a perspective term')
  t.is(turned([ONE, 0, 0, 0, ONE, 0, 0, 0, 0x20000000]), null, 'another w')
  t.is(turned([0, 0, 0, 0, 0, 0, 0, 0, 0]), null, 'all zeros')
  const wide = videoSpec({ width: 1921, height: 1080, matrix: TURN_90, entries: [avc1({ width: 1920, height: 1080 })] })
  t.is(videoBounds(file({ tracks: [wide] })), null, 'a turned display with a side past the cap')
  const ok = videoSpec({ width: 1920, height: 1080, matrix: TURN_90, entries: [avc1({ width: 1920, height: 1080 })] })
  t.alike(videoBounds(file({ tracks: [ok] })), { ms: 3000, width: 1080, height: 1920, audio: false }, 'a phone portrait')
})

test('videoBounds: dimensions are bounded', (t) => {
  const sized = (width, height, entry = { width, height }) => videoBounds(file({ tracks: [videoSpec({ width, height, entries: [avc1(entry)] })] }))
  t.is(sized(1921, 360), null, 'a side of 1921')
  t.is(sized(360, 1921), null, 'a height of 1921')
  t.is(sized(1920, 1920), null, '1920x1920')
  t.ok(1920 * 1080 === MAX_VIDEO_PIXELS && sized(1920, 1080), 'exactly the pixel cap')
  t.is(sized(0, 360), null, 'a zero width')
  t.is(sized(640, 360, { width: 1921, height: 360 }), null, 'a coded width of 1921')
  t.is(sized(640, 360, { width: 1920, height: 1920 }), null, 'a coded 1920x1920')
  t.is(sized(640, 360, { width: 0, height: 360 }), null, 'a zero coded width')
})

test('videoBounds: only H.264 avc1 with a valid avcC', (t) => {
  const one = (entry) => videoBounds(file({ tracks: [videoSpec({ entries: [entry] })] }))
  t.is(one(avc1({ type: 'hvc1', kids: [box('hvcC', zeros(23))] })), null, 'hvc1')
  t.is(one(avc1({ type: 'hev1', kids: [box('hvcC', zeros(23))] })), null, 'hev1')
  t.is(one(avc1({ type: 'avc3' })), null, 'avc3')
  t.is(one(avc1({ type: 'encv' })), null, 'an encrypted entry')
  t.is(one(avc1({ type: 'mp4v' })), null, 'MPEG-4 part 2')
  t.is(one(avc1({ kids: [avcC({ level: 43 })] })), null, 'level 43')
  t.is(one(avc1({ kids: [avcC({ level: 43, spsList: [sps(100, 40)] })] })), null, 'level 43 in the avcC header only')
  t.is(one(avc1({ kids: [avcC({ spsList: [sps(100, 43)] })] })), null, 'level 43 in the SPS only')
  t.ok(one(avc1({ kids: [avcC({ level: 42 })] })), 'level 42')
  t.is(one(avc1({ kids: [avcC({ profile: 88 })] })), null, 'the extended profile')
  t.is(one(avc1({ kids: [avcC({ profile: 110 })] })), null, 'High 10')
  t.is(one(avc1({ kids: [avcC({ profile: 100, spsList: [sps(244, 40)] })] })), null, 'an SPS naming another profile')
  t.is(one(avc1({ kids: [avcC({ lengthSize: 2 })] })), null, 'two-byte NAL lengths')
  t.is(one(avc1({ kids: [avcC({ spsList: [] })] })), null, 'no SPS')
  t.is(one(avc1({ kids: [avcC({ ppsList: [] })] })), null, 'no PPS')
  t.is(one(avc1({ kids: [avcC({ version: 2 })] })), null, 'configurationVersion 2')
  t.is(one(avc1({ kids: [avcC({ spsList: [[0x68, 100, 0, 40]] })] })), null, 'an SPS that is not one')
  t.is(one(avc1({ kids: [avcC({ ppsList: [[0x67, 1]] })] })), null, 'a PPS that is not one')
  t.is(one(avc1({ kids: [box('avcC', [1, 100, 0, 40, 0xff, 0xe1, 0x00, 0x40, 0x67])] })), null, 'an SPS past its box')
  t.is(one(avc1({ kids: [box('avcC', [1, 100, 0, 40, 0xff, 0xe1, 0, 4, 0x67, 100, 0, 40, 1, 0, 9, 0x68])] })), null, 'a PPS past its box')
  t.ok(one(avc1({ kids: [avcC({ tail: highTail() })] })), 'a High profile tail: 4:2:0, 8 bits, no SPS-ext')
  t.ok(one(avc1({ kids: [avcC({ tail: [1, 0, 0, 0] })] })), 'a High profile tail with its reserved bits clear')
  t.ok(one(avc1({ kids: [avcC()] })), 'High profile without a tail')
  t.is(one(avc1({ kids: [avcC({ tail: highTail({ chroma: 3 }) })] })), null, 'a 4:4:4 tail')
  t.is(one(avc1({ kids: [avcC({ tail: highTail({ luma: 2 }) })] })), null, 'a 10-bit luma tail')
  t.is(one(avc1({ kids: [avcC({ tail: highTail({ chromaDepth: 2 }) })] })), null, 'a 10-bit chroma tail')
  t.is(one(avc1({ kids: [avcC({ tail: highTail({ ext: [[0x6d, 1, 2]] }) })] })), null, 'one SPS-ext')
  t.is(one(avc1({ kids: [avcC({ profile: 77, tail: highTail() })] })), null, 'a tail on Main profile')
  t.is(one(avc1({ kids: [avcC({ profile: 66, tail: [0] })] })), null, 'a trailing byte on Baseline profile')
  t.is(one(avc1({ kids: [avcC({ tail: highTail().slice(0, 3) })] })), null, 'a truncated tail')
  t.is(one(avc1({ kids: [avcC({ tail: [...highTail(), 0] })] })), null, 'a byte after the tail')
  t.is(one(avc1({ kids: [] })), null, 'no avcC')
  t.is(one(avc1({ kids: [avcC(), avcC()] })), null, 'two avcC')
  t.is(one(avc1({ kids: [avcC(), pasp(4, 3)] })), null, 'non-square pixels')
  t.is(one(avc1({ kids: [avcC(), pasp(0, 0)] })), null, 'a zero pasp')
  t.is(one(avc1({ kids: [avcC(), pasp(), pasp()] })), null, 'two pasp')
  t.ok(one(avc1({ kids: [avcC(), pasp(), colr(), btrt(), clap(), box('fiel', [1, 0]), box('chrm', zeros(2))] })), 'every allowed child')
  t.ok(one(avc1({ kids: [avcC(), clap([1200, 2, 352, 1, -40, 2, 4, 1])] })), 'a clap of 600x352 at the left edge, 8 rows off centre')
  t.is(one(avc1({ kids: [avcC(), box('clap', zeros(32))] })), null, 'an all-zero clap')
  t.is(one(avc1({ kids: [avcC(), box('clap', be32(640), be32(1), be32(360), be32(1))] })), null, 'a clap shorter than 32 bytes')
  t.is(one(avc1({ kids: [avcC(), clap([640, 0, 360, 1, 0, 1, 0, 1])] })), null, 'a clap width denominator of 0')
  t.is(one(avc1({ kids: [avcC(), clap([640, 1, 360, 1, 0, 1, 0, 0])] })), null, 'a clap vertical offset denominator of 0')
  t.is(one(avc1({ kids: [avcC(), clap([641, 1, 360, 1, 0, 1, 0, 1])] })), null, 'a clap wider than the coded width')
  t.is(one(avc1({ kids: [avcC(), clap([640, 1, 361, 1, 0, 1, 0, 1])] })), null, 'a clap taller than the coded height')
  t.is(one(avc1({ kids: [avcC(), clap([600, 1, 360, 1, 21, 1, 0, 1])] })), null, 'a clap offset that pushes it past the right edge')
  t.is(one(avc1({ kids: [avcC(), clap([640, 1, 340, 1, 0, 1, -11, 1])] })), null, 'a clap offset that pushes it past the top')
  // An offset of -1 and large denominators: the cross products pass 2^53.
  t.ok(one(avc1({ kids: [avcC(), clap([640, 1, 358 * 11000000, 11000000, 0, 1, -0x7fffffff, 0x7fffffff])] })), 'a clap touching the top edge, with large terms')
  t.is(one(avc1({ kids: [avcC(), clap([640, 1, 359 * 11000000, 11000000, 0, 1, -0x7fffffff, 0x7fffffff])] })), null, 'a clap one row past the top edge, with large terms')
  t.ok(one(avc1({ kids: [avcC(), clap([600, 1, 360, 1, -20, 1, 0, 1])] })), 'a clap offset that reaches the left edge exactly')
  t.ok(one(avc1({ kids: [avcC(), box('free', [1, 2])] })), 'a free box in the entry')
  t.is(one(avc1({ kids: [avcC(), box('sinf', box('frma', ascii('avc1')))] })), null, 'protection info')
  t.is(one(avc1({ kids: [avcC(), box('dvcC', zeros(24))] })), null, 'a child outside the list')
  t.is(videoBounds(file({ tracks: [videoSpec({ entries: [avc1(), avc1()] })] })), null, 'two entries')
  const bad = avc1()
  bad.splice(8 + 6, 2, 0, 2)
  t.is(one(bad), null, 'a data reference index of 2')
})

test('videoBounds: one video track and at most one AAC sound track', (t) => {
  t.is(videoBounds(file({ tracks: [videoSpec(), videoSpec({ id: 2 })] })), null, 'two video tracks')
  t.is(videoBounds(file({ tracks: [soundSpec()] })), null, 'sound only')
  t.is(videoBounds(file({ tracks: [] })), null, 'no track')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec(), soundSpec({ id: 3 })] })), null, 'two sound tracks')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ entries: [opus()] })] })), null, 'an Opus sound entry')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ entries: [mp4a(esds(0x6b))] })] })), null, 'MP3 in an mp4a')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ entries: [box('mp4a', zeros(28))] })] })), null, 'an mp4a without esds')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ entries: [box('enca', zeros(28), esds())] })] })), null, 'encrypted sound')
  for (const index of [0, 2]) {
    const entry = box('mp4a', zeros(6), be16(index), zeros(20), esds(), btrt())
    t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ entries: [entry] })] })), null, 'an mp4a data reference index of ' + index)
  }
  const urlEsds = box('esds', [0, 0, 0, 0], [0x03, 0x1e, 0, 1, 0x40, 4, ...ascii('http'), 0x04, 0x11, 0x40, (5 << 2) | 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02])
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ entries: [mp4a(urlEsds)] })] })), null, 'an ES_Descriptor with a URL')
  const text = soundSpec({ handler: 'text', entries: [box('tx3g', zeros(38))], mediaHeader: box('nmhd', zeros(4)) })
  t.is(videoBounds(file({ tracks: [videoSpec(), text] })), null, 'a text track')
  // What an iPhone or AVAssetWriter writes for timed location: a 'meta' handler over an mebx entry.
  const timed = soundSpec({ handler: 'meta', entries: [box('mebx', zeros(8), box('keys', zeros(8)))], mediaHeader: box('nmhd', zeros(4)) })
  t.is(videoBounds(file({ tracks: [videoSpec(), timed] })), null, 'a timed metadata track')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec(), timed] })), null, 'three tracks')
  t.is(videoBounds(file({ tracks: [videoSpec({ mediaHeader: box('smhd', zeros(8)) })] })), null, 'a video track with a sound header')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ mediaHeader: box('vmhd', flags(1), zeros(8)) })] })), null, 'a sound track with a video header')
  t.is(videoBounds(file({ tracks: [videoSpec({ entries: [mp4a()] })] })), null, "a 'vide' handler over an mp4a entry")
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ entries: [avc1()] })] })), null, "a 'soun' handler over an avc1 entry")
  t.is(videoBounds(file({ tracks: [videoSpec({ head: box('free') }), soundSpec()] })), null, 'a video track without tkhd')
  t.is(videoBounds(file({ tracks: [videoSpec({ trakExtra: [tkhd({ width: 640, height: 360 })] })] })), null, 'two tkhd')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ stblExtra: [ctts(0, [[140, 0]])] })] })), null, 'a ctts on the sound track')
})

test('videoBounds: fragments, protection and stray top-level boxes are refused', (t) => {
  const moof = box('moof', box('mfhd', [0, 0, 0, 0], be32(1)), box('traf', box('tfhd', flags(0x20000), be32(1))))
  t.is(videoBounds(file({ tail: moof })), null, 'a moof')
  t.is(videoBounds(file({ moovExtra: [box('mvex', box('trex', [0, 0, 0, 0], be32(1), be32(1), be32(0), be32(0), be32(0)))] })), null, 'an mvex')
  t.is(videoBounds(file({ tail: box('styp', ascii('msdh'), be32(0)) })), null, 'a styp')
  t.is(videoBounds(file({ tail: box('sidx', zeros(32)) })), null, 'a sidx')
  t.is(videoBounds(file({ moovExtra: [box('pssh', zeros(28))] })), null, 'a pssh')
  t.is(videoBounds(file({ tracks: [videoSpec({ stblExtra: [box('senc', zeros(8))] })] })), null, 'a senc')
  t.is(videoBounds(file({ tracks: [videoSpec({ stblExtra: [box('saiz', zeros(9))] })] })), null, 'a saiz')
  t.is(videoBounds(file({ tail: box('junk', [1]) })), null, 'an unknown top-level box')
  t.is(videoBounds(file({ tail: ftyp() })), null, 'a second ftyp')
  t.ok(videoBounds(file({ head: [...box('free', [1]), ...box('wide')], tail: box('skip', [3]) })), 'free, wide and skip at top level')
  t.ok(videoBounds(file({ moovExtra: [box('free', [1])], tracks: [videoSpec({ trakExtra: [box('skip', [2])] })] })), 'free and skip inside moov and trak')
  const late = new Uint8Array([...box('free'), ...file()])
  t.is(videoBounds(late), null, 'ftyp not first')
  const twoMoov = file({ tail: box('moov', mvhd0(1000, 3000)) })
  t.is(videoBounds(twoMoov), null, 'two moov boxes')
  t.is(videoBounds(new Uint8Array([...ftyp(), ...box('mdat', [1])])), null, 'no moov')
  t.is(videoBounds(file({ brand: 'qt  ', compatible: ['qt  '] })), null, 'QuickTime only')
  t.is(videoBounds(file({ brand: 'M4A ', compatible: ['M4A '] })), null, 'an audio brand only')
  t.is(videoBounds(file({ brand: 'heic', compatible: ['mif1'] })), null, 'an image brand')
})

test('videoBounds: a received video carries no udta, meta or uuid', (t) => {
  const udta = () => box('udta', box('©xyz', be16(18), be16(0x15c7), ascii('+00.0000+000.0000/')))
  const meta = () => box('meta', [0, 0, 0, 0], hdlr('mdir'), box('ilst', box('©too', box('data', be32(1), be32(0), ascii('Lavf')))))
  const uuid = () => box('uuid', new Array(16).fill(7), [1, 2])
  const cases = [
    ['top level', (x) => file({ tail: x })],
    ['moov', (x) => file({ moovExtra: [x] })],
    ['trak', (x) => file({ tracks: [videoSpec({ trakExtra: [x] }), soundSpec()] })],
    ['minf', (x) => file({ tracks: [videoSpec({ minfExtra: [x] }), soundSpec()] })],
    ['stbl', (x) => file({ tracks: [videoSpec({ stblExtra: [x] }), soundSpec()] })],
    ['the sound stbl', (x) => file({ tracks: [videoSpec(), soundSpec({ stblExtra: [x] })] })],
    ['edts', (x) => file({ tracks: [videoSpec({ edits: [box('edts', elst(0, [[3000, 0]]), x)] })] })],
    ['avc1', (x) => file({ tracks: [videoSpec({ entries: [avc1({ kids: [avcC(), x] })] })] })],
    ['mp4a', (x) => file({ tracks: [videoSpec(), soundSpec({ entries: [mp4a(esds(), x)] })] })]
  ]
  for (const [where, make] of cases) {
    t.ok(videoBounds(make(box('free', [0]))), 'a free box in ' + where + ' passes')
    for (const [name, x] of [['udta', udta()], ['meta', meta()], ['uuid', uuid()]]) {
      const input = make(x)
      t.is(videoBounds(input), null, 'a ' + name + ' box in ' + where)
      t.ok(videoBounds(input, { metadata: true }), 'the sender skips ' + name + ' in ' + where)
      const out = stripVideoMetadata(input)
      t.ok(out && videoBounds(out), 'stripped ' + name + ' in ' + where + ' passes the strict check')
    }
  }
  const loop = file({ moovExtra: [box('meta', [0, 0, 0, 0], box('ilst', be32(0), ascii('data')))] })
  t.is(videoBounds(loop), null, 'a zero-size ilst entry')
  t.ok(videoBounds(loop, { metadata: true }), 'the sender skips it unparsed')
  t.is(videoBounds(file({ moovExtra: [udta()] }), { metadata: 1 }), null, 'metadata must be exactly true')
  t.is(videoBounds(file({ moovExtra: [udta()] }), null), null, 'a null options object')
})

test('videoBounds: durations and sample counts are bounded', (t) => {
  t.is(videoBounds(file({ ms: MAX_VIDEO_MS + 1, tracks: [videoSpec({ timescale: 1000, runs: [[900, 33], [1, 301]] })] })), null, '30001 ms')
  t.ok(videoBounds(file({ ms: MAX_VIDEO_MS, tracks: [videoSpec({ timescale: 1000, runs: [[900, 33], [1, 300]] })] })), '30000 ms')
  t.is(videoBounds(file({ ms: 1801, tracks: [videoSpec({ timescale: 1000, runs: [[MAX_VIDEO_SAMPLES + 1, 1]], sampleSize: 1, perChunk: 2000 })] })), null, '1801 samples')
  t.is(videoBounds(file({ ms: 0, tracks: [videoSpec({ runs: [] })] })), null, 'no samples')
  t.is(videoBounds(file({ tracks: [videoSpec({ runs: [[90, 0]] })] })), null, 'zero-length samples')
  t.is(videoBounds(file({ tracks: [videoSpec({ runs: [[1, 0xffffffff]] })] })), null, 'one huge sample')
  const moment = file({ ms: MAX_MOMENT_VIDEO_MS + 1, tracks: [videoSpec({ timescale: 1000, runs: [[1, MAX_MOMENT_VIDEO_MS + 1]] })] })
  t.ok(videoBounds(moment), 'a post may be 15001 ms')
  t.is(videoBounds(moment, { maxMs: MAX_MOMENT_VIDEO_MS }), null, 'a momento may not')
  t.ok(videoBounds(file(), { maxMs: MAX_MOMENT_VIDEO_MS }), 'a 3 s momento')
  t.is(videoBounds(file(), { maxMs: MAX_VIDEO_MS + 1 }), null, 'a cap above the post cap')
  t.is(videoBounds(file(), { maxMs: 0 }), null, 'a zero cap')
  t.is(videoBounds(file(), { maxMs: '3000' }), null, 'a cap that is not a number')
  t.is(videoBounds(file(), { maxMs: 2999.5 }), null, 'a cap that is not an integer')
  t.alike(videoBounds(file({ tracks: [videoSpec(), soundSpec({ runs: [[187, 1024]] })] })), { ms: 3000, width: 640, height: 360, audio: true }, 'sound within the tolerance past the video')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ runs: [[188, 1024]] })] })), null, 'sound past the video by more than the tolerance')
  t.ok(Math.round(187 * 1024 * 1000 / 48000) - 3000 <= VIDEO_MS_TOLERANCE && Math.round(188 * 1024 * 1000 / 48000) - 3000 > VIDEO_MS_TOLERANCE, 'the two sound lengths straddle the tolerance')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ runs: [[20001, 1]], sampleSize: 1, perChunk: 20001 })] })), null, 'more than 20000 sound samples')
})

test('videoBounds: headers agree with the samples', (t) => {
  t.is(videoBounds(file({ mvhd: mvhd0(1000, 9000) })), null, 'an mvhd longer than the samples')
  t.ok(videoBounds(file({ mvhd: mvhd0(1000, 3900) })), 'an mvhd within the tolerance')
  t.ok(videoBounds(file({ mvhd: mvhd0(1000, 0) })), 'an mvhd without a duration')
  t.is(videoBounds(file({ tracks: [videoSpec({ mediaDuration: 9000 * 3 })] })), null, 'an mdhd longer than the samples')
  t.is(videoBounds(file({ tracks: [videoSpec({ head: tkhd({ duration: 9000, width: 640, height: 360 }) })] })), null, 'a tkhd longer than the samples')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ mediaDuration: 48000 * 9 })] })), null, 'a sound mdhd longer than its samples')
  t.is(videoBounds(file({ mvhd: mvhd0(0, 3000) })), null, 'a zero movie timescale')
  t.is(videoBounds(file({ tracks: [videoSpec({ timescale: 0 })] })), null, 'a zero media timescale')
  const liar = file({ mvhd: mvhd0(1000, 9000), tracks: [videoSpec({ mediaDuration: 1, head: tkhd({ duration: 7000, width: 640, height: 360 }) }), soundSpec({ mediaDuration: 48000 * 9 })] })
  t.is(videoBounds(liar), null, 'headers off the samples on receipt')
  t.alike(videoBounds(liar, { metadata: true }), { ms: 3000, width: 640, height: 360, audio: true }, 'the sender reads the samples')
  const out = stripVideoMetadata(liar)
  t.alike(videoBounds(out), { ms: 3000, width: 640, height: 360, audio: true }, 'the stripped copy passes')
  const durationAt = (bytes, type, at, from = 0) => {
    const p = findSeq(bytes, ascii(type), from) + 4
    return ((bytes[p + at] << 24) | (bytes[p + at + 1] << 16) | (bytes[p + at + 2] << 8) | bytes[p + at + 3]) >>> 0
  }
  t.is(durationAt(out, 'mvhd', 16), 3000, 'mvhd rewritten from the video samples')
  t.is(durationAt(out, 'tkhd', 20), 3000, 'video tkhd rewritten')
  t.is(durationAt(out, 'mdhd', 16), 9000, 'video mdhd in its own timescale')
  const second = findSeq(out, ascii('mdhd')) + 4
  t.is(durationAt(out, 'mdhd', 16, second), 140 * 1024, 'sound mdhd in its own timescale')
  t.is(durationAt(out, 'tkhd', 20, findSeq(out, ascii('tkhd')) + 4), SOUND_MS, 'sound tkhd in the movie timescale')
  t.is(stripVideoMetadata(file({ tracks: [videoSpec({ edits: [edts(0, [[9000, 0]])] })] })), null, 'an edit list off the samples is not stripped into a valid file')
})

test('videoBounds: the edit list agrees with the samples', (t) => {
  const edited = (edits, extra = {}) => videoBounds(file({ tracks: [videoSpec({ edits, ...extra })] }))
  t.ok(edited([edts(0, [[3000, 0]])]), 'an agreeing edit list')
  t.ok(edited([edts(1, [[3000, 0]])]), 'version 1')
  t.ok(edited([edts(0, [[100, -1], [2900, 0]])]), 'a short empty edit first')
  t.ok(edited([edts(0, [[0, 0]])]), 'a whole-media edit')
  t.is(edited([edts(0, [[9000, 0]])]), null, 'an edit list longer than the samples')
  t.is(edited([edts(0, [[1500, 0], [1500, 0]])]), null, 'two media edits')
  t.is(edited([edts(0, [[3000, 0, 2]])]), null, 'rate 2')
  t.is(edited([edts(0, [[2000, -1], [1000, 0]])]), null, 'a long empty edit, though the segments add up to the samples')
  t.is(edited([edts(0, [[3000, 0], [100, -1]])]), null, 'an empty edit last')
  t.is(edited([edts(0, [[3000, 0]]), edts(0, [[3000, 0]])]), null, 'two edts')
  t.is(edited([box('edts')]), null, 'an edts without elst')
  t.is(edited([edts(0, [])]), null, 'an empty elst')
  t.is(edited([edts(0, [[3000, 9100]])]), null, 'a media_time past the samples (every sample would be negative)')
  const soundEdited = (list) => videoBounds(file({ tracks: [videoSpec(), soundSpec({ edits: [edts(0, list)] })] }))
  const soundTicks = 140 * 1024
  t.ok(soundEdited([[SOUND_MS, 2112]]), 'a sound edit skipping the AAC priming')
  t.ok(soundEdited([[0, 2112]]), 'a whole-media sound edit skipping the AAC priming')
  t.is(soundEdited([[SOUND_MS, 0x7fffffff]]), null, 'a sound media_time far past the samples')
  t.is(soundEdited([[0, 0x7fffffff]]), null, 'a whole-media sound edit far past the samples')
  t.is(soundEdited([[SOUND_MS, soundTicks]]), null, 'a sound media_time at the end of the samples')
  t.is(soundEdited([[0, soundTicks]]), null, 'a whole-media sound edit at the end of the samples')
})

// I P B P B ... at 100 ticks a frame: decode order puts each P before the B
// it follows, so P is shown 200 ticks after its decode time, B at once, and
// the first frame 100 ticks late; an edit at media_time 100 brings it to 0.
function bframes ({ first = 100, last = 200, version = 0, drop = 0 } = {}) {
  const runs = [[1, first]]
  for (let i = 1; i < 90 - drop; i++) runs.push([1, i === 89 ? last : i % 2 ? 200 : 0])
  return ctts(version, runs)
}

test('videoBounds: composition offsets keep every frame on the timeline', (t) => {
  const bf = (c, edits = [edts(0, [[3000, 100]])]) => videoBounds(file({ tracks: [videoSpec({ ctts: c, stss: stss([1, 31, 61]), edits }), soundSpec()] }))
  t.alike(bf(bframes()), { ms: 3000, width: 640, height: 360, audio: true }, 'a B-frame layout with an agreeing edit list')
  t.ok(bf(bframes({ version: 1 })), 'ctts version 1')
  t.ok(bf(bframes(), []), 'without an edit list, every frame starts 100 ticks late')
  // The last sample decodes at 8900, lasts 100 and the edit takes 100 off,
  // against a limit of 9000 ticks plus 3000 (the tolerance at 3000 a second).
  t.ok(bf(bframes({ last: 3100 })), 'one sample ending at duration plus tolerance')
  t.is(bf(bframes({ last: 3101 })), null, 'one sample ending past duration plus tolerance')
  // Two 15 s samples at 100 a second: the second starts at 31 s, within
  // 30 s plus tolerance, but ends at 46 s.
  const late = videoBounds(file({ ms: 30000, tracks: [videoSpec({ timescale: 100, runs: [[2, 1500]], ctts: ctts(0, [[1, 0], [1, 1600]]) })] }))
  t.is(late, null, 'a sample starting in range but ending past duration plus tolerance')
  t.is(bf(ctts(1, [[1, -200], [89, 0]]), []), null, 'a version 1 negative offset before 0')
  t.is(bf(bframes({ first: 0 })), null, 'the first frame before 0 after the edit')
  t.is(bf(bframes({ drop: 1 })), null, 'a ctts with one sample fewer than stts')
  t.is(bf(ctts(0, [[91, 0]])), null, 'a ctts with one sample more than stts')
  t.is(bf(ctts(0, [[0, 0], [90, 100]])), null, 'a ctts run of zero samples')
  t.is(bf(ctts(2, [[90, 100]])), null, 'ctts version 2')
  t.is(bf(ctts(0, [[90, 0xffffff00]])), null, 'a version 0 offset of four billion')
  const two = videoBounds(file({ tracks: [videoSpec({ stblExtra: [bframes(), bframes()], edits: [edts(0, [[3000, 100]])] })] }))
  t.is(two, null, 'two ctts')
  const lying = bframes()
  lying.splice(12, 4, ...be32(1000))
  t.is(bf(lying), null, 'a ctts claiming more entries than its bytes')
})

test('videoBounds: sync samples stay within the samples', (t) => {
  const synced = (s) => videoBounds(file({ tracks: [videoSpec({ stss: s })] }))
  t.ok(synced(stss([1, 90])), 'first and last')
  t.is(synced(stss([91])), null, 'a sync sample past the last')
  t.is(synced(stss([0])), null, 'sample 0')
  t.is(synced(stss(new Array(91).fill(1))), null, 'more entries than samples')
  t.is(synced(box('stss', [0, 0, 0, 0], be32(5), be32(1))), null, 'an entry count past its bytes')
  const soundSynced = (x) => videoBounds(file({ tracks: [videoSpec(), soundSpec({ stss: x })] }))
  t.ok(soundSynced(stss([1, 140])), 'a sound stss within the sound samples')
  t.is(soundSynced(box('stss', [0, 0, 0, 0], be32(0xffffffff), be32(1))), null, 'a sound stss claiming four billion entries in a short box')
  t.is(soundSynced(stss([141])), null, 'a sound sync sample past the last')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ stss: stss([1]), stblExtra: [stss([1])] })] })), null, 'two sound stss')
})

test('videoBounds: every chunk lies inside a top-level mdat', (t) => {
  t.is(videoBounds(file({ move: (track, o) => track === 0 ? o + 100000 : o })), null, 'a chunk past the end')
  t.is(videoBounds(file({ move: (track, o) => track === 1 ? o + 10000 : o })), null, 'a sound chunk past the end')
  t.is(videoBounds(file({ move: (track, o) => o - 64 })), null, 'a chunk starting before the mdat payload')
  const inMoov = file({ mdatFirst: false, move: (track, o) => o - 400 })
  t.is(videoBounds(inMoov), null, 'a chunk inside moov')
  t.is(videoBounds(file({ move: (track, o) => track === 0 ? o + 1 : o, tracks: [videoSpec()] })), null, 'the last chunk one byte past')
  // A second mdat after the first, whose 900-byte payload holds the video
  // chunk as built: moving the chunk by 908 puts it at the second payload.
  const second = box('mdat', new Array(900).fill(1))
  const twoMdats = (shift) => file({ tracks: [videoSpec()], tail: second, move: (track, o) => o + shift })
  const moved = twoMdats(908)
  t.alike(videoBounds(moved), { ms: 3000, width: 640, height: 360, audio: false }, 'a chunk in a second mdat')
  t.is(videoBounds(twoMdats(904)), null, 'a chunk over the second mdat header')
  t.is(videoBounds(twoMdats(450)), null, 'a chunk across two mdat boxes')
  const out = stripVideoMetadata(moved)
  const firstAt = findSeq(moved, ascii('mdat')) + 4
  t.ok(out && out.subarray(firstAt, firstAt + 900).every((v) => v === 0), 'strip zeroes an mdat no sample uses')
  t.ok(out && out.subarray(out.byteLength - 900).every((v) => v === 1), 'and keeps the one the samples use')
  const split = [videoSpec({ perChunk: 7 }), soundSpec({ perChunk: 11 })]
  t.alike(videoBounds(file({ tracks: split })), { ms: 3000, width: 640, height: 360, audio: true }, 'interleaved chunks')
  t.ok(videoBounds(file({ tracks: split, gap: 33 })), 'bytes no sample covers')
  t.is(videoBounds(file({ tracks: [videoSpec({ sizes: box('stsz', [0, 0, 0, 0], be32(0), be32(89), ...new Array(89).fill(be32(10))) })] })), null, 'a size table with one sample fewer')
  const fewer = videoSpec({ sizes: box('stsz', [0, 0, 0, 0], be32(0), be32(89), ...new Array(89).fill(be32(10))), stsc: stscOf([89]) })
  t.is(videoBounds(file({ tracks: [fewer] })), null, 'size and chunk tables agreeing on one sample fewer than stts')
  t.is(videoBounds(file({ tracks: [videoSpec({ sizes: box('stsz', [0, 0, 0, 0], be32(0), be32(90), ...new Array(90).fill(be32(0))) })] })), null, 'empty samples')
  t.ok(videoBounds(file({ tracks: [videoSpec({ sizes: box('stsz', [0, 0, 0, 0], be32(10), be32(90)) })] })), 'a constant sample size')
  t.is(videoBounds(file({ tracks: [videoSpec({ sizes: box('stsz', [0, 0, 0, 0], be32(11), be32(90)) })] })), null, 'a constant size that runs the chunk past mdat')
  t.is(videoBounds(file({ tracks: [videoSpec({ sizes: box('stsz', [0, 0, 0, 0], be32(0), be32(90)) })] })), null, 'per-sample sizes past the box')
})

test('videoBounds: every data reference stays in the file', (t) => {
  const urlRemote = box('url ', flags(0), ascii('https://example.com/x.mp4'), [0])
  t.is(videoBounds(file({ tracks: [videoSpec({ refs: [urlRemote] })] })), null, 'a remote dref')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ refs: [urlRemote] })] })), null, 'a remote dref on the sound track')
  t.is(videoBounds(file({ tracks: [videoSpec({ refs: [urlSelf(), box('urn ', flags(0), ascii('urn:x'), [0], [0])] })] })), null, 'an urn after a local one')
  t.is(videoBounds(file({ tracks: [videoSpec({ refs: [] })] })), null, 'no reference')
})

test('videoBounds: truncation and hostile sizes never pass, never throw', (t) => {
  const good = file({ tracks: [videoSpec({ ctts: bframes(), edits: [edts(0, [[3000, 100]])] }), soundSpec()] })
  t.ok(videoBounds(good), 'the file passes whole')
  const passed = []
  for (const n of boundaries(good)) {
    if (n < good.byteLength && videoBounds(good.subarray(0, n)) !== null) passed.push(n)
  }
  t.alike(passed, [], 'no truncation at a box boundary passes')
  const anywhere = []
  for (let n = 0; n < good.byteLength; n += 3) if (videoBounds(good.subarray(0, n)) !== null) anywhere.push(n)
  t.alike(anywhere, [], 'no truncation every third byte passes')

  const sized = (at, size) => {
    const b = good.slice()
    b.set(be32(size), at)
    return videoBounds(b)
  }
  const moov = findSeq(good, ascii('moov')) - 4
  const stblAt = findSeq(good, ascii('stbl')) - 4
  for (const [name, at] of [['ftyp', 0], ['moov', moov], ['stbl', stblAt]]) {
    t.is(sized(at, 0x7fffffff), null, 'a huge ' + name)
    t.is(sized(at, 0xffffffff), null, 'a ' + name + ' of four gigabytes')
    t.is(sized(at, 4), null, 'a ' + name + ' smaller than its header')
    t.is(sized(at, 1), null, 'a 64-bit ' + name + ' size past the parent')
  }
  t.is(sized(moov, 0), null, 'a moov running to the end of the file swallows mdat')
  const big = good.slice()
  big.set(be32(1), moov)
  t.is(videoBounds(big), null, 'a 64-bit size field over the moov body')

  const hostile = [undefined, null, 'video', 42, [], {}, new ArrayBuffer(16), new Uint8Array(0), new Uint8Array(8), new Uint8Array(64).fill(0xff)]
  for (const x of hostile) {
    t.is(videoBounds(x), null, 'not a video: ' + Object.prototype.toString.call(x))
    t.is(stripVideoMetadata(x), null, 'nothing to strip: ' + Object.prototype.toString.call(x))
  }
  const padded = (total) => {
    const b = new Uint8Array(total)
    b.set(good)
    b.set([...be32(total - good.byteLength), ...ascii('free')], good.byteLength)
    return b
  }
  t.ok(videoBounds(padded(8388608)), 'exactly 8 MiB, padded with a free box')
  t.ok(stripVideoMetadata(padded(8388608)), 'exactly 8 MiB is stripped')
  t.is(videoBounds(padded(8388609)), null, 'more than 8 MiB, valid but for its size')
  t.is(stripVideoMetadata(padded(8388609)), null, 'more than 8 MiB is not stripped')

  let threw = 0
  for (let i = 0; i < good.byteLength; i++) {
    for (const v of [0x00, 0xff, 0x80]) {
      const b = good.slice()
      b[i] = v
      try {
        const r = videoBounds(b)
        if (r !== null && !(r.ms >= 1 && r.ms <= MAX_VIDEO_MS && r.width >= 1 && r.height >= 1)) threw++
        stripVideoMetadata(b)
      } catch {
        threw++
      }
    }
  }
  t.is(threw, 0, 'one byte changed anywhere never throws nor gives an out-of-bounds answer')
})

test('stripVideoMetadata: no place, time or device tags, same layout', (t) => {
  const place = ascii('+12.3456-045.6789/')
  const udta = box('udta', box('©xyz', be16(place.length), be16(0x15c7), place))
  const meta = box('meta', [0, 0, 0, 0], hdlr('mdir'), box('ilst', box('©too', box('data', be32(1), be32(0), ascii('Lavf61')))))
  const uuid = box('uuid', new Array(16).fill(7), ascii('device-serial'))
  const input = file({
    tracks: [videoSpec({ perChunk: 30, trakExtra: [uuid], ctts: bframes(), edits: [edts(0, [[3000, 100]])] }), soundSpec({ perChunk: 70 })],
    moovExtra: [udta, meta],
    head: box('free', ascii('encoder notes')),
    gap: 24
  })
  t.is(videoBounds(input), null, 'refused as written')
  const out = stripVideoMetadata(input)
  t.ok(out, 'stripped')
  t.is(out.byteLength, input.byteLength, 'same size')
  t.alike(videoBounds(out), { ms: 3000, width: 640, height: 360, audio: true }, 'passes the strict check')
  t.alike(stripVideoMetadata(out), out, 'a second strip changes nothing')
  t.is(findSeq(input, ascii('device-serial')) > 0 && findSeq(out, ascii('device-serial')), -1, 'the uuid payload is gone')

  const blank = (needle, label) => {
    const at = findSeq(input, needle)
    t.ok(at > 0, label + ' is in the input')
    t.ok(out.subarray(at, at + needle.length).every((v) => v === 0), label + ' is zero')
  }
  blank(place, 'the udta location')
  blank(ascii('Lavf61'), 'the moov meta')
  blank(ascii('VideoHandler'), 'the video handler name')
  blank(ascii('SoundHandler'), 'the sound handler name')
  blank(ascii('x264'), 'the compressorname')
  blank(ascii('encoder notes'), 'the top-level free payload')
  for (const type of ['udta', 'meta', 'uuid']) {
    const at = findSeq(input, ascii(type)) - 4
    t.alike(Array.from(out.subarray(at + 4, at + 8)), ascii('free'), type + ' became free')
  }
  const gapAt = findSeq(input, new Array(24).fill(0xee))
  t.ok(gapAt > 0 && out.subarray(gapAt, gapAt + 24).every((v) => v === 0), 'the run no sample covers is zero')
  const mdatAt = findSeq(input, ascii('mdat')) + 4
  let kept = 0
  for (let i = mdatAt; i < input.byteLength; i++) if (input[i] !== 0xee && out[i] === input[i]) kept++
  t.is(kept, input.byteLength - mdatAt - 24, 'every sample byte is kept')
  const mvhdAt = findSeq(out, ascii('mvhd')) + 4
  t.ok(out.subarray(mvhdAt + 4, mvhdAt + 12).every((v) => v === 0), 'mvhd times are zero')
  const mdhdAt = findSeq(out, ascii('mdhd')) + 4
  t.ok(out.subarray(mdhdAt + 4, mdhdAt + 12).every((v) => v === 0), 'mdhd times are zero')
  const tkhdAt = findSeq(out, ascii('tkhd')) + 4
  t.ok(out.subarray(tkhdAt + 4, tkhdAt + 12).every((v) => v === 0), 'tkhd times are zero')
  t.alike(input, file({
    tracks: [videoSpec({ perChunk: 30, trakExtra: [uuid], ctts: bframes(), edits: [edts(0, [[3000, 100]])] }), soundSpec({ perChunk: 70 })],
    moovExtra: [udta, meta],
    head: box('free', ascii('encoder notes')),
    gap: 24
  }), 'the input is not mutated')
})

test('stripVideoMetadata: refuses what the sender check refuses', (t) => {
  t.is(stripVideoMetadata(file({ tracks: [videoSpec({ entries: [avc1({ type: 'hvc1' })] })] })), null, 'hvc1')
  t.is(stripVideoMetadata(file({ ms: 31000, tracks: [videoSpec({ timescale: 1000, runs: [[1, 31000]] })] })), null, 'too long')
  t.is(stripVideoMetadata(file({ tail: box('moof', zeros(8)) })), null, 'a fragment')
  t.is(stripVideoMetadata(file({ tracks: [videoSpec({ timescale: 0xfffffff0, runs: [[2, 0xfffffff0]], mediaDuration: 5 })], ms: 2000 })), null, 'a value past a version 0 field')
})

// The layouts the real-file check found (see the PR): what each encoder
// writes, rebuilt here so the walk keeps accepting them.
test('videoBounds: layouts of real encoders', (t) => {
  const ff = { mvhd: mvhd0(48000, 144000), movieScale: 48000 }
  const ffVideo = (over) => videoSpec({ timescale: 15360, runs: [[90, 512]], perChunk: 1, ctts: bframes512(), stss: stss([1]), edits: [edts(0, [[144000, 1024]])], ...over })
  const ffSound = (over) => soundSpec({ perChunk: 2, runs: [[140, 1024], [1, 1024]], mediaDuration: 141 * 1024, edits: [edts(0, [[144000, 1024]])], stblExtra: [box('sgpd', [1, 0, 0, 0], ascii('roll'), be32(2), be32(1), be16(0xffff)), box('sbgp', [0, 0, 0, 0], ascii('roll'), be32(1), be32(141), be32(1))], ...over })
  const ffmeta = box('udta', box('meta', [0, 0, 0, 0], hdlr('mdir'), box('ilst', box('©too', box('data', be32(1), be32(0), ascii('Lavf62'))))))
  const plain = file({ ...ff, tracks: [ffVideo(), ffSound()], mdatFirst: true, head: box('free'), moovExtra: [ffmeta] })
  const faststart = file({ ...ff, tracks: [ffVideo(), ffSound()], moovExtra: [ffmeta], tail: [] })
  const located = file({ ...ff, tracks: [ffVideo({ entries: [avc1({ kids: [avcC({ profile: 77, level: 31 }), pasp(), btrt()] })] }), ffSound()], moovExtra: [box('udta', ffmeta.slice(8), box('loci', zeros(27)))] })
  const vt = file({ ...ff, tracks: [ffVideo({ ctts: null, stss: stss([1, 31, 61]), edits: [edts(0, [[144000, 0]])] }), ffSound({ edits: [edts(0, [[144640, 2112]])] })], mdatFirst: true, head: box('free'), moovExtra: [ffmeta] })
  const avconvert = file({
    mvhd: mvhd0(15360, 46080),
    movieScale: 15360,
    tracks: [ffSound({ perChunk: 30, edits: [edts(0, [[46080, 1024]])] }), ffVideo({ perChunk: 30, runs: [[89, 512], [1, 1536]], edits: [edts(0, [[46080, 1024]])] })],
    moovExtra: [ffmeta]
  })
  // AVAssetWriter (the phone path's encoder): mdat first, a turned matrix
  // with a translation, fiel and chrm instead of pasp, sdtp, and a location
  // (loci) in moov/udta.
  const writerMatrix = [0, ONE, 0, -ONE, 0, 0, 0, 0, 0x40000000]
  const writer = file({
    mvhd: mvhd0(48000, 144000),
    movieScale: 48000,
    mdatFirst: true,
    tracks: [
      videoSpec({ timescale: 600, runs: [[90, 20]], width: 1920, height: 1080, matrix: writerMatrix, perChunk: 15, ctts: bframes20(), stss: stss([1, 31, 61]), edits: [edts(0, [[144000, 40]])], entries: [avc1({ width: 1920, height: 1080, name: '', kids: [avcC({ level: 40 }), box('fiel', [1, 0]), box('chrm', zeros(2))] })], stblExtra: [box('sdtp', [0, 0, 0, 0], new Array(90).fill(0x20))] }),
      soundSpec({ perChunk: 20, runs: [[141, 1024]], edits: [edts(0, [[144000, 2112]])], entries: [mp4a(esds())] })
    ],
    moovExtra: [box('udta', box('loci', zeros(27)))]
  })
  const seen = [['ffmpeg x264 plain', plain, 640, 360], ['ffmpeg x264 faststart', faststart, 640, 360], ['ffmpeg x264 with a location', located, 640, 360],
    ['ffmpeg VideoToolbox', vt, 640, 360], ['avconvert', avconvert, 640, 360], ['AVAssetWriter', writer, 1080, 1920]]
  for (const [name, input, width, height] of seen) {
    t.is(videoBounds(input), null, name + ': refused as written (udta)')
    const sender = videoBounds(input, { metadata: true })
    t.ok(sender && sender.width === width && sender.height === height && sender.audio, name + ': the sender reads it')
    const out = stripVideoMetadata(input)
    t.alike(out && videoBounds(out), sender, name + ': stripped, it passes the strict check')
    t.alike(out && stripVideoMetadata(out), out, name + ': stripping twice changes nothing')
  }
})

function bframes512 () {
  const runs = [[1, 1024]]
  for (let i = 1; i < 90; i++) runs.push([1, i % 2 ? 1536 : 512])
  return ctts(0, runs)
}

function bframes20 () {
  const runs = [[1, 40]]
  for (let i = 1; i < 90; i++) runs.push([1, i % 2 ? 60 : 20])
  return ctts(0, runs)
}

// Every walked container, with a builder that puts x among its children.
const WALKED = [
  ['moov', (x) => file({ moovExtra: [x] })],
  ['trak', (x) => file({ tracks: [videoSpec({ trakExtra: [x] }), soundSpec()] })],
  ['the sound trak', (x) => file({ tracks: [videoSpec(), soundSpec({ trakExtra: [x] })] })],
  ['edts', (x) => file({ tracks: [videoSpec({ edits: [box('edts', elst(0, [[3000, 0]]), x)] })] })],
  ['mdia', (x) => file({ tracks: [videoSpec({ mdiaExtra: [x] }), soundSpec()] })],
  ['minf', (x) => file({ tracks: [videoSpec({ minfExtra: [x] }), soundSpec()] })],
  ['the sound minf', (x) => file({ tracks: [videoSpec(), soundSpec({ minfExtra: [x] })] })],
  ['dinf', (x) => file({ tracks: [videoSpec({ dinfExtra: [x] }), soundSpec()] })],
  ['stbl', (x) => file({ tracks: [videoSpec({ stblExtra: [x] }), soundSpec()] })],
  ['the sound stbl', (x) => file({ tracks: [videoSpec(), soundSpec({ stblExtra: [x] })] })],
  ['the mp4a entry', (x) => file({ tracks: [videoSpec(), soundSpec({ entries: [mp4a(esds(), x)] })] })]
]

test('videoBounds: a box not on a container\'s list is refused', (t) => {
  const inert = [1, 2, 3, 4]
  const named = [
    ['moov', box('moov', inert)],
    ['moov holding a movie header', box('moov', mvhd0(1000, 3000))],
    ['cmov', box('cmov', inert)],
    ['trak', box('trak', inert)],
    ['an unknown type', box('abcd', inert)]
  ]
  for (const [where, make] of WALKED) {
    t.ok(videoBounds(make(box('skip', inert))), 'a skip box in ' + where + ' passes')
    for (const [name, x] of named) {
      const input = make(x)
      t.is(videoBounds(input), null, name + ' in ' + where)
      t.is(videoBounds(input, { metadata: true }), null, name + ' in ' + where + ', sender check')
      t.is(videoBounds(input, { maxMs: MAX_MOMENT_VIDEO_MS }), null, name + ' in ' + where + ', momento bound')
    }
  }
  for (const name of ['tref', 'tapt']) {
    const input = file({ tracks: [videoSpec({ trakExtra: [box(name, inert)] }), soundSpec()] })
    t.is(videoBounds(input), null, name + ' in trak')
    t.is(videoBounds(input, { metadata: true }), null, name + ' in trak, sender check')
  }
  const sound = (...kids) => file({ tracks: [videoSpec(), soundSpec({ entries: [mp4a(...kids)] })] })
  t.ok(sound(esds(), btrt()), 'esds and btrt in the mp4a entry')
  t.ok(sound(esds()), 'esds alone in the mp4a entry')
  for (const [name, input] of [
    ['a second esds', sound(esds(), esds())],
    ['a second btrt', sound(esds(), btrt(), btrt())],
    ['a wave box', sound(esds(), box('wave', box('frma', ascii('mp4a')), esds()))],
    ['a dac3 box', sound(esds(), box('dac3', [0x10, 0x3d, 0xc0]))],
    ['a dec3 box', sound(esds(), box('dec3', [0x01, 0x40, 0x20, 0x0f, 0x00]))]
  ]) {
    t.is(videoBounds(input), null, name + ' in the mp4a entry')
    t.is(videoBounds(input, { metadata: true }), null, name + ' in the mp4a entry, sender check')
  }
  t.is(videoBounds(file({ moovExtra: [mvhd0(1000, 3000)] })), null, 'a second mvhd')
  t.is(videoBounds(file({ tracks: [videoSpec({ mdiaExtra: [hdlr('vide')] })] })), null, 'a second hdlr')
  t.is(videoBounds(file({ tracks: [videoSpec({ minfExtra: [box('vmhd', flags(1), zeros(8))] })] })), null, 'a second vmhd')
  t.is(videoBounds(file({ tracks: [videoSpec(), soundSpec({ minfExtra: [box('smhd', zeros(8))] })] })), null, 'a second smhd')
  t.is(videoBounds(file({ tracks: [videoSpec({ dinfExtra: [dref(urlSelf())] })] })), null, 'a second dref')
  t.is(videoBounds(file({ tracks: [videoSpec({ edits: [box('edts', elst(0, [[3000, 0]]), elst(0, [[3000, 0]]))] })] })), null, 'a second elst')
})

test('videoBounds: stbl tables the walk does not read hold their own fields', (t) => {
  const stbl = (...x) => videoBounds(file({ tracks: [videoSpec({ stblExtra: x }), soundSpec()] }))
  const sdtp = (n) => box('sdtp', [0, 0, 0, 0], new Array(n).fill(0x20))
  t.ok(stbl(sdtp(90)), 'an sdtp with one byte per sample')
  t.is(stbl(sdtp(89)), null, 'an sdtp one byte short')
  t.is(stbl(sdtp(91)), null, 'an sdtp one byte long')
  t.is(stbl(box('sdtp', [1, 0, 0, 0], new Array(90).fill(0))), null, 'an sdtp version 1')
  t.is(stbl(sdtp(90), sdtp(90)), null, 'two sdtp')
  t.ok(stbl(box('cslg', [0, 0, 0, 0], zeros(20))), 'a cslg version 0')
  t.ok(stbl(box('cslg', [1, 0, 0, 0], zeros(40))), 'a cslg version 1')
  t.is(stbl(box('cslg', [0, 0, 0, 0], zeros(16))), null, 'a cslg short of a field')
  t.is(stbl(box('cslg', [2, 0, 0, 0], zeros(20))), null, 'a cslg version 2')
  const roll = (count = 1, size = 2) => box('sgpd', [1, 0, 0, 0], ascii('roll'), be32(size), be32(count), new Array(count * size).fill(0xff))
  const group = (n, version = 0) => box('sbgp', [version, 0, 0, 0], ascii('roll'), version === 1 ? be32(0) : [], be32(1), be32(n), be32(1))
  t.ok(stbl(roll(), group(90)), 'a roll group over every sample')
  t.ok(stbl(roll(), group(10, 1)), 'an sbgp version 1 over some samples')
  t.ok(stbl(box('sgpd', [1, 0, 0, 0], ascii('roll'), be32(0), be32(1), be32(2), [0xff, 0xff])), 'an sgpd entry after its own length')
  t.ok(stbl(box('sgpd', [2, 0, 0, 0], ascii('roll'), be32(1), be32(0))), 'an sgpd version 2 header')
  t.ok(stbl(box('sgpd', [0, 0, 0, 0], ascii('roll'), be32(0))), 'an empty sgpd version 0')
  t.ok(stbl(box('sgpd', [2, 0, 0, 0], ascii('roll'), be32(2), be32(0), be32(0))), 'an empty sgpd version 2 with a default length')
  t.is(stbl(group(91)), null, 'an sbgp over more samples than the track has')
  t.is(stbl(box('sbgp', [0, 0, 0, 0], ascii('roll'), be32(2), be32(90), be32(1))), null, 'an sbgp claiming more entries than it holds')
  t.is(stbl(box('sbgp', [2, 0, 0, 0], ascii('roll'), be32(0))), null, 'an sbgp version 2')
  t.is(stbl(box('sgpd', [1, 0, 0, 0], ascii('roll'), be32(2), be32(2), [0xff, 0xff])), null, 'an sgpd one entry short')
  t.is(stbl(box('sgpd', [1, 0, 0, 0], ascii('roll'), be32(0), be32(1), be32(9), [0xff])), null, 'an sgpd entry past its box')
  t.is(stbl(box('sgpd', [3, 0, 0, 0], ascii('roll'), be32(0), be32(0))), null, 'an sgpd version 3')
  t.is(stbl(box('sgpd', [0, 0, 0, 0], ascii('roll'), be32(0xffffffff))), null, 'an sgpd version 0 declaring entries it does not hold')
  t.is(stbl(box('sgpd', [0, 0, 0, 0], ascii('roll'), be32(1), [0xff, 0xff])), null, 'an sgpd version 0 entry the walk cannot size')
  t.is(stbl(box('sgpd', [2, 0, 0, 0], ascii('roll'), be32(1), be32(0xffffffff))), null, 'an sgpd version 2 declaring entries it does not hold')
  t.is(stbl(box('sgpd', [2, 0, 0, 0], ascii('roll'), be32(1), be32(1), [0xff, 0xff])), null, 'an sgpd version 2 entry the walk cannot size')
  t.is(stbl(box('sgpd', [2, 0, 0, 0], ascii('roll'), be32(1), be32(0), [0xff])), null, 'an sgpd version 2 with bytes after its header')
  t.is(stbl(box('sgpd', [2, 0, 0, 0], ascii('roll'), be32(2), be32(0), be32(1))), null, 'an sgpd version 2 with a default length declaring an entry it does not hold')
  t.is(stbl(box('sgpd', [2, 0, 0, 0], ascii('roll'), be32(2), be32(1), be32(0))), null, 'an empty sgpd version 2 pointing to a default entry')
  t.is(stbl(box('sgpd', [2, 0, 0, 0], ascii('roll'), be32(2), be32(0), be32(1), [0xff, 0xff])), null, 'an sgpd version 2 with a default length and an entry')
  for (const type of ['sdtp', 'cslg', 'sgpd', 'sbgp']) t.is(stbl(box(type, [1, 2, 3, 4])), null, 'a bare ' + type)
})

test('videoBounds: the AAC config names AAC-LC, SBR or PS', (t) => {
  // The first five bits of the AudioSpecificConfig; 31 escapes to 32 + the
  // next six bits.
  const typed = (dsi) => videoBounds(file({ tracks: [videoSpec(), soundSpec({ entries: [mp4a(esds(0x40, dsi), btrt())] })] }))
  t.ok(typed([0x12, 0x10]), 'type 2, AAC-LC')
  t.ok(typed([0x2b, 0x92]), 'type 5, SBR')
  t.ok(typed([0xeb, 0x92]), 'type 29, PS')
  t.is(typed([0x0a, 0x10]), null, 'type 1, AAC main')
  t.is(typed([0x1a, 0x10]), null, 'type 3, AAC SSR')
  t.is(typed([0xf8, 0x10]), null, 'type 31, the escape')
  t.is(typed([0xf8, 0x50]), null, 'type 34 through the escape')
  t.is(typed([0x00, 0x10]), null, 'type 0')
})

test('videoBounds: the QuickTime brand is refused', (t) => {
  t.is(videoBounds(file({ brand: 'qt  ', compatible: ['isom', 'avc1'] })), null, "major brand 'qt  ' with video brands listed")
  t.is(videoBounds(file({ brand: 'isom', compatible: ['isom', 'qt  '] })), null, "'qt  ' among the compatible brands")
  t.is(videoBounds(file({ brand: 'qt  ', compatible: ['isom'] }), { metadata: true }), null, 'the sender check too')
  t.ok(videoBounds(file({ brand: 'isom', compatible: ['isom', 'mp41'] })), 'video brands only')
})

test('videoBounds: an avc1 colr is nclx', (t) => {
  const one = (kids) => videoBounds(file({ tracks: [videoSpec({ entries: [avc1({ kids })] })] }))
  t.ok(one([avcC(), colr()]), 'nclx')
  t.is(one([avcC(), box('colr', ascii('nclx'), be16(1), be16(1), be16(1))]), null, 'nclx without its full-range byte')
  t.is(one([avcC(), box('colr', ascii('nclc'), be16(1), be16(1), be16(1))]), null, 'nclc')
  t.is(one([avcC(), box('colr', ascii('prof'), zeros(128))]), null, 'an ICC profile')
  t.is(one([avcC(), box('colr', ascii('rICC'), zeros(128))]), null, 'a restricted ICC profile')
})

test('stripVideoMetadata: a child not on its container\'s list becomes free', (t) => {
  const note = ascii('inert note')
  const input = file({
    tracks: [videoSpec({ trakExtra: [box('abc2', note)], stblExtra: [box('abc3', note)] }), soundSpec({ entries: [mp4a(esds(), box('abc4', note))] })],
    moovExtra: [box('abc1', note)]
  })
  t.is(videoBounds(input), null, 'refused as written')
  const out = stripVideoMetadata(input)
  t.ok(out, 'stripped')
  t.is(out && out.byteLength, input.byteLength, 'same size')
  t.alike(out && videoBounds(out), { ms: 3000, width: 640, height: 360, audio: true }, 'passes the strict check')
  for (const type of ['abc1', 'abc2', 'abc3', 'abc4']) {
    const at = findSeq(input, ascii(type))
    t.ok(at > 0, type + ' is in the input')
    t.alike(out && Array.from(out.subarray(at, at + 4)), ascii('free'), type + ' became free')
    t.ok(out && out.subarray(at + 4, at + 4 + note.length).every((v) => v === 0), type + ' payload is zero')
  }
  t.alike(out && stripVideoMetadata(out), out, 'a second strip changes nothing')

  const inner = box('moov', mvhd0(1000, 3000), trak(soundSpec({ id: 3 }), [0], 1000))
  const nested = file({ tracks: [videoSpec()], moovExtra: [inner] })
  t.is(videoBounds(nested), null, 'a nested moov is refused as written')
  t.is(videoBounds(nested, { metadata: true }), null, 'and by the sender check')
  const blanked = stripVideoMetadata(nested)
  t.is(blanked && blanked.byteLength, nested.byteLength, 'same size')
  t.alike(blanked && videoBounds(blanked), { ms: 3000, width: 640, height: 360, audio: false }, 'the strict check sees the outer tracks only')
  const at = findSeq(nested, ascii('moov'), findSeq(nested, ascii('moov')) + 4)
  t.ok(at > 0, 'the nested moov is in the input')
  t.alike(blanked && Array.from(blanked.subarray(at, at + 4)), ascii('free'), 'the nested moov became free')
  t.ok(blanked && blanked.subarray(at + 4, at - 4 + inner.length).every((v) => v === 0), 'its payload is zero')
  t.is(blanked && findSeq(blanked, ascii('soun')), -1, 'nothing of its track is left')
})

test('index exports the video check', (t) => {
  t.is(typeof rpc.videoBounds, 'function')
  t.is(typeof rpc.stripVideoMetadata, 'function')
  t.is(rpc.VIDEO_MS_TOLERANCE, 1000)
  t.is(rpc.MAX_VIDEO_SAMPLES, 1800)
  t.alike(rpc.VIDEO_BRANDS, ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1'])
})
