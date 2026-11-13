'use strict'

const test = require('brittle')
const { audioBounds, stripAudioMetadata, MAX_AUDIO_MS } = require('..')
const { MAX_SAMPLES } = require('../lib/audio-bounds')

const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))
const flags = (v) => [0, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]

function box (type, ...parts) {
  const body = parts.flat()
  return [...be32(8 + body.length), ...ascii(type), ...body]
}

function ftyp (major = 'M4A ', compatible = ['M4A ', 'isom']) {
  return box('ftyp', ascii(major), be32(0), ...compatible.map(ascii))
}

function mvhd0 (timescale, duration) {
  return box('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(timescale), be32(duration), new Array(80).fill(0))
}

function mvhd1 (timescale, hi, lo) {
  return box('mvhd', [1, 0, 0, 0], be32(0), be32(0), be32(0), be32(0), be32(timescale), be32(hi), be32(lo), new Array(80).fill(0))
}

function tkhd (id, duration = 0) {
  return box('tkhd', flags(7), be32(0), be32(0), be32(id), be32(0), be32(duration), new Array(60).fill(0))
}

function tkhd1 (id, hi, lo) {
  return box('tkhd', [1, 0, 0, 7], be32(0), be32(0), be32(0), be32(0), be32(id), be32(0), be32(hi), be32(lo), new Array(60).fill(0))
}

// entries: [segment_duration, media_time, rate_integer = 1, rate_fraction = 0]
function elst (version, list) {
  const entry = ([seg, time, ri = 1, rf = 0]) => version === 0
    ? [...be32(seg), ...be32(time), (ri >> 8) & 0xff, ri & 0xff, (rf >> 8) & 0xff, rf & 0xff]
    : [...be32(Math.floor(seg / 0x100000000)), ...be32(seg >>> 0), ...(time === -1 ? be32(0xffffffff) : be32(0)), ...be32(time >>> 0),
        (ri >> 8) & 0xff, ri & 0xff, (rf >> 8) & 0xff, rf & 0xff]
  return box('elst', [version, 0, 0, 0], be32(list.length), ...list.map(entry))
}
const edts = (version, list) => box('edts', elst(version, list))

// Frames of 20 ticks, then the rest: few samples, whatever the length.
function frames (ms) {
  const runs = []
  if (ms >= 20) runs.push([Math.floor(ms / 20), 20])
  if (ms % 20) runs.push([1, ms % 20])
  return runs
}

function mdhd (timescale, duration = 0) {
  return box('mdhd', [0, 0, 0, 0], be32(0), be32(0), be32(timescale), be32(duration), [0, 0, 0, 0])
}

const urlSelf = () => box('url ', flags(1))
const dref = (...list) => box('dref', [0, 0, 0, 0], be32(list.length), ...list)
// An ES_Descriptor (tag 3) holding a DecoderConfigDescriptor (tag 4) for
// objectTypeIndication oti and streamType st, with an AudioSpecificConfig
// (tag 5), then an SLConfigDescriptor (tag 6).
const esds = (oti = 0x40, st = 0x05) => box('esds', [0, 0, 0, 0], [0x03, 0x19, 0, 1, 0, 0x04, 0x11, oti, (st << 2) | 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02])
const mp4a = (...kids) => box('mp4a', new Array(28).fill(0), ...(kids.length ? kids : [esds()]))
const dOps = () => box('dOps', [0, 2, 0x01, 0x38, ...be32(48000), 0, 0, 0])
const opus = (...kids) => box('Opus', new Array(28).fill(0), ...(kids.length ? kids : [dOps()]))
const stsd = (...list) => box('stsd', [0, 0, 0, 0], be32(list.length), ...list)
// runs: [[sample_count, sample_delta], ...]
const stts = (runs) => box('stts', [0, 0, 0, 0], be32(runs.length), ...runs.map(([c, d]) => [...be32(c), ...be32(d)]))
// A constant sample size of 1 byte, or per-sample sizes when size is 0.
const stsz = (count, size = 1, list = []) => box('stsz', [0, 0, 0, 0], be32(size), be32(count), ...list.map(be32))
const samplesOf = (runs) => runs.reduce((n, [c]) => n + c, 0)
// entries: [[first_chunk, samples_per_chunk, sample_description_index = 1], ...]
const stsc = (list) => box('stsc', [0, 0, 0, 0], be32(list.length), ...list.map(([f, n, d = 1]) => [...be32(f), ...be32(n), ...be32(d)]))
const stco = (count) => box('stco', [0, 0, 0, 0], be32(count), new Array(count * 4).fill(0))
const co64 = (count) => box('co64', [0, 0, 0, 0], be32(count), new Array(count * 8).fill(0))
// One chunk holding every sample, or empty tables when there is none.
const chunksOf = (n) => n > 0 ? [stsc([[1, n]]), stco(1)] : [stsc([]), stco(0)]

// A sound track: handler, its mdhd, a self-contained dref, one mp4a entry
// and an stts; every part can be swapped to build a bad one.
function trak ({
  handler = 'soun',
  id = 1,
  timescale = 1000,
  duration = 0,
  runs = [[3, 1000]],
  refs = [urlSelf()],
  entries = [mp4a()],
  extra = [],
  stblExtra = [],
  head = tkhd(id),
  edits = [],
  sizes = [stsz(samplesOf(runs))],
  chunks = chunksOf(samplesOf(runs)),
  media = mdhd(timescale, duration)
} = {}) {
  const hdlr = box('hdlr', [0, 0, 0, 0], be32(0), ascii(handler), be32(0), be32(0), be32(0), [0])
  const minf = box('minf', box('smhd', new Array(8).fill(0)), ...extra, box('dinf', dref(...refs)), box('stbl', stsd(...entries), stts(runs), ...sizes, ...chunks, ...stblExtra))
  return box('trak', head, ...edits, box('mdia', media, hdlr, minf))
}

// ms of samples at timescale 1000, with an mvhd that agrees, and an mdat
// long enough for every sample's bytes (one each, plus room for larger
// per-sample sizes).
function file ({ brand, compatible, ms = 3000, mvhd = mvhd0(1000, ms), tracks = [{ runs: frames(ms) }], tail = [] } = {}) {
  const pad = Math.min(tracks.reduce((n, tr) => n + samplesOf(tr.runs || [[3, 1000]]), 0), 2 * MAX_SAMPLES) + 1024
  return new Uint8Array([...ftyp(brand, compatible), ...box('moov', mvhd, ...tracks.map(trak)), ...box('mdat', new Array(pad).fill(1)), ...tail])
}

test('audioBounds: an audio-only MPEG-4 file gives its duration', (t) => {
  t.alike(audioBounds(file()), { ms: 3000 })
  t.alike(audioBounds(file({ ms: 1500, mvhd: mvhd1(1000, 0, 1500) })), { ms: 1500 }, 'mvhd version 1')
  t.alike(audioBounds(file({ ms: MAX_AUDIO_MS })), { ms: MAX_AUDIO_MS }, 'the longest')
  t.alike(audioBounds(file({ ms: 1 })), { ms: 1 }, 'the shortest')
  t.alike(audioBounds(file({ brand: 'mp42', compatible: ['isom'] })), { ms: 3000 }, 'another audio brand')
  t.alike(audioBounds(file({ brand: 'qt  ', compatible: ['qt  ', 'mp41'] })), { ms: 3000 }, 'a compatible brand is enough')
  for (const brand of ['iso5', 'iso6', 'iso8']) t.alike(audioBounds(file({ brand, compatible: [brand] })), { ms: 3000 }, 'a recorder brand: ' + brand)
  const aac = { timescale: 44100, duration: 44100 * 3, runs: [[129, 1024], [1, 300]] }
  t.alike(audioBounds(file({ mvhd: mvhd0(1000, 2999), tracks: [aac] })), { ms: Math.round((129 * 1024 + 300) * 1000 / 44100) }, 'AAC sample runs')
  t.alike(audioBounds(file({ mvhd: mvhd0(1000, 0) })), { ms: 3000 }, 'an mvhd without a duration')
  t.alike(audioBounds(file({ mvhd: mvhd0(1000, 0xffffffff) })), { ms: 3000 }, 'an mvhd with an unknown duration')
  t.alike(audioBounds(file({ tracks: [{ entries: [opus()], runs: [[3000, 1]] }] })), { ms: 3000 }, 'an Opus entry')
})

test('audioBounds: the samples decide, a header cannot hide them', (t) => {
  // The movie header says 3 s; the sample table plays for ten minutes.
  t.is(audioBounds(file({ mvhd: mvhd0(1000, 3000), tracks: [{ runs: [[6000, 100]] }] })), null, 'a long sample table behind a short mvhd')
  t.is(audioBounds(file({ mvhd: mvhd0(1000, 3000), tracks: [{ runs: [[3000, 1], [5000, 100]] }] })), null, 'a long second stts run')
  t.is(audioBounds(file({ mvhd: mvhd0(1000, 3000), tracks: [{ runs: [[1, 0xffffffff]] }] })), null, 'one huge sample')
  t.is(audioBounds(file({ mvhd: mvhd0(1000, 3000), tracks: [{ duration: 3000, runs: [[10000, 1]] }] })), null, 'mdhd agreeing with mvhd, not the samples')
  t.is(audioBounds(file({ mvhd: mvhd0(1000, 9000) })), null, 'an mvhd longer than the samples')
  t.is(audioBounds(file({ tracks: [{ duration: 9000, runs: [[3000, 1]] }] })), null, 'an mdhd longer than the samples')
  t.alike(audioBounds(file({ mvhd: mvhd0(1000, 3900), tracks: [{ duration: 2100, runs: [[3000, 1]] }] })), { ms: 3000 }, 'headers within the tolerance')
  t.is(audioBounds(file({ tracks: [{ runs: [] }] })), null, 'no samples')
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]] }, { runs: [[6000, 100]] }] })), null, 'a long second track')
  const liar = trak({ runs: [[3000, 1]] })
  liar.splice(findSeq(liar, stts([[3000, 1]])) + 12, 4, ...be32(1000))
  t.is(audioBounds(new Uint8Array([...ftyp(), ...box('moov', mvhd0(1000, 3000), liar)])), null, 'an stts claiming more entries than its bytes')
  const noStts = box('trak', tkhd(1), box('mdia', mdhd(1000), box('hdlr', [0, 0, 0, 0], be32(0), ascii('soun'), be32(0), be32(0), be32(0), [0]),
    box('minf', box('dinf', dref(urlSelf())), box('stbl', stsd(mp4a()), stsz(3000), ...chunksOf(3000)))))
  t.is(audioBounds(new Uint8Array([...ftyp(), ...box('moov', mvhd0(1000, 3000), noStts)])), null, 'no stts')
})

test('audioBounds: a video track or no sound track is refused', (t) => {
  t.is(audioBounds(file({ tracks: [{ handler: 'vide' }] })), null, 'video only')
  t.is(audioBounds(file({ tracks: [{}, { handler: 'vide' }] })), null, 'sound plus video')
  t.is(audioBounds(file({ tracks: [{}, { handler: 'text' }] })), null, 'sound plus subtitles')
  t.is(audioBounds(file({ tracks: [] })), null, 'no track')
  const noHdlr = new Uint8Array([...ftyp(), ...box('moov', mvhd0(1000, 1000), box('trak', box('mdia')))])
  t.is(audioBounds(noHdlr), null, 'a track without a handler')
  t.is(audioBounds(file({ tracks: new Array(17).fill({ runs: [[3000, 1]] }) })), null, 'too many tracks')
})

test('audioBounds: a sound track carries one audio entry and no video header', (t) => {
  const avc1 = box('avc1', new Array(78).fill(0), box('avcC', [1, 0x64, 0, 0x1f, 0xff, 0xe0]))
  t.is(audioBounds(file({ tracks: [{ entries: [avc1], runs: [[3000, 1]] }] })), null, "a 'soun' handler over an avc1 entry")
  t.is(audioBounds(file({ tracks: [{ entries: [mp4a(), avc1], runs: [[3000, 1]] }] })), null, 'an audio entry plus a video one')
  t.is(audioBounds(file({ tracks: [{ entries: [mp4a(), mp4a()], runs: [[3000, 1]] }] })), null, 'two entries')
  t.is(audioBounds(file({ tracks: [{ entries: [], runs: [[3000, 1]] }] })), null, 'no entry')
  t.is(audioBounds(file({ tracks: [{ entries: [box('mp3 ', new Array(28).fill(0))], runs: [[3000, 1]] }] })), null, 'an entry outside the list')
  t.is(audioBounds(file({ tracks: [{ extra: [box('vmhd', new Array(12).fill(0))], runs: [[3000, 1]] }] })), null, 'a video media header')
  const miscounted = stsd(mp4a())
  miscounted.splice(12, 4, ...be32(2))
  const bad = trak({ runs: [[3000, 1]] })
  const plain = stsd(mp4a())
  const i = findSeq(bad, plain)
  bad.splice(i, plain.length, ...miscounted)
  t.is(audioBounds(new Uint8Array([...ftyp(), ...box('moov', mvhd0(1000, 3000), bad)])), null, 'an entry_count that does not match')
})

test('audioBounds: every data reference stays in the file', (t) => {
  const urlRemote = box('url ', flags(0), ascii('https://example.com/x.m4a'), [0])
  const urn = box('urn ', flags(0), ascii('urn:x'), [0], [0])
  t.is(audioBounds(file({ tracks: [{ refs: [urlRemote], runs: [[3000, 1]] }] })), null, 'a remote url')
  t.is(audioBounds(file({ tracks: [{ refs: [urn], runs: [[3000, 1]] }] })), null, 'an urn')
  t.is(audioBounds(file({ tracks: [{ refs: [urlSelf(), urlRemote], runs: [[3000, 1]] }] })), null, 'a remote url after a local one')
  t.is(audioBounds(file({ tracks: [{ refs: [urlSelf(), urn], runs: [[3000, 1]] }] })), null, 'an urn after a local one')
  t.is(audioBounds(file({ tracks: [{ refs: [], runs: [[3000, 1]] }] })), null, 'no reference')
  t.is(audioBounds(file({ tracks: [{ refs: [box('alis', flags(1))], runs: [[3000, 1]] }] })), null, 'another kind of reference')
  t.alike(audioBounds(file({ tracks: [{ refs: [urlSelf(), urlSelf()], runs: [[3000, 1]] }] })), { ms: 3000 }, 'two local references')
  const noDinf = box('trak', tkhd(1), box('mdia', mdhd(1000), box('hdlr', [0, 0, 0, 0], be32(0), ascii('soun'), be32(0), be32(0), be32(0), [0]),
    box('minf', box('stbl', stsd(mp4a()), stts([[3000, 1]])))))
  t.is(audioBounds(new Uint8Array([...ftyp(), ...box('moov', mvhd0(1000, 3000), noDinf)])), null, 'no dinf')
})

test('audioBounds: wrong brand, durations out of range', (t) => {
  t.is(audioBounds(file({ brand: 'qt  ', compatible: ['qt  '] })), null, 'QuickTime only')
  t.is(audioBounds(file({ brand: 'heic', compatible: [] })), null, 'an image brand')
  t.is(audioBounds(file({ ms: MAX_AUDIO_MS + 1 })), null, 'too long')
  t.is(audioBounds(file({ ms: 0 })), null, 'zero duration')
  t.is(audioBounds(file({ mvhd: mvhd0(0, 1000) })), null, 'zero timescale')
  t.is(audioBounds(file({ tracks: [{ timescale: 0, runs: [[3000, 1]] }] })), null, 'zero media timescale')
  t.is(audioBounds(file({ mvhd: mvhd1(1000, 0xffffffff, 0) })), null, 'a 64-bit duration past safe integers')
  t.is(audioBounds(file({ mvhd: box('mvhd', [2, 0, 0, 0], new Array(100).fill(0)) })), null, 'unknown mvhd version')
})

function findSeq (hay, needle) {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let k = 0
    while (k < needle.length && hay[i + k] === needle[k]) k++
    if (k === needle.length) return i
  }
  return -1
}

test('audioBounds: structure is checked', (t) => {
  const good = file()
  for (let n = 0; n < good.byteLength; n += 7) {
    t.is(audioBounds(good.subarray(0, n)), null, 'truncated at ' + n)
  }
  const late = new Uint8Array([...box('free'), ...file()])
  t.is(audioBounds(late), null, 'ftyp not first')
  const noMoov = new Uint8Array([...ftyp(), ...box('mdat', [1])])
  t.is(audioBounds(noMoov), null, 'no moov')
  const twoMoov = new Uint8Array([...ftyp(), ...box('moov', mvhd0(1000, 1000), trak()), ...box('moov', mvhd0(1000, 1000), trak())])
  t.is(audioBounds(twoMoov), null, 'two moov boxes')

  const oversized = file()
  oversized.set(be32(0x7fffffff), 0)
  t.is(audioBounds(oversized), null, 'a size past the buffer')
  const tiny = file()
  tiny.set(be32(4), 0)
  t.is(audioBounds(tiny), null, 'a size below the header')
  const huge64 = new Uint8Array([...be32(1), ...ascii('ftyp'), ...be32(0xffffffff), ...be32(0xffffffff), ...ascii('M4A '), ...be32(0)])
  t.is(audioBounds(huge64), null, 'a 64-bit size past the buffer')
  const ok64 = new Uint8Array([...be32(1), ...ascii('ftyp'), ...be32(0), ...be32(24), ...ascii('M4A '), ...be32(0), ...box('moov', mvhd0(1000, 3000), trak())])
  t.alike(audioBounds(ok64), { ms: 3000 }, 'a 64-bit size that fits')
  const toEnd = new Uint8Array([...ftyp(), ...be32(0), ...ascii('moov'), ...mvhd0(1000, 2500), ...trak({ runs: [[1, 2500]] })])
  t.alike(audioBounds(toEnd), { ms: 2500 }, 'size 0 runs to the end')

  const many = []
  for (let i = 0; i < 16400; i++) many.push(...box('free'))
  t.is(audioBounds(new Uint8Array([...ftyp(), ...many, ...box('moov', mvhd0(1000, 3000), trak())])), null, 'too many boxes')
})

// Fragmented MPEG-4, as browser MediaRecorder writes it: mvhd duration 0,
// an empty stts in moov, moov/mvex, then moof/mdat pairs.
const fragTrak = (handler, id, timescale = 48000, duration = 0) => trak({ handler, id, timescale, duration, runs: [] })

const mehd0 = (d) => box('mehd', [0, 0, 0, 0], be32(d))
const mehd1 = (hi, lo) => box('mehd', [1, 0, 0, 0], be32(hi), be32(lo))
const trex = (id, d) => box('trex', [0, 0, 0, 0], be32(id), be32(1), be32(d), be32(0), be32(0))

function tfhd (id, dflt) {
  return dflt === undefined
    ? box('tfhd', flags(0x020000), be32(id))
    : box('tfhd', flags(0x020008), be32(id), be32(dflt))
}

// durations: per-sample values (flag 0x100), or a count with no durations.
function trun ({ durations, count }) {
  if (durations) return box('trun', flags(0x301), be32(durations.length), be32(0), ...durations.map((d) => [...be32(d), ...be32(10)]))
  return box('trun', flags(0x201), be32(count), be32(0), ...new Array(count).fill(be32(1)))
}

function moof (...trafs) {
  return box('moof', box('mfhd', [0, 0, 0, 0], be32(1)), ...trafs)
}

const traf = (head, ...runs) => box('traf', head, ...runs)

function fragmented ({ mvex = [], tracks = [fragTrak('soun', 1)], moofs = [], mvhd = mvhd0(1000, 0) } = {}) {
  return new Uint8Array([
    ...ftyp('isom', ['iso6', 'mp41']),
    ...box('moov', mvhd, ...tracks, box('mvex', ...mvex)),
    ...moofs.flatMap((m) => [...m, ...box('mdat', [1, 2, 3, 4])])
  ])
}

const second = () => moof(traf(tfhd(1), trun({ durations: [48000] })))

test('audioBounds: fragmented files give their duration', (t) => {
  t.alike(audioBounds(fragmented({ mvex: [mehd0(4200), trex(1, 0)], moofs: [moof(traf(tfhd(1), trun({ durations: [48000 * 4.2] })))] })), { ms: 4200 }, 'mehd version 0 agreeing')
  t.alike(audioBounds(fragmented({ mvex: [mehd1(0, 1000)], moofs: [second()] })), { ms: 1000 }, 'mehd version 1 agreeing')

  const perSample = fragmented({
    mvex: [trex(1, 0)],
    moofs: [
      moof(traf(tfhd(1), trun({ durations: [24000, 24000] }))),
      moof(traf(tfhd(1), trun({ durations: [48000] }), trun({ durations: [12000] })))
    ]
  })
  t.alike(audioBounds(perSample), { ms: 2250 }, 'trun per-sample durations')

  const tfhdDefault = fragmented({
    mvex: [trex(1, 1)],
    moofs: [moof(traf(tfhd(1, 1024), trun({ count: 47 }))), moof(traf(tfhd(1, 1024), trun({ count: 47 })))]
  })
  t.alike(audioBounds(tfhdDefault), { ms: Math.round(94 * 1024 * 1000 / 48000) }, 'tfhd default duration')

  const trexDefault = fragmented({
    mvex: [trex(1, 960)],
    moofs: [moof(traf(tfhd(1), trun({ count: 50 })))]
  })
  t.alike(audioBounds(trexDefault), { ms: 1000 }, 'trex default duration')

  const mehdZero = fragmented({ mvex: [mehd0(0), trex(1, 960)], moofs: [moof(traf(tfhd(1), trun({ count: 100 })))] })
  t.alike(audioBounds(mehdZero), { ms: 2000 }, 'mehd 0 falls back to the fragments')

  const inMoov = fragmented({ tracks: [trak({ id: 1, timescale: 48000, runs: [[1, 48000]] })], mvex: [trex(1, 0)], moofs: [second()] })
  t.alike(audioBounds(inMoov), { ms: 2000 }, 'samples in moov count with the fragments')
})

test('audioBounds: a fragmented header cannot hide the samples', (t) => {
  const long = []
  for (let i = 0; i < 100; i++) long.push(second())
  t.is(audioBounds(fragmented({ mvex: [mehd0(3000), trex(1, 0)], moofs: long })), null, 'a short mehd over 100 s of fragments')
  t.is(audioBounds(fragmented({ mvhd: mvhd0(1000, 3000), mvex: [trex(1, 0)], moofs: long })), null, 'a short mvhd over 100 s of fragments')
  t.is(audioBounds(fragmented({ tracks: [fragTrak('soun', 1, 48000, 48000 * 3)], mvex: [trex(1, 0)], moofs: long })), null, 'a short mdhd over 100 s of fragments')
  t.is(audioBounds(fragmented({ mvex: [mehd0(4200), trex(1, 0)] })), null, 'a mehd with no samples')
  t.is(audioBounds(fragmented({ mvhd: mvhd0(1000, 4200), mvex: [trex(1, 0)] })), null, 'an mvhd with no samples')
  // Samples without a duration: a mehd used to stand in for them.
  t.is(audioBounds(fragmented({ mvex: [mehd0(3000)], moofs: [second(), moof(traf(tfhd(1), trun({ count: 5000 })))] })), null, 'samples without a duration, with mehd')
  t.is(audioBounds(fragmented({ mvex: [trex(1, 0)], moofs: [second(), moof(traf(tfhd(1), trun({ count: 5000 })))] })), null, 'a zero trex default')
  t.is(audioBounds(fragmented({ mvex: [trex(1, 960)], moofs: [second(), moof(traf(tfhd(1, 0), trun({ count: 5000 })))] })), null, 'a zero tfhd default')
  t.is(audioBounds(fragmented({ mvex: [trex(1, 0)], moofs: [moof(traf(tfhd(1), trun({ durations: [48000, 0, 0] })))] })), null, 'a zero per-sample duration')
})

test('audioBounds: fragmented files that are not one sound track are refused', (t) => {
  const run = second()
  t.is(audioBounds(fragmented({ mvex: [mehd0(1000)], tracks: [fragTrak('soun', 1), fragTrak('vide', 2)], moofs: [run] })), null, 'a video track too')
  t.is(audioBounds(fragmented({ mvex: [mehd0(1000)], tracks: [fragTrak('vide', 1)], moofs: [run] })), null, 'video only')
  t.is(audioBounds(fragmented({ mvex: [trex(1, 0)], tracks: [fragTrak('soun', 1), fragTrak('soun', 2)], moofs: [run] })), null, 'two sound tracks')
  const other = moof(traf(tfhd(2), trun({ durations: [48000] })))
  t.is(audioBounds(fragmented({ mvex: [trex(1, 0)], moofs: [run, other] })), null, 'a traf naming another track')
  t.is(audioBounds(fragmented({ mvex: [mehd0(2000)], moofs: [run, other] })), null, 'a traf naming another track, even with mehd')
  t.is(audioBounds(fragmented({ mvex: [trex(1, 0)], tracks: [fragTrak('soun', 0)], moofs: [run] })), null, 'track_ID 0')
})

test('audioBounds: fragmented files out of bounds are refused', (t) => {
  const liar = trun({ durations: [48000] })
  liar.splice(12, 4, ...be32(1000))
  t.is(audioBounds(fragmented({ mvex: [trex(1, 0)], moofs: [moof(traf(tfhd(1), liar))] })), null, 'a trun claiming more samples than its bytes')
  // Last in the file, so reading past the trun finds no bytes to trip a later bound.
  const liarLast = fragmented({ mvex: [trex(1, 0)] })
  t.is(audioBounds(new Uint8Array([...liarLast, ...moof(traf(tfhd(1), liar))])), null, 'a lying trun at the end of the file')
  const long = []
  for (let i = 0; i < 121; i++) long.push(second())
  t.is(audioBounds(fragmented({ mvex: [trex(1, 0)], moofs: long })), null, 'over 120 s of fragments')
  t.is(audioBounds(fragmented({ mvex: [mehd0(MAX_AUDIO_MS + 1)] })), null, 'mehd over 120 s')
  t.is(audioBounds(fragmented({ mvex: [mehd0(0xffffffff)] })), null, 'unknown mehd duration')
  t.is(audioBounds(fragmented({ mvex: [], moofs: [moof(traf(tfhd(1), trun({ count: 10 })))] })), null, 'no duration anywhere')
  t.is(audioBounds(fragmented({ mvex: [trex(1, 960)] })), null, 'no fragments, no mehd')
  t.is(audioBounds(fragmented({ mvex: [trex(1, 960), trex(1, 960)], moofs: [moof(traf(tfhd(1), trun({ count: 50 })))] })), null, 'two trex for the track')
  t.is(audioBounds(fragmented({ mvex: [mehd0(1000), mehd0(1000)], moofs: [second()] })), null, 'two mehd')
  t.is(audioBounds(fragmented({ mvex: [trex(1, 960)], moofs: [moof(traf(trun({ count: 50 })))] })), null, 'a traf without tfhd')
  const good = fragmented({ mvex: [trex(1, 960)], moofs: [moof(traf(tfhd(1), trun({ count: 50 })))] })
  for (let n = 0; n < good.byteLength; n += 5) {
    const r = audioBounds(good.subarray(0, n))
    t.ok(r === null || r.ms <= 1000, 'truncated at ' + n)
  }
})

test('audioBounds: never throws', (t) => {
  for (const x of [null, undefined, 'x', 42, {}, [], new ArrayBuffer(8), new Uint8Array(0)]) {
    t.is(audioBounds(x), null)
    t.is(stripAudioMetadata(x), null)
  }
  for (let i = 0; i < 200; i++) {
    const b = file()
    b[Math.floor(Math.random() * b.byteLength)] = Math.floor(Math.random() * 256)
    const r = audioBounds(b)
    t.ok(r === null || (Number.isSafeInteger(r.ms) && r.ms >= 1 && r.ms <= MAX_AUDIO_MS))
    const s = stripAudioMetadata(b)
    t.ok(s === null || (s.byteLength === b.byteLength && audioBounds(s) !== null))
  }
})

// A recorder's file with times and tags: mvhd, tkhd and mdhd carry a
// creation and a modification time, udta and meta carry device tags.
const T1 = 0xdeadbeef
const T2 = 0xcafef00d
const timed = (type, version, extra) => version === 0
  ? box(type, [0, 0, 0, 0], be32(T1), be32(T2), extra)
  : box(type, [1, 0, 0, 0], be32(0), be32(T1), be32(0), be32(T2), extra)
const tag = (type) => box(type, ascii('iPhone 15 Pro, 2026-11-06 10:31, -23.55 -46.63'))

function recorded (version = 0) {
  const mvhd = version === 0
    ? timed('mvhd', 0, [...be32(1000), ...be32(3000), ...new Array(80).fill(0)])
    : timed('mvhd', 1, [...be32(1000), ...be32(0), ...be32(3000), ...new Array(80).fill(0)])
  const tk = version === 0
    ? timed('tkhd', 0, [...be32(1), ...new Array(68).fill(0)])
    : timed('tkhd', 1, [...be32(1), ...new Array(80).fill(0)])
  const md = version === 0
    ? timed('mdhd', 0, [...be32(1000), ...be32(3000), 0, 0, 0, 0])
    : timed('mdhd', 1, [...be32(1000), ...be32(0), ...be32(3000), 0, 0, 0, 0])
  const hdlr = box('hdlr', [0, 0, 0, 0], be32(0), ascii('soun'), be32(0), be32(0), be32(0), [0])
  const minf = box('minf', box('smhd', new Array(8).fill(0)), box('dinf', dref(urlSelf())), box('stbl', stsd(mp4a()), stts([[3000, 1]]), stsz(3000), ...chunksOf(3000)))
  const trk = box('trak', tk, box('mdia', md, hdlr, minf), tag('udta'))
  return new Uint8Array([...ftyp(), ...box('moov', mvhd, trk, tag('udta'), box('meta', [0, 0, 0, 0], tag('ilst'))), ...box('mdat', new Array(3000).fill(1)), ...tag('meta')])
}

const has = (bytes, s) => findSeq(Array.from(bytes), ascii(s)) >= 0

test('stripAudioMetadata: no recording time, no device tags, same layout', (t) => {
  for (const version of [0, 1]) {
    const input = recorded(version)
    const before = new Uint8Array(input)
    t.alike(audioBounds(input, { metadata: true }), { ms: 3000 }, 'a valid recording for its sender, version ' + version)
    t.is(audioBounds(input), null, 'refused with its metadata on receipt, version ' + version)
    const out = stripAudioMetadata(input)
    t.ok(out instanceof Uint8Array && out !== input, 'a new array')
    t.alike(input, before, 'the input is untouched')
    t.is(out.byteLength, input.byteLength, 'same size: offsets unchanged')
    t.alike(audioBounds(out), { ms: 3000 }, 'still a valid voice note')
    t.absent(has(out, 'udta'), 'no udta')
    t.absent(has(out, 'meta'), 'no meta')
    t.absent(has(out, 'iPhone'), 'no device tag bytes left')
    t.absent(findSeq(Array.from(out), be32(T1)) >= 0 || findSeq(Array.from(out), be32(T2)) >= 0, 'no creation or modification time')
    t.ok(has(out, 'free'), 'tags became free boxes')
    t.is(findSeq(Array.from(out), ascii('mdat')), findSeq(Array.from(input), ascii('mdat')), 'mdat where it was')
  }
})

test('stripAudioMetadata: refuses what audioBounds refuses', (t) => {
  t.is(stripAudioMetadata(file({ tracks: [{ handler: 'vide' }] })), null, 'a video track')
  t.is(stripAudioMetadata(file({ mvhd: mvhd0(1000, 3000), tracks: [{ runs: [[6000, 100]] }] })), null, 'a hidden long sample table')
  t.is(stripAudioMetadata(file({ tracks: [{ refs: [box('urn ', flags(0), [0], [0])], runs: [[3000, 1]] }] })), null, 'an urn')
  t.alike(stripAudioMetadata(file()), file(), 'nothing to strip: same bytes')
})

test('audioBounds: a sample table cannot declare billions of samples', (t) => {
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1], [0xffffffff, 0]] }] })), null, 'a run of zero-length samples')
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1], [0, 5000]] }] })), null, 'a run of zero samples')
  // Timescale 2^32 - 1: the tick cap alone would let 2^32 - 1 samples of one tick through.
  t.is(audioBounds(file({ mvhd: mvhd0(1000, 0), tracks: [{ timescale: 0xffffffff, runs: [[0xfffffff0, 1]] }] })), null, 'more samples than the cap, each one tick')
  t.is(audioBounds(file({ ms: MAX_SAMPLES + 1, tracks: [{ runs: [[MAX_SAMPLES + 1, 1]] }] })), null, 'one run past MAX_SAMPLES')
  t.is(audioBounds(file({ ms: MAX_SAMPLES + 1, tracks: [{ runs: [[MAX_SAMPLES, 1], [1, 1]] }] })), null, 'two runs past MAX_SAMPLES')
  t.alike(audioBounds(file({ ms: MAX_SAMPLES, tracks: [{ runs: [[MAX_SAMPLES, 1]] }] })), { ms: MAX_SAMPLES }, 'MAX_SAMPLES samples pass')

  const many = fragmented({ tracks: [fragTrak('soun', 1, 0xffffffff)], mvex: [trex(1, 1)], moofs: [moof(traf(tfhd(1), box('trun', flags(0x001), be32(0xfffffff0), be32(0))))] })
  t.is(audioBounds(many), null, 'a trun of billions of one-tick samples in a few bytes')
  const split = fragmented({
    tracks: [trak({ id: 1, timescale: 48000, runs: [[MAX_SAMPLES, 1]] })],
    mvex: [trex(1, 1)],
    moofs: [moof(traf(tfhd(1), trun({ count: 1 })))]
  })
  t.is(audioBounds(split), null, 'moov samples plus a fragment past MAX_SAMPLES')
  t.alike(audioBounds(fragmented({ mvex: [trex(1, 1)], moofs: [moof(traf(tfhd(1), trun({ count: MAX_SAMPLES })))] })), { ms: Math.round(MAX_SAMPLES * 1000 / 48000) }, 'MAX_SAMPLES fragment samples pass')
})

test('audioBounds: composition offsets are refused', (t) => {
  const ctts = box('ctts', [0, 0, 0, 0], be32(1), be32(3000), be32(0))
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]], stblExtra: [ctts] }] })), null, 'a ctts box')
  const cto = (offset) => box('trun', flags(0xb01), be32(2), be32(0), be32(24000), be32(1), be32(offset), be32(24000), be32(1), be32(offset))
  t.is(audioBounds(fragmented({ mvex: [trex(1, 0)], moofs: [moof(traf(tfhd(1), cto(48000 * 3600)))] })), null, 'a trun composition offset')
  t.alike(audioBounds(fragmented({ mvex: [trex(1, 0)], moofs: [moof(traf(tfhd(1), cto(0)))] })), { ms: 1000 }, 'zero trun composition offsets pass')
})

test('audioBounds: the edit list and tkhd agree with the samples', (t) => {
  const ok = (edits, label, version = 0) => t.alike(audioBounds(file({ tracks: [{ runs: [[3000, 1]], edits: [edts(version, edits)] }] })), { ms: 3000 }, label)
  const no = (edits, label, version = 0) => t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]], edits: [edts(version, edits)] }] })), null, label)
  ok([[3000, 0]], 'one media edit')
  ok([[3000, 0]], 'one media edit, version 1', 1)
  ok([[0, 1024]], 'a media edit of 0 plays the whole media')
  ok([[40, -1], [2960, 0]], 'a short empty edit first (priming)')
  ok([[40, -1], [2960, 0]], 'a short empty edit first, version 1', 1)
  ok([[40, -1], [0, 0]], 'an empty edit, then the whole media')
  ok([[3900, 0]], 'within the tolerance')
  no([[3000, 0], [3000, 0]], 'the samples repeated')
  no([[3000, 0], [3000, 0], [3000, 0]], 'three entries')
  no([[3600000, -1], [3000, 0]], 'an hour of silence first')
  no([[3600000, -1], [3000, 0]], 'an hour of silence first, version 1', 1)
  no([[3000, 0], [500, -1]], 'an empty edit last')
  no([[400, -1], [400, -1], [2200, 0]], 'two empty edits')
  no([[600000, 0]], 'a media edit far longer than the samples')
  no([[600000, 0]], 'a media edit far longer than the samples, version 1', 1)
  no([[1000, 0]], 'a media edit far shorter than the samples')
  no([[3000, 0, 2]], 'rate 2')
  no([[3000, 0, 0]], 'rate 0 (a dwell)')
  no([[3000, 0, 1, 0x8000]], 'a fractional rate')
  no([[3000, 0xfffffffe]], 'a negative media_time other than -1')
  no([], 'no entries')
  const twoEdts = file({ tracks: [{ runs: [[3000, 1]], edits: [edts(0, [[3000, 0]]), edts(0, [[3000, 0]])] }] })
  t.is(audioBounds(twoEdts), null, 'two edts')
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]], edits: [box('edts')] }] })), null, 'an edts without elst')
  const short = box('edts', box('elst', [0, 0, 0, 0], be32(2), be32(3000), be32(0), [0, 1, 0, 0]))
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]], edits: [short] }] })), null, 'an elst claiming more entries than its bytes')

  t.alike(audioBounds(file({ tracks: [{ runs: [[3000, 1]], head: tkhd(1, 3000) }] })), { ms: 3000 }, 'a tkhd duration agreeing')
  t.alike(audioBounds(file({ tracks: [{ runs: [[3000, 1]], head: tkhd(1, 0xffffffff) }] })), { ms: 3000 }, 'an unknown tkhd duration')
  t.alike(audioBounds(file({ tracks: [{ runs: [[3000, 1]], head: tkhd1(1, 0, 3000) }] })), { ms: 3000 }, 'a tkhd version 1 agreeing')
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]], head: tkhd(1, 3600000) }] })), null, 'a tkhd far longer than the samples')
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]], head: tkhd1(1, 0, 3600000) }] })), null, 'a tkhd version 1 far longer than the samples')
  t.alike(audioBounds(file({ tracks: [{ runs: [[3000, 1]], head: [] }] })), { ms: 3000 }, 'no tkhd: no duration to disagree')
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]], head: [...tkhd(1, 3000), ...tkhd(1, 3600000)] }] })), null, 'two tkhd')
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]], head: box('tkhd', [0, 0, 0, 7], new Array(12).fill(0)) }] })), null, 'a truncated tkhd')

  const frag = (edits) => fragmented({ tracks: [trak({ id: 1, timescale: 48000, runs: [], edits })], mvex: [trex(1, 0)], moofs: [second()] })
  t.alike(audioBounds(frag([edts(0, [[0, 0]])])), { ms: 1000 }, 'fragmented: a whole-media edit')
  t.alike(audioBounds(frag([edts(0, [[1000, 0]])])), { ms: 1000 }, 'fragmented: an agreeing edit')
  t.is(audioBounds(frag([edts(0, [[1000, 0], [1000, 0]])])), null, 'fragmented: the samples repeated')
  t.is(audioBounds(frag([edts(0, [[3600000, -1], [0, 0]])])), null, 'fragmented: an hour of silence first')
})

test('audioBounds: the sample size table counts the samples', (t) => {
  const one = (track) => audioBounds(file({ tracks: [{ runs: [[3000, 1]], ...track }] }))
  t.alike(one({}), { ms: 3000 }, 'a constant sample size counting every sample')
  // 12 bytes declaring 2^31 samples: a player sizes its per-sample arrays from this.
  t.is(one({ sizes: [stsz(0x7fffffff)] }), null, 'a constant size over billions of samples')
  t.is(one({ sizes: [stsz(MAX_SAMPLES + 1)] }), null, 'a count past MAX_SAMPLES')
  t.is(one({ sizes: [stsz(2999)] }), null, 'fewer than stts lists')
  t.is(one({ sizes: [stsz(3001)] }), null, 'more than stts lists')
  t.is(one({ sizes: [stsz(0)] }), null, 'zero samples')
  t.is(one({ sizes: [] }), null, 'no stsz')
  t.is(one({ sizes: [stsz(3000), stsz(3000)] }), null, 'two stsz')
  t.is(one({ sizes: [box('stsz', [0, 0, 0, 0], be32(10))] }), null, 'a truncated stsz')
  const stz2 = (field, count, bytes, fill = field === 4 ? 0x11 : 1) => box('stz2', [0, 0, 0, 0], [0, 0, 0, field], be32(count), new Array(bytes).fill(fill))
  t.is(one({ sizes: [stsz(3000), stz2(8, 3000, 3000)] }), null, 'stsz and stz2')
  t.alike(audioBounds(file({ tracks: [{ runs: [[3, 1000]], sizes: [stsz(3, 0, [100, 200, 300])] }] })), { ms: 3000 }, 'per-sample sizes that fit')
  t.is(audioBounds(file({ tracks: [{ runs: [[3, 1000]], sizes: [stsz(3, 0, [100, 200])] }] })), null, 'per-sample sizes past the box')
  t.is(one({ sizes: [stsz(3000, 0)] }), null, 'per-sample sizes with no bytes')
  t.alike(one({ sizes: [stz2(8, 3000, 3000)] }), { ms: 3000 }, 'stz2 of 8 bits')
  t.alike(one({ sizes: [stz2(4, 3000, 1500)] }), { ms: 3000 }, 'stz2 of 4 bits')
  t.is(one({ sizes: [stz2(16, 3000, 5999)] }), null, 'stz2 entries past the box')
  t.is(one({ sizes: [stz2(5, 3000, 3000)] }), null, 'stz2 of 5 bits')
  t.is(one({ sizes: [stz2(8, 0x7fffffff, 0)] }), null, 'stz2 over billions of samples')

  const frag = (sizes, runs = []) => fragmented({ tracks: [trak({ id: 1, timescale: 48000, runs, sizes })], mvex: [trex(1, 0)], moofs: [second()] })
  t.alike(audioBounds(frag([stsz(0)])), { ms: 1000 }, 'fragmented: an empty stsz')
  t.alike(audioBounds(frag([stsz(1)], [[1, 48000]])), { ms: 2000 }, 'fragmented: stsz counting the moov samples')
  t.is(audioBounds(frag([stsz(0x7fffffff)])), null, 'fragmented: a constant size over billions of samples')
  t.is(audioBounds(frag([stsz(1)])), null, 'fragmented: stsz counting samples stts does not list')
  t.is(audioBounds(frag([])), null, 'fragmented: no stsz')
})

test('audioBounds: chunk tables fit their bytes', (t) => {
  const one = (chunks) => audioBounds(file({ tracks: [{ runs: [[3000, 1]], chunks }] }))
  const lying = (type, count, n) => box(type, [0, 0, 0, 0], be32(count), new Array(n).fill(0))
  t.alike(one([stsc([[1, 1000]]), stco(3)]), { ms: 3000 }, 'small stsc and stco')
  t.alike(one([stsc([[1, 1000]]), co64(3)]), { ms: 3000 }, 'a small co64')
  t.is(one([lying('stsc', 0x10000000, 12), stco(1)]), null, 'an stsc claiming more entries than its bytes')
  t.is(one([stsc([[1, 3000]]), lying('stco', 0x40000000, 4)]), null, 'an stco claiming more entries than its bytes')
  t.is(one([stsc([[1, 3000]]), lying('co64', 0x20000000, 8)]), null, 'a co64 claiming more entries than its bytes')
  t.is(one([stsc([[1, 1]]), stco(MAX_SAMPLES + 1)]), null, 'an stco past MAX_SAMPLES')
  t.is(one([stsc([[1, 3000]]), stsc([[1, 3000]]), stco(1)]), null, 'two stsc')
  t.is(one([stsc([[1, 1000]]), stco(3), co64(3)]), null, 'stco and co64')
  t.is(one([box('stsc', [0, 0, 0, 0]), stco(1)]), null, 'a truncated stsc')
})

test('audioBounds: stsc covers every chunk and every sample', (t) => {
  const one = (chunks) => audioBounds(file({ tracks: [{ runs: [[3000, 1]], chunks }] }))
  t.alike(one([stsc([[1, 1000], [3, 1000]]), stco(3)]), { ms: 3000 }, 'two entries, the last running to the last chunk')
  t.alike(one([stsc([[1, 1024], [2, 988]]), stco(3)]), { ms: 3000 }, 'a shorter last run')
  // Chrome's demuxer allocates index entries from samples_per_chunk.
  t.is(one([stsc([[1, 0xffffffff]]), stco(3)]), null, 'billions of samples per chunk')
  t.is(one([stsc([[1, 1001]]), stco(3)]), null, 'more samples than stsz counts')
  t.is(one([stsc([[1, 999]]), stco(3)]), null, 'fewer samples than stsz counts')
  t.is(one([stsc([[1, 1000], [2, 0]]), stco(3)]), null, 'zero samples per chunk')
  t.is(one([stsc([[2, 1500]]), stco(3)]), null, 'first_chunk not 1')
  t.is(one([stsc([[0, 1000]]), stco(3)]), null, 'first_chunk 0')
  t.is(one([stsc([[1, 1000], [1, 1000]]), stco(3)]), null, 'first_chunk repeated')
  t.is(one([stsc([[1, 1000], [3, 1000], [2, 1000]]), stco(3)]), null, 'first_chunk going back')
  t.is(one([stsc([[1, 1000], [4, 1000]]), stco(3)]), null, 'first_chunk past the last chunk')
  t.is(one([stsc([[1, 1000, 2]]), stco(3)]), null, 'sample description 2')
  t.is(one([stsc([[1, 1000, 0]]), stco(3)]), null, 'sample description 0')
  t.is(one([stsc([]), stco(3)]), null, 'no entries for the samples')
  t.is(one([stco(3)]), null, 'no stsc')
  t.is(one([stsc([[1, 3000]])]), null, 'no stco or co64')
  t.is(one([]), null, 'no chunk tables')
  const frag = (chunks, runs = []) => fragmented({ tracks: [trak({ id: 1, timescale: 48000, runs, chunks })], mvex: [trex(1, 0)], moofs: [second()] })
  t.alike(audioBounds(frag([])), { ms: 1000 }, 'fragmented without moov samples: no chunk tables needed')
  t.alike(audioBounds(frag([stsc([[1, 1]]), stco(1)], [[1, 48000]])), { ms: 2000 }, 'fragmented with moov samples in stsc')
  t.is(audioBounds(frag([], [[1, 48000]])), null, 'fragmented with moov samples and no stsc')
  t.is(audioBounds(frag([stsc([[1, 0xffffffff]]), stco(1)], [[1, 48000]])), null, 'fragmented: billions of samples per chunk')
})

test('audioBounds: sample sizes stay within the file', (t) => {
  const one = (sizes, runs = [[3000, 1]]) => audioBounds(file({ tracks: [{ runs, sizes }] }))
  const len = file().byteLength
  // ExoPlayer sizes its codec input buffers from the largest sample.
  t.is(one([stsz(3000, 0x7fffffff)]), null, 'a constant size of 2 GB')
  t.is(one([stsz(3000, 2)]), null, 'constant sizes adding up to more than the file')
  t.is(one([stsz(3, 0, [100, 0xfffffff0, 1])], [[3, 1000]]), null, 'one huge per-sample size')
  t.is(one([stsz(3, 0, [100, 0, 100])], [[3, 1000]]), null, 'a per-sample size of zero')
  t.is(one([stsz(3, 0, [len, len, len])], [[3, 1000]]), null, 'per-sample sizes adding up to more than the file')
  const stz2 = (field, count, entries) => box('stz2', [0, 0, 0, 0], [0, 0, 0, field], be32(count), entries)
  t.is(one([stz2(8, 3000, [0, ...new Array(2999).fill(1)])]), null, 'an stz2 size of zero')
  t.is(one([stz2(4, 3000, [0x10, ...new Array(1499).fill(0x11)])]), null, 'a 4-bit stz2 size of zero')
  t.is(one([stz2(16, 3000, new Array(6000).fill(0xff))]), null, 'stz2 sizes adding up to more than the file')

  const frag = (moofs, mvex = [trex(1, 960)]) => audioBounds(fragmented({ mvex, moofs }))
  const sized = (sizes) => box('trun', flags(0x201), be32(sizes.length), be32(0), ...sizes.map(be32))
  t.alike(frag([moof(traf(tfhd(1), sized([5, 5])))]), { ms: 40 }, 'trun sizes that fit')
  t.is(frag([moof(traf(tfhd(1), sized([5, 0x7fffffff])))]), null, 'a trun size of 2 GB')
  t.is(frag([moof(traf(tfhd(1), sized([5, 0])))]), null, 'a trun size of zero')
  const noSizes = (count) => box('trun', flags(0x001), be32(count), be32(0))
  const trexSized = (size) => box('trex', [0, 0, 0, 0], be32(1), be32(1), be32(960), be32(size), be32(0))
  t.alike(frag([moof(traf(tfhd(1), noSizes(2)))], [trexSized(10)]), { ms: 40 }, 'a trex default size')
  t.is(frag([moof(traf(tfhd(1), noSizes(2)))], [trexSized(0)]), null, 'no size anywhere')
  t.is(frag([moof(traf(tfhd(1), noSizes(2)))], [trexSized(0x7fffffff)]), null, 'a trex default size of 2 GB')
  const tfhdSized = (size) => box('tfhd', flags(0x020018), be32(1), be32(960), be32(size))
  t.alike(frag([moof(traf(tfhdSized(10), noSizes(2)))], [trexSized(0)]), { ms: 40 }, 'a tfhd default size')
  t.is(frag([moof(traf(tfhdSized(0x7fffffff), noSizes(2)))], [trexSized(10)]), null, 'a tfhd default size of 2 GB')
  t.is(frag([moof(traf(tfhdSized(0), noSizes(2)))], [trexSized(10)]), null, 'a tfhd default size of zero')
  t.is(frag([moof(traf(box('tfhd', flags(0x020018), be32(1), be32(960))), noSizes(2))], [trexSized(10)]), null, 'a truncated tfhd default size')
})

test('audioBounds: the sample entry carries one AAC or Opus configuration', (t) => {
  const one = (entry) => audioBounds(file({ tracks: [{ entries: [entry], runs: [[3000, 1]] }] }))
  t.alike(one(mp4a()), { ms: 3000 }, 'AAC')
  for (const oti of [0x66, 0x67, 0x68]) t.alike(one(mp4a(esds(oti))), { ms: 3000 }, 'MPEG-2 AAC ' + oti)
  t.is(one(box('mp4a', new Array(28).fill(0))), null, 'an mp4a without esds')
  t.is(one(mp4a(esds(), esds())), null, 'two esds')
  t.is(one(mp4a(esds(0x6b))), null, 'MP3 in an mp4a')
  t.is(one(mp4a(esds(0x20))), null, 'MPEG-4 video in an mp4a')
  t.is(one(mp4a(esds(0x40, 0x04))), null, 'a visual stream')
  t.is(one(mp4a(box('esds', [0, 0, 0, 0], [3, 0]))), null, 'an empty ES_Descriptor')
  t.is(one(mp4a(box('esds', [0, 0, 0, 0], [3, 0xff, 0xff, 0xff, 0xff, 0]))), null, 'a length of five bytes')
  t.is(one(mp4a(box('esds', [0, 0, 0, 0], [3, 0x80, 0x80, 0x80, 0x7f, 0, 1, 0]))), null, 'a length past the box')
  t.is(one(mp4a(box('esds', [0, 0, 0, 0], [3, 0x05, 0, 1, 0, 0x04, 0x30]))), null, 'a decoder config past its ES_Descriptor')
  t.is(one(mp4a(box('esds', [0, 0, 0, 0], [3, 0x08, 0, 1, 0, 0x04, 0x03, 0x40, 0x15, 0]))), null, 'a decoder config too short')
  t.is(one(mp4a(box('esds', [0, 0, 0, 0], [3, 0x05, 0, 1, 0x40, 0xff, 0]))), null, 'a URL past the descriptor')
  // The DecoderSpecificInfo must be there, small and inside its parent: Media3
  // allocates the length it declares before reading. withDsi builds an esds
  // whose lengths are exact, so only the DecoderSpecificInfo differs.
  const withDsi = (dsi) => {
    const dc = [0x40, (0x05 << 2) | 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...dsi]
    const es = [0, 1, 0, 0x04, dc.length, ...dc, 0x06, 0x01, 0x02]
    return box('esds', [0, 0, 0, 0], [0x03, es.length, ...es])
  }
  t.alike(one(mp4a(withDsi([0x05, 0x02, 0x12, 0x10]))), one(mp4a(esds())), 'the builder matches a valid esds')
  t.ok(one(mp4a(withDsi([0x05, 0x02, 0x12, 0x10]))) !== null, 'a two-byte AudioSpecificConfig passes')
  t.is(one(mp4a(withDsi([]))), null, 'no DecoderSpecificInfo')
  t.is(one(mp4a(withDsi([0x05, 0x8f, 0xff, 0xff, 0x7f, 0x12, 0x10]))), null, 'a DecoderSpecificInfo declaring 268 MB')
  t.is(one(mp4a(withDsi([0x05, 0x41, ...new Array(65).fill(0x11)]))), null, 'a DecoderSpecificInfo over 64 bytes')
  t.is(one(mp4a(withDsi([0x05, 0x01, 0x12]))), null, 'a DecoderSpecificInfo of one byte')
  const v1 = box('mp4a', [0, 0, 0, 0, 0, 0, 0, 1, 0, 1], new Array(34).fill(0), esds())
  t.is(one(v1), null, 'a QuickTime version 1 entry')
  t.alike(one(opus()), { ms: 3000 }, 'Opus')
  t.is(one(box('Opus', new Array(28).fill(0))), null, 'an Opus entry without dOps')
  t.is(one(opus(dOps(), dOps())), null, 'two dOps')
  t.is(one(opus(box('dOps', [0, 2, 0]))), null, 'a truncated dOps')
  t.is(one(opus(esds())), null, 'an esds in an Opus entry')
})

test('audioBounds: a received note carries no metadata or uuid boxes', (t) => {
  const meta = () => box('meta', [0, 0, 0, 0], box('ilst', box('\u00a9nam', be32(0))))
  const udta = () => box('udta', ascii('tags'))
  const uuid = () => box('uuid', new Array(16).fill(7), [1, 2])
  const inTrak = (extra) => file({ tracks: [{ runs: [[3000, 1]], edits: extra }] })
  const inMinf = (extra) => file({ tracks: [{ runs: [[3000, 1]], extra }] })
  const inMoov = (x) => new Uint8Array([...ftyp(), ...box('moov', mvhd0(1000, 3000), trak({ runs: [[3000, 1]] }), x), ...box('mdat', new Array(4000).fill(1))])
  const cases = [
    ['top level', (x) => file({ tail: x })],
    ['moov', inMoov],
    ['trak', (x) => inTrak([x])],
    ['minf', (x) => inMinf([x])],
    ['stbl', (x) => file({ tracks: [{ runs: [[3000, 1]], stblExtra: [x] }] })],
    ['edts', (x) => inTrak([box('edts', elst(0, [[3000, 0]]), x)])],
    ['mvex', (x) => fragmented({ mvex: [trex(1, 0), x], moofs: [second()] })],
    ['moof', (x) => fragmented({ mvex: [trex(1, 0)], moofs: [box('moof', box('mfhd', [0, 0, 0, 0], be32(1)), traf(tfhd(1), trun({ durations: [48000] })), x)] })],
    ['traf', (x) => fragmented({ mvex: [trex(1, 0)], moofs: [moof(traf(tfhd(1), trun({ durations: [48000] }), x))] })]
  ]
  for (const [where, make] of cases) {
    t.ok(audioBounds(make(box('free', [0]))) !== null, 'a free box in ' + where + ' passes')
    for (const [name, x] of [['meta', meta()], ['udta', udta()], ['uuid', uuid()]]) {
      t.is(audioBounds(make(x)), null, 'a ' + name + ' box in ' + where)
    }
    t.ok(audioBounds(make(meta()), { metadata: true }) !== null, 'the sender tolerates meta in ' + where)
    t.ok(audioBounds(make(udta()), { metadata: true }) !== null, 'the sender tolerates udta in ' + where)
    t.is(audioBounds(make(uuid()), { metadata: true }), null, 'even the sender refuses uuid in ' + where)
    const stripped = stripAudioMetadata(make(meta()))
    t.ok(stripped !== null && audioBounds(stripped) !== null, 'stripped meta in ' + where + ' passes the strict check')
  }
  // Nor inside the sample entry.
  const inEntry = (x) => file({ tracks: [{ runs: [[3000, 1]], entries: [box('mp4a', [0, 0, 0, 0, 0, 0, 0, 1, 0, 0], new Array(18).fill(0), esds(), x)] }] })
  t.ok(audioBounds(inEntry(box('free', [0]))) !== null, 'a free box in the sample entry passes')
  for (const x of [meta(), udta(), uuid()]) t.is(audioBounds(inEntry(x)), null, 'metadata in the sample entry')
  // A zero-size ilst entry made Media3 loop: never parsed, refused on receipt.
  const loop = inMoov(box('meta', [0, 0, 0, 0], box('ilst', be32(0), ascii('data'))))
  t.is(audioBounds(loop), null, 'a zero-size ilst entry inside moov/meta')
  t.ok(audioBounds(loop, { metadata: true }) !== null, 'the sender skips its contents unparsed')
  t.ok(audioBounds(stripAudioMetadata(loop)) !== null, 'and strips it')
  t.is(audioBounds(inMoov(udta()), 3), null, 'options that are not an object keep the strict check')
  t.is(audioBounds(inMoov(udta()), null), null, 'a null options object')
  t.is(audioBounds(inMoov(udta()), { metadata: 1 }), null, 'metadata must be exactly true')
})

// bytes with x appended to the box at path (each step the first child of
// that type, [] for the top level), every enclosing size grown to match.
function put (bytes, path, x) {
  const b = Array.from(bytes)
  const size = (p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
  const head = { stsd: 8, mp4a: 28, Opus: 28 }
  const chain = []
  let start = 0
  let end = b.length
  for (const type of path) {
    let p = start
    while (p < end && String.fromCharCode(...b.slice(p + 4, p + 8)) !== type) p += size(p)
    if (p >= end) throw new Error('no ' + type)
    chain.push(p)
    end = p + size(p)
    start = p + 8 + (head[type] || 0)
  }
  b.splice(end, 0, ...x)
  for (const p of chain) b.splice(p, 4, ...be32(size(p) + x.length))
  return new Uint8Array(b)
}

test('audioBounds: a received note holds only the boxes the check reads', (t) => {
  const plain = file({ tracks: [{ runs: [[3000, 1]], edits: [edts(0, [[3000, 0]])] }] })
  const withOpus = file({ tracks: [{ runs: [[3000, 1]], entries: [opus()] }] })
  const frag = fragmented({ mvex: [trex(1, 0)], moofs: [second()] })
  const stbl = ['moov', 'trak', 'mdia', 'minf', 'stbl']
  const entry = [...stbl, 'stsd', 'mp4a']
  const opusEntry = [...stbl, 'stsd', 'Opus']
  t.alike(audioBounds(plain), { ms: 3000 }, 'the plain note passes')
  t.alike(audioBounds(withOpus), { ms: 3000 }, 'the Opus note passes')
  t.alike(audioBounds(frag), { ms: 1000 }, 'the fragmented note passes')
  // A player may find a trak at any depth, or decode a codec box beside the
  // checked esds (Media3 takes a dac3's AC-3 format over the esds).
  const where = [
    [plain, []],
    [plain, ['moov']],
    [plain, ['moov', 'trak']],
    [plain, ['moov', 'trak', 'edts']],
    [plain, ['moov', 'trak', 'mdia']],
    [plain, ['moov', 'trak', 'mdia', 'minf']],
    [plain, ['moov', 'trak', 'mdia', 'minf', 'dinf']],
    [plain, stbl],
    [plain, entry],
    [withOpus, opusEntry],
    [frag, ['moov', 'mvex']],
    [frag, ['moof']],
    [frag, ['moof', 'traf']]
  ]
  const unread = [['a second trak', trak({ handler: 'vide', id: 2 })], ['a dac3', box('dac3', [0x10, 0x3d, 0x40])]]
  for (const [base, path] of where) {
    const name = path.length ? path[path.length - 1] : 'the top level'
    for (const [what, x] of unread) {
      // moov lists one trak: a second one is a count, below.
      if (name === 'moov' && what === 'a second trak') continue
      const bytes = put(base, path, x)
      t.is(audioBounds(bytes), null, what + ' in ' + name)
      const out = stripAudioMetadata(bytes)
      t.ok(out !== null && audioBounds(out) !== null, 'the sender strips ' + what + ' in ' + name)
    }
  }
  for (const type of ['dec3', 'dfLa', 'alac', 'sinf', 'dOps']) {
    t.is(audioBounds(put(plain, entry, box(type, [0, 0, 0, 0]))), null, 'a ' + type + ' beside the esds')
  }
  t.is(audioBounds(put(plain, entry, box('wave', esds()))), null, 'a wave holding another esds')
  t.is(audioBounds(put(plain, stbl.slice(0, 4), box('nmhd', [0, 0, 0, 0]))), null, 'an nmhd in minf')
  t.is(audioBounds(put(plain, ['moov', 'trak'], box('tref', box('hint', be32(2))))), null, 'a tref in trak')

  // What recorders write passes.
  const btrt = () => box('btrt', be32(0), be32(64000), be32(64000))
  t.alike(audioBounds(put(plain, entry, btrt())), { ms: 3000 }, 'a btrt in mp4a')
  t.alike(audioBounds(put(plain, entry, box('sbtd', [0, 0, 0, 0], ascii('I16')))), { ms: 3000 }, "Apple's sbtd in mp4a")
  t.alike(audioBounds(put(withOpus, opusEntry, btrt())), { ms: 3000 }, 'a btrt in Opus')

  // Sample groups in stbl hold their own fields and mark nothing encrypted.
  const roll = (count = 1) => box('sgpd', [1, 0, 0, 0], ascii('roll'), be32(2), be32(count), [0xff, 0xff])
  const mapped = (n, type = 'roll') => box('sbgp', [0, 0, 0, 0], ascii(type), be32(1), be32(n), be32(1))
  t.alike(audioBounds(put(put(plain, stbl, roll()), stbl, mapped(3000))), { ms: 3000 }, 'a roll group over every sample')
  t.alike(audioBounds(put(plain, stbl, box('sgpd', [0, 0, 0, 0], ascii('roll'), be32(0)))), { ms: 3000 }, 'an empty version 0 sgpd')
  const groups = [
    ['an encryption group', box('sgpd', [1, 0, 0, 0], ascii('seig'), be32(20), be32(1), new Array(20).fill(0))],
    ['samples mapped to an encryption group', mapped(3000, 'seig')],
    ['an sgpd declaring more entries than it holds', roll(0xffffffff)],
    ['a version 0 sgpd with entries', box('sgpd', [0, 0, 0, 0], ascii('roll'), be32(1), [0xff, 0xff])],
    ['a version 2 sgpd with entries', box('sgpd', [2, 0, 0, 0], ascii('roll'), be32(0), be32(1), [0xff, 0xff])],
    ['an unknown sgpd version', box('sgpd', [3, 0, 0, 0], ascii('roll'), be32(0), be32(0))],
    ['an sbgp mapping more samples than the track holds', mapped(3001)],
    ['an sbgp declaring more entries than it holds', box('sbgp', [0, 0, 0, 0], ascii('roll'), be32(2), be32(1), be32(1))],
    ['a truncated sbgp', box('sbgp', [0, 0, 0, 0], ascii('roll'))]
  ]
  for (const [name, x] of groups) {
    const bytes = put(plain, stbl, x)
    t.is(audioBounds(bytes), null, name)
    t.is(audioBounds(bytes, { metadata: true }), null, name + ', even for the sender')
  }

  // A listed box past its count is refused, even for the sender.
  const counted = [
    ['two ftyp', new Uint8Array([...plain, ...ftyp()])],
    ['two btrt in mp4a', put(put(plain, entry, btrt()), entry, btrt())],
    ['two sbtd in mp4a', put(put(plain, entry, box('sbtd', [0])), entry, box('sbtd', [0]))],
    ['two btrt in Opus', put(put(withOpus, opusEntry, btrt()), opusEntry, btrt())],
    ['two trex', fragmented({ mvex: [trex(1, 0), trex(2, 0)], moofs: [second()] })]
  ]
  for (const [name, bytes] of counted) {
    t.is(audioBounds(bytes), null, name)
    t.is(audioBounds(bytes, { metadata: true }), null, name + ', even for the sender')
  }
})

const tfdt0 = (v) => box('tfdt', [0, 0, 0, 0], be32(v))
const tfdt1 = (hi, lo) => box('tfdt', [1, 0, 0, 0], be32(hi), be32(lo))
const at = (...tfdts) => moof(traf(tfhd(1), ...tfdts, trun({ durations: [48000] })))

test('audioBounds: fragment decode times follow the samples', (t) => {
  const frag = (...moofs) => audioBounds(fragmented({ mvex: [trex(1, 0)], moofs }))
  t.alike(frag(at(tfdt0(0)), at(tfdt0(48000))), { ms: 2000 }, 'contiguous fragments')
  t.alike(frag(at(tfdt1(0, 0)), at(tfdt1(0, 48000))), { ms: 2000 }, 'contiguous fragments, version 1')
  t.alike(frag(at(tfdt0(0)), at()), { ms: 2000 }, 'a traf without tfdt continues')
  // ffprobe read 3602 s from two 1 s fragments placed an hour apart.
  t.is(frag(at(tfdt0(0)), at(tfdt0(48000 * 3600))), null, 'an hour of gap between fragments')
  t.is(frag(at(), at(tfdt1(0, 48000 * 3600))), null, 'an hour of gap, version 1')
  t.is(frag(at(tfdt0(0)), at(tfdt0(0))), null, 'overlapping fragments')
  t.is(frag(at(tfdt0(48000 * 3600))), null, 'a first fragment an hour in')
  t.is(frag(at(tfdt0(0), tfdt0(0))), null, 'two tfdt in a traf')
  t.is(frag(at(tfdt1(0xffffffff, 0))), null, 'a tfdt past safe integers')
  t.is(frag(at(box('tfdt', [2, 0, 0, 0], be32(0), be32(0)))), null, 'an unknown tfdt version')
  t.is(frag(at(box('tfdt', [1, 0, 0, 0], be32(0)))), null, 'a truncated tfdt')
  const inMoov = fragmented({ tracks: [trak({ id: 1, timescale: 48000, runs: [[1, 48000]] })], mvex: [trex(1, 0)], moofs: [at(tfdt0(48000))] })
  t.alike(audioBounds(inMoov), { ms: 2000 }, 'the first fragment starts after the moov samples')
  const behind = fragmented({ tracks: [trak({ id: 1, timescale: 48000, runs: [[1, 48000]] })], mvex: [trex(1, 0)], moofs: [at(tfdt0(0))] })
  t.is(audioBounds(behind), null, 'a fragment over the moov samples')
})

test('audioBounds: segment indexes and stray fragments are refused', (t) => {
  const sidx = box('sidx', [0, 0, 0, 0], be32(1), be32(48000), be32(0), be32(0), [0, 0, 0, 1], be32(10), be32(48000 * 3600), be32(0))
  const frag = fragmented({ mvex: [trex(1, 0)], moofs: [second()] })
  t.alike(audioBounds(frag), { ms: 1000 }, 'a fragmented file')
  t.is(audioBounds(new Uint8Array([...frag, ...sidx])), null, 'a fragmented file with sidx')
  t.is(audioBounds(file({ tail: sidx })), null, 'a plain file with sidx')
  t.is(audioBounds(file({ tail: second() })), null, 'a moof without mvex')
  t.is(audioBounds(file({ tail: box('styp', ascii('msdh'), be32(0)) })), null, 'a styp without mvex')
})

test('audioBounds: exactly one track', (t) => {
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]] }, { runs: [[2000, 1]] }] })), null, 'two sound tracks')
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]] }, { runs: [[3000, 1]] }] })), null, 'two equal sound tracks')
})

const mdhd1 = (timescale, hi, lo) => box('mdhd', [1, 0, 0, 0], be32(0), be32(0), be32(0), be32(0), be32(timescale), be32(hi), be32(lo), [0, 0, 0, 0])

// What Chrome's MediaRecorder writes for audio/mp4 (Opus): mvhd and tkhd in
// ms at timescale 1000, and an mdhd whose timescale is 48000 but whose
// duration is the same ms, so it claims about a fiftieth of the length.
function chrome (ms, version = 1) {
  const frames = new Array(ms / 100).fill(4800)
  return fragmented({
    mvhd: version === 1 ? mvhd1(1000, 0, ms) : mvhd0(1000, ms),
    tracks: [trak({ id: 1, timescale: 48000, runs: [], entries: [opus()], head: version === 1 ? tkhd1(1, 0, ms) : tkhd(1, ms), media: version === 1 ? mdhd1(48000, 0, ms) : mdhd(48000, ms) })],
    mvex: [trex(1, 0)],
    moofs: [moof(traf(tfhd(1), tfdt1(0, 0), trun({ durations: frames })))]
  })
}

// The duration field of the first mvhd, tkhd, mdhd or mehd in bytes.
function durationOf (bytes, type) {
  const p = findSeq(Array.from(bytes), ascii(type)) + 4
  const at = { mvhd: [16, 24], mdhd: [16, 24], tkhd: [20, 28], mehd: [4, 4] }[type][bytes[p]]
  const read = (q) => ((bytes[q] << 24) | (bytes[q + 1] << 16) | (bytes[q + 2] << 8) | bytes[q + 3]) >>> 0
  return bytes[p] === 0 ? read(p + at) : read(p + at) * 0x100000000 + read(p + at + 4)
}

test('stripAudioMetadata: a recorder header that disagrees with its samples is rewritten by the sender', (t) => {
  for (const version of [0, 1]) {
    const input = chrome(4900, version)
    t.is(audioBounds(input), null, 'refused as recorded on receipt, version ' + version)
    t.alike(audioBounds(input, { metadata: true }), { ms: 4900 }, 'the samples decide for its sender, version ' + version)
    const out = stripAudioMetadata(input)
    t.alike(audioBounds(out), { ms: 4900 }, 'the copy sent passes the strict check, version ' + version)
    t.is(durationOf(out, 'mdhd'), 4900 * 48, 'mdhd in its own timescale, version ' + version)
    t.is(durationOf(out, 'mvhd'), 4900, 'mvhd, version ' + version)
    t.is(durationOf(out, 'tkhd'), 4900, 'tkhd, version ' + version)
    t.is(out.byteLength, input.byteLength, 'same size, version ' + version)
  }

  const liar = file({ mvhd: mvhd0(1000, 9000), tracks: [{ duration: 1, head: tkhd(1, 7000), runs: [[3000, 1]] }] })
  t.is(audioBounds(liar), null, 'headers off the samples on receipt')
  t.alike(audioBounds(liar, { metadata: true }), { ms: 3000 }, 'the sender reads the samples')
  t.alike(stripAudioMetadata(liar), file({ mvhd: mvhd0(1000, 3000), tracks: [{ duration: 3000, head: tkhd(1, 3000), runs: [[3000, 1]] }] }), 'every given duration rewritten, nothing else')

  const movie = file({ mvhd: mvhd0(44100, 9000), tracks: [{ timescale: 44100, duration: 44100 * 3, runs: [[129, 1024], [1, 300]] }] })
  const ticks = 129 * 1024 + 300
  const rewritten = stripAudioMetadata(movie)
  t.alike(audioBounds(rewritten), { ms: Math.round(ticks * 1000 / 44100) }, 'a movie timescale other than 1000')
  t.is(durationOf(rewritten, 'mvhd'), ticks, 'mvhd in the movie timescale')
  t.is(durationOf(rewritten, 'mdhd'), ticks, 'mdhd in the media timescale')

  t.alike(stripAudioMetadata(file({ mvhd: mvhd0(1000, 0) })), file({ mvhd: mvhd0(1000, 0) }), 'a duration not given stays not given')
  t.alike(stripAudioMetadata(file({ mvhd: mvhd0(1000, 0xffffffff) })), file({ mvhd: mvhd0(1000, 0xffffffff) }), 'an unknown duration stays unknown')

  const mehd = fragmented({ mvex: [mehd0(100), trex(1, 0)], moofs: [second(), second()] })
  t.is(audioBounds(mehd), null, 'a short mehd on receipt')
  t.is(durationOf(stripAudioMetadata(mehd), 'mehd'), 2000, 'mehd rewritten from the fragments')
  t.alike(audioBounds(stripAudioMetadata(mehd)), { ms: 2000 })

  // The samples' total at this timescale no longer fits a version 0 mdhd.
  t.is(stripAudioMetadata(file({ ms: 2000, tracks: [{ timescale: 0xfffffff0, duration: 5, runs: [[2, 0xfffffff0]] }] })), null, 'a value past a version 0 field')
})

test('audioBounds: the sender still answers to its samples and edit list', (t) => {
  t.is(audioBounds(file({ mvhd: mvhd0(1000, 3000), tracks: [{ runs: [[6000, 100]] }] }), { metadata: true }), null, 'samples past the limit')
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]], edits: [edts(0, [[9000, 0]])] }] }), { metadata: true }), null, 'an edit list off the samples')
  t.is(audioBounds(file({ tracks: [{ runs: [[3000, 1]], head: tkhd1(1, 0x7fffffff, 0) }] }), { metadata: true }), null, 'a tkhd duration that is not a safe integer')
  t.is(stripAudioMetadata(file({ tracks: [{ runs: [[3000, 1]], edits: [edts(0, [[9000, 0]])] }] })), null, 'nothing to strip into a valid note')
})
