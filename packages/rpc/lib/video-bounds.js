'use strict'

// Reads a short video (video/mp4: H.264 in an avc1 entry, at most one AAC
// sound track) from its ISO BMFF boxes and refuses anything else: the mime a
// peer declares is not trusted, and every player parses what this lets
// through. The duration is the samples' (stts), not a header's: a player
// plays every sample. Samples are never decoded. Anything truncated,
// malformed, over a bound, fragmented, encrypted, with a data reference
// outside the file, or with a track other than one video and at most one
// sound track is null. Never throws. Works on Uint8Array only, with no Node
// built-ins, so the app bundle can use it.
//
// The box primitives are copied from audio-bounds.js, not shared: a change
// made for voice notes must not loosen the video check, nor the reverse.
//
// Every container the walk visits (moov, trak, edts, mdia, minf, dinf, stbl
// and the mp4a entry) may hold only the child boxes listed for it in
// CHILDREN, each no more often than listed; any other child is refused. The
// avc1 entry has its own list (AVC_EXTRAS) and the top level its own
// (TOP_LEVEL).
//
// A received video carries no metadata: udta, meta and uuid are refused
// wherever the walk goes (a camera puts the place it was shot there). Only
// the sender, about to strip its own file, passes { metadata: true }: those
// boxes are then skipped, never parsed, and header durations are not
// compared, since stripVideoMetadata rewrites them from the samples.

const MAX_VIDEO_MS = 30000
const MAX_MOMENT_VIDEO_MS = 15000
// How far a header, an edit list or the sound track may be from the video
// samples: muxers round durations and pad audio with priming frames.
const VIDEO_MS_TOLERANCE = 1000
const MAX_VIDEO_DIMENSION = 1920
const MAX_VIDEO_PIXELS = 2073600
// 30 s at 60 frames a second.
const MAX_VIDEO_SAMPLES = 1800
// AAC at 48 kHz is about 47 frames a second; this is far past 31 s of it.
const MAX_SOUND_SAMPLES = 20000
const MAX_BYTES = 8388608
// Boxes walked before giving up; each costs at least 8 bytes, so the walk
// stays linear in size.
const MAX_BOXES = 16384
const VIDEO_BRANDS = Object.freeze(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1'])
// A QuickTime brand, as the major brand or among the compatible ones, makes
// a player read the file by QuickTime rules: refused.
const QUICKTIME_BRAND = 'qt  '
const TOP_LEVEL = Object.freeze(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'])
const METADATA = Object.freeze(['udta', 'meta', 'uuid'])
const MANY = Infinity
// The child boxes each walked container may hold, with how many of each. A
// minf takes the media header of its track's kind. free and skip may sit
// anywhere: the sender's strip turns udta, meta, uuid and any unlisted child
// into same-size free boxes, and its output must pass this check. stbl lists
// ctts for both kinds; the sound track refuses it on its own.
const FILL = { free: MANY, skip: MANY }
const rule = (list) => Object.freeze(Object.assign(Object.create(null), FILL, list))
const CHILDREN = Object.freeze({
  moov: rule({ mvhd: 1, trak: 2 }),
  trak: rule({ tkhd: 1, edts: 1, mdia: 1 }),
  edts: rule({ elst: 1 }),
  mdia: rule({ mdhd: 1, hdlr: 1, minf: 1 }),
  dinf: rule({ dref: 1 }),
  stbl: rule({ stsd: 1, stts: 1, ctts: 1, cslg: 1, stss: 1, stsc: 1, stsz: 1, stz2: 1, stco: 1, co64: 1, sdtp: 1, sgpd: MANY, sbgp: MANY }),
  mp4a: rule({ esds: 1, btrt: 1 })
})
const MINF = Object.freeze({
  vide: rule({ vmhd: 1, dinf: 1, stbl: 1 }),
  soun: rule({ smhd: 1, dinf: 1, stbl: 1 })
})
// Fragments (their samples are not in moov), segment indexes (another
// timeline) and protection boxes (encrypted samples) are refused wherever
// the walk meets them.
const REFUSED = Object.freeze(['moof', 'styp', 'sidx', 'mvex', 'sinf', 'pssh', 'senc', 'saiz', 'saio'])
const AVC_PROFILES = Object.freeze([66, 77, 100])
const MAX_AVC_LEVEL = 42
// Children an avc1 entry may carry besides its single avcC. chrm (chroma
// sample location) is there because AVFoundation's AVAssetWriter writes it
// into every H.264 MP4 it makes, next to fiel.
const AVC_EXTRAS = Object.freeze(['pasp', 'colr', 'btrt', 'clap', 'fiel', 'chrm', 'free', 'skip'])
const AAC_OBJECT_TYPES = Object.freeze([0x40, 0x66, 0x67, 0x68])
// The AudioSpecificConfig's audio object type: AAC-LC, SBR (HE-AAC) and PS
// (HE-AAC v2). 31 is the escape to a wider type, never one of these.
const AAC_AUDIO_TYPES = Object.freeze([2, 5, 29])
// The only colr an avc1 entry may carry: 'nclx' with its three 16-bit codes
// and the full-range byte. An ICC profile is refused.
const COLR_NCLX_BYTES = 11
const AUDIO_STREAM = 0x05
const MAX_DECODER_CONFIG = 64
const UNKNOWN = -1
const ONE = 0x10000
// The VisualSampleEntry fields before its child boxes, and the
// AudioSampleEntry's.
const VISUAL_ENTRY = 78
const AUDIO_ENTRY = 28

function be16 (b, p) {
  return (b[p] << 8) | b[p + 1]
}

function be32 (b, p) {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
}

function s32 (b, p) {
  return (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]
}

// A 64-bit value, or -1 when it is not a safe integer.
function be64 (b, p) {
  const hi = be32(b, p)
  if (hi > 0x1fffff) return -1
  return hi * 0x100000000 + be32(b, p + 4)
}

function allOnes64 (b, p) {
  return be32(b, p) === 0xffffffff && be32(b, p + 4) === 0xffffffff
}

function fourcc (b, p) {
  return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3])
}

function toMs (ticks, timescale) {
  return Math.round(ticks * 1000 / timescale)
}

function fullBoxFlags (b, box) {
  return (b[box.body + 1] << 16) | (b[box.body + 2] << 8) | b[box.body + 3]
}

// The child boxes of b[start, end) as { type, start, body, end }, or null when
// a size does not fit its parent or the walk runs over the budget.
function children (b, start, end, budget) {
  const out = []
  let p = start
  while (p < end) {
    if (++budget.n > MAX_BOXES || end - p < 8) return null
    let size = be32(b, p)
    const type = fourcc(b, p + 4)
    let body = p + 8
    if (size === 1) {
      if (end - p < 16) return null
      size = be64(b, p + 8)
      body = p + 16
    } else if (size === 0) {
      size = end - p
    }
    if (size < body - p || size > end - p) return null
    out.push({ type, start: p, body, end: p + size })
    p += size
  }
  return out
}

function clean (list, budget) {
  return !list.some((x) => REFUSED.includes(x.type) || (!budget.metadata && METADATA.includes(x.type)))
}

function allowed (allow, type) {
  return Object.prototype.hasOwnProperty.call(allow, type)
}

// The children of b[start, end), or null when malformed or holding a refused
// box. On the sender's file (budget.metadata) udta, meta and uuid are left
// out, never parsed. With allow (a CHILDREN list), a child not on it, or on
// it more often than it allows, is refused too; only the strip's own walk
// (budget.strip) leaves an unlisted child out unparsed instead, since the
// strip turns it into free.
function listed (b, start, end, budget, allow) {
  const list = children(b, start, end, budget)
  if (!list || !clean(list, budget)) return null
  const kept = budget.metadata ? list.filter((x) => !METADATA.includes(x.type)) : list
  if (!allow) return kept
  const out = []
  const seen = Object.create(null)
  for (const x of kept) {
    if (!allowed(allow, x.type)) {
      if (!budget.strip) return null
      continue
    }
    seen[x.type] = (seen[x.type] || 0) + 1
    if (seen[x.type] > allow[x.type]) return null
    out.push(x)
  }
  return out
}

function inside (b, box, budget, allow) {
  return listed(b, box.body, box.end, budget, allow)
}

function only (boxes, type) {
  const found = boxes.filter((x) => x.type === type)
  return found.length === 1 ? found[0] : null
}

function atMostOne (boxes, type) {
  return boxes.filter((x) => x.type === type).length <= 1
}

// ftyp names a video brand, as its major brand or a compatible one, and no
// QuickTime brand anywhere.
function videoBrand (b, box) {
  if (box.end - box.body < 8 || (box.end - box.body) % 4 !== 0) return false
  const brands = [fourcc(b, box.body)]
  for (let p = box.body + 8; p < box.end; p += 4) brands.push(fourcc(b, p))
  return !brands.includes(QUICKTIME_BRAND) && brands.some((x) => VIDEO_BRANDS.includes(x))
}

// mvhd or mdhd (versions 0 and 1) -> { timescale, duration } with duration
// UNKNOWN for all ones, or null.
function mediaTime (b, box) {
  const n = box.end - box.body
  if (n < 1) return null
  const version = b[box.body]
  let timescale, duration
  if (version === 0) {
    if (n < 20) return null
    timescale = be32(b, box.body + 12)
    duration = be32(b, box.body + 16)
    if (duration === 0xffffffff) duration = UNKNOWN
  } else if (version === 1) {
    if (n < 32) return null
    timescale = be32(b, box.body + 20)
    if (allOnes64(b, box.body + 24)) {
      duration = UNKNOWN
    } else {
      duration = be64(b, box.body + 24)
      if (duration < 0) return null
    }
  } else {
    return null
  }
  if (timescale < 1) return null
  return { timescale, duration }
}

// The entries of a full box that lists them after an entry_count (dref,
// stsd), or null when the count does not match what the box holds.
function entries (b, box, budget) {
  if (!box || box.end - box.body < 8) return null
  const list = children(b, box.body + 8, box.end, budget)
  return list && list.length >= 1 && list.length === be32(b, box.body + 4) ? list : null
}

// Every data reference must say "in this file": a 'url ' entry with the
// self-contained flag. A remote location would make a player fetch it.
function selfContained (b, dref, budget) {
  const list = entries(b, dref, budget)
  return list !== null && list.every((e) => e.type === 'url ' && e.end - e.body >= 4 && fullBoxFlags(b, e) === 1)
}

// stts -> { ticks, samples, deltas } (deltas: [count, delta] runs), or null
// when malformed, past cap or past max samples. A run of zero samples or of
// zero-length samples is refused.
function sttsTicks (b, stts, cap, max) {
  if (!stts || stts.end - stts.body < 8) return null
  const count = be32(b, stts.body + 4)
  if (count * 8 > stts.end - stts.body - 8) return null
  let ticks = 0
  let samples = 0
  const deltas = []
  for (let i = 0, p = stts.body + 8; i < count; i++, p += 8) {
    const n = be32(b, p)
    const delta = be32(b, p + 4)
    if (n === 0 || delta === 0 || n > max - samples || n > cap - ticks) return null
    samples += n
    ticks += n * delta
    if (ticks > cap) return null
    deltas.push([n, delta])
  }
  return { ticks, samples, deltas }
}

// stsz or stz2 -> { count, bytes, at(i) }: sample_count, the sum of the
// sample sizes and each one's size, or null when malformed, past max, when
// the sizes it announces do not fit its own bytes, when a sample has no
// bytes, or when the sizes add up to more than the file.
function sampleSizes (b, box, max) {
  if (box.end - box.body < 12) return null
  const n = box.end - box.body - 12
  const count = be32(b, box.body + 8)
  if (count > max) return null
  const p = box.body + 12
  let at
  if (box.type === 'stsz') {
    const size = be32(b, box.body + 4)
    if (size !== 0) {
      at = () => size
    } else {
      if (count * 4 > n) return null
      at = (i) => be32(b, p + i * 4)
    }
  } else {
    const field = b[box.body + 7]
    if (field !== 4 && field !== 8 && field !== 16) return null
    if (Math.ceil(count * field / 8) > n) return null
    at = field === 4
      ? (i) => (i % 2 === 0 ? b[p + (i >> 1)] >> 4 : b[p + (i >> 1)] & 0x0f)
      : field === 8 ? (i) => b[p + i] : (i) => be16(b, p + i * 2)
  }
  let bytes = 0
  for (let i = 0; i < count; i++) {
    const s = at(i)
    if (s < 1) return null
    bytes += s
    if (bytes > b.byteLength) return null
  }
  return { count, bytes, at }
}

// stsc walks every chunk of the stco or co64 (chunks entries) and lists as
// many samples as the sample size table: first_chunk starts at 1 and
// strictly increases, never past the last chunk, every entry names sample
// description 1 and at least one sample per chunk, and the last entry runs
// to the last chunk.
function chunksAgree (b, stsc, chunks, samples) {
  const count = be32(b, stsc.body + 4)
  let total = 0
  let first = 0
  let perChunk = 0
  for (let i = 0, p = stsc.body + 8; i < count; i++, p += 12) {
    const next = be32(b, p)
    const spc = be32(b, p + 4)
    if ((i === 0 ? next !== 1 : next <= first) || next > chunks || spc < 1 || be32(b, p + 8) !== 1) return false
    if (i > 0) total += perChunk * (next - first)
    if (total > samples) return false
    first = next
    perChunk = spc
  }
  if (count > 0) total += perChunk * (chunks - first + 1)
  return total === samples
}

// A table of entry_count entries of `size` bytes (stsc, stco, co64, stss)
// holds them in its own bytes and stays under max.
function tableFits (b, box, size, max) {
  if (box.end - box.body < 8) return false
  const count = be32(b, box.body + 4)
  return count <= max && count * size <= box.end - box.body - 8
}

// The byte range of every chunk, as [start, end) pairs, from stsc, the
// chunk offsets and the sample sizes (already found to agree), or null when
// one does not lie inside a top-level mdat payload.
function chunkRanges (b, stsc, offsets, sizes, mdats) {
  const chunks = be32(b, offsets.body + 4)
  const wide = offsets.type === 'co64'
  const runs = be32(b, stsc.body + 4)
  const out = []
  let sample = 0
  for (let r = 0; r < runs; r++) {
    const first = be32(b, stsc.body + 8 + r * 12)
    const spc = be32(b, stsc.body + 12 + r * 12)
    const last = r + 1 < runs ? be32(b, stsc.body + 8 + (r + 1) * 12) - 1 : chunks
    for (let c = first; c <= last; c++) {
      const start = wide ? be64(b, offsets.body + 8 + (c - 1) * 8) : be32(b, offsets.body + 8 + (c - 1) * 4)
      let end = start
      for (let k = 0; k < spc; k++) end += sizes.at(sample++)
      if (start < 0 || !inMdat(mdats, start, end)) return null
      out.push([start, end])
    }
  }
  return out
}

// [start, end) lies inside one mdat payload. mdats are top-level boxes, so in
// file order and apart: a binary search keeps thousands of tiny mdat boxes
// from making the chunk walk quadratic.
function inMdat (mdats, start, end) {
  let lo = 0
  let hi = mdats.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const m = mdats[mid]
    if (start < m.body) hi = mid - 1
    else if (start >= m.end) lo = mid + 1
    else return end <= m.end
  }
  return false
}

// The stbl boxes the walk lists but reads nothing from hold their own fields:
// sdtp one byte per sample, cslg its version's five fields, sbgp whole
// entries covering no more than the samples, sgpd its header and, in version
// 1, whole entries.
function sideTablesFit (b, inStbl, samples) {
  for (const x of inStbl) {
    const n = x.end - x.body
    const version = n >= 4 ? b[x.body] : -1
    if (x.type === 'sdtp') {
      if (version !== 0 || n - 4 !== samples) return false
    } else if (x.type === 'cslg') {
      if (!(version === 0 && n === 24) && !(version === 1 && n === 44)) return false
    } else if (x.type === 'sbgp') {
      const head = version === 0 ? 12 : version === 1 ? 16 : 0
      if (head === 0 || n < head) return false
      const count = be32(b, x.body + head - 4)
      if (count * 8 !== n - head) return false
      let total = 0
      for (let i = 0, p = x.body + head; i < count; i++, p += 8) {
        total += be32(b, p)
        if (total > samples) return false
      }
    } else if (x.type === 'sgpd') {
      const head = version === 0 ? 12 : version === 1 || version === 2 ? 16 : 0
      if (head === 0 || n < head) return false
      if (version === 1 && !groupEntriesFit(b, x, head)) return false
    }
  }
  return true
}

// A version 1 sgpd: entry_count entries of default_length bytes each, or,
// with default_length 0, each after its own 32-bit length, filling the box.
function groupEntriesFit (b, sgpd, head) {
  const size = be32(b, sgpd.body + 8)
  const count = be32(b, sgpd.body + 12)
  let p = sgpd.body + head
  if (size !== 0) return count * size === sgpd.end - p
  for (let i = 0; i < count; i++) {
    if (sgpd.end - p < 4) return false
    const n = be32(b, p)
    if (n > sgpd.end - p - 4) return false
    p += 4 + n
  }
  return p === sgpd.end
}

// The stbl of a track -> { stts, sizes, ranges } with ranges every chunk's
// bytes, or null when the tables disagree or a chunk lies outside mdat.
function sampleTables (b, inStbl, mdats, cap, max) {
  const run = sttsTicks(b, only(inStbl, 'stts'), cap, max)
  if (run === null || run.samples === 0 || !sideTablesFit(b, inStbl, run.samples)) return null
  const sizeBoxes = inStbl.filter((x) => x.type === 'stsz' || x.type === 'stz2')
  const sizes = sizeBoxes.length === 1 ? sampleSizes(b, sizeBoxes[0], max) : null
  if (sizes === null || sizes.count !== run.samples) return null
  const stsc = only(inStbl, 'stsc')
  const offsets = inStbl.filter((x) => x.type === 'stco' || x.type === 'co64')
  if (!stsc || offsets.length !== 1 || !tableFits(b, stsc, 12, max)) return null
  if (!tableFits(b, offsets[0], offsets[0].type === 'stco' ? 4 : 8, max)) return null
  if (!chunksAgree(b, stsc, be32(b, offsets[0].body + 4), sizes.count)) return null
  const ranges = chunkRanges(b, stsc, offsets[0], sizes, mdats)
  return ranges && { run, sizes, ranges }
}

// avcC: configurationVersion 1, an allowed profile, level at most
// MAX_AVC_LEVEL, four-byte NAL lengths, at least one SPS and one PPS, each
// inside the box. The decoder reads the SPS, not the avcC header, so each SPS
// must name an allowed profile and level too.
function avcConfig (b, avcC) {
  const end = avcC.end
  let p = avcC.body
  if (end - p < 7 || b[p] !== 1 || !AVC_PROFILES.includes(b[p + 1])) return false
  if (b[p + 3] < 1 || b[p + 3] > MAX_AVC_LEVEL || (b[p + 4] & 3) !== 3) return false
  const sps = b[p + 5] & 0x1f
  if (sps < 1) return false
  p += 6
  for (let i = 0; i < sps; i++) {
    if (p + 2 > end) return false
    const n = be16(b, p)
    p += 2
    if (n < 4 || p + n > end) return false
    if ((b[p] & 0x1f) !== 7 || !AVC_PROFILES.includes(b[p + 1]) || b[p + 3] < 1 || b[p + 3] > MAX_AVC_LEVEL) return false
    p += n
  }
  if (p >= end) return false
  const pps = b[p++]
  if (pps < 1) return false
  for (let i = 0; i < pps; i++) {
    if (p + 2 > end) return false
    const n = be16(b, p)
    p += 2
    if (n < 1 || p + n > end || (b[p] & 0x1f) !== 8) return false
    p += n
  }
  if (p === end) return true
  // High profile may add chroma_format, two bit depths and an SPS-ext
  // count. Only 4:2:0, 8 bits and no SPS-ext; reserved bits vary by encoder.
  if (b[avcC.body + 1] !== 100 || end - p !== 4) return false
  return (b[p] & 3) === 1 && (b[p + 1] & 7) === 0 && (b[p + 2] & 7) === 0 && b[p + 3] === 0
}

// An avc1 VisualSampleEntry with one valid avcC, square pixels, a clean
// aperture (if any) inside the coded picture and only listed children, coded
// size within bounds -> true.
function avcEntry (b, entry, budget) {
  if (entry.type !== 'avc1' || entry.end - entry.body < VISUAL_ENTRY) return false
  if (be16(b, entry.body + 6) !== 1) return false
  const w = be16(b, entry.body + 24)
  const h = be16(b, entry.body + 26)
  if (!sizeFits(w, h)) return false
  const list = listed(b, entry.body + VISUAL_ENTRY, entry.end, budget)
  if (!list || list.some((x) => x.type !== 'avcC' && !AVC_EXTRAS.includes(x.type))) return false
  for (const type of ['pasp', 'colr', 'btrt', 'clap', 'fiel', 'chrm']) if (!atMostOne(list, type)) return false
  const pasp = list.find((x) => x.type === 'pasp')
  if (pasp && (pasp.end - pasp.body < 8 || be32(b, pasp.body) < 1 || be32(b, pasp.body) !== be32(b, pasp.body + 4))) return false
  const clap = list.find((x) => x.type === 'clap')
  if (clap && (clap.end - clap.body < 32 || !apertureFits(b, clap.body, w) || !apertureFits(b, clap.body + 8, h))) return false
  const colr = list.find((x) => x.type === 'colr')
  if (colr && (colr.end - colr.body !== COLR_NCLX_BYTES || fourcc(b, colr.body) !== 'nclx')) return false
  const avcC = only(list, 'avcC')
  return Boolean(avcC) && avcConfig(b, avcC)
}

// One side of a clap at p: its size N/D (at p) and its signed centre offset
// N/D (at p + 16) keep the clean aperture inside a coded side of `coded`:
// 0 < size <= coded and 2 * |offset| + size <= coded. BigInt, because the
// cross products of four 32-bit values pass 2^53.
function apertureFits (b, p, coded) {
  const n = be32(b, p)
  const d = be32(b, p + 4)
  const offD = be32(b, p + 20)
  if (d < 1 || offD < 1 || n < 1 || n > coded * d) return false
  const off = BigInt(Math.abs(s32(b, p + 16)))
  return 2n * off * BigInt(d) + BigInt(n) * BigInt(offD) <= BigInt(coded) * BigInt(d) * BigInt(offD)
}

function sizeFits (w, h) {
  return w >= 1 && h >= 1 && w <= MAX_VIDEO_DIMENSION && h <= MAX_VIDEO_DIMENSION && w * h <= MAX_VIDEO_PIXELS
}

// A descriptor's length (one to four bytes of seven bits) at p ->
// { at, end } of its payload, or null when it runs past limit.
function descriptor (b, p, limit) {
  let len = 0
  for (let i = 0; i < 4; i++) {
    if (p >= limit) return null
    const v = b[p++]
    len = len * 128 + (v & 0x7f)
    if ((v & 0x80) === 0) return p + len <= limit ? { at: p, end: p + len } : null
  }
  return null
}

// esds -> its ES_Descriptor's DecoderConfigDescriptor names an AAC object
// type in an audio stream, with a small DecoderSpecificInfo inside it whose
// AudioSpecificConfig names AAC-LC, SBR or PS (its first five bits).
function aacConfig (b, esds) {
  if (esds.end - esds.body < 5 || b[esds.body + 4] !== 0x03) return false
  const es = descriptor(b, esds.body + 5, esds.end)
  if (!es || es.end - es.at < 3) return false
  const f = b[es.at + 2]
  let p = es.at + 3
  // A URL flag says the stream lives at that URL, not in this file.
  if (f & 0x40) return false
  if (f & 0x80) p += 2
  if (f & 0x20) p += 2
  if (p >= es.end || b[p] !== 0x04) return false
  const dc = descriptor(b, p + 1, es.end)
  if (!dc || dc.end - dc.at < 13) return false
  if (!AAC_OBJECT_TYPES.includes(b[dc.at]) || (b[dc.at + 1] >> 2) !== AUDIO_STREAM) return false
  const q = dc.at + 13
  if (q >= dc.end || b[q] !== 0x05) return false
  const dsi = descriptor(b, q + 1, dc.end)
  if (!dsi || dsi.end - dsi.at < 2 || dsi.end - dsi.at > MAX_DECODER_CONFIG) return false
  return AAC_AUDIO_TYPES.includes(b[dsi.at] >> 3)
}

// An mp4a AudioSampleEntry (version 0) with exactly one AAC esds and only
// the children CHILDREN.mp4a lists.
function aacEntry (b, entry, budget) {
  if (entry.type !== 'mp4a' || entry.end - entry.body < AUDIO_ENTRY) return false
  if (be16(b, entry.body + 6) !== 1 || b[entry.body + 8] !== 0 || b[entry.body + 9] !== 0) return false
  const list = listed(b, entry.body + AUDIO_ENTRY, entry.end, budget, CHILDREN.mp4a)
  const esds = list && only(list, 'esds')
  return Boolean(esds) && aacConfig(b, esds)
}

// tkhd (versions 0 and 1) -> duration in the movie timescale, UNKNOWN for
// all ones or when there is no tkhd, or null when malformed.
function tkhdDuration (b, tkhd) {
  if (!tkhd) return UNKNOWN
  if (tkhd.end - tkhd.body < 1) return null
  const version = b[tkhd.body]
  if (version === 0) {
    if (tkhd.end - tkhd.body < 24) return null
    const d = be32(b, tkhd.body + 20)
    return d === 0xffffffff ? UNKNOWN : d
  }
  if (version !== 1 || tkhd.end - tkhd.body < 36) return null
  if (allOnes64(b, tkhd.body + 28)) return UNKNOWN
  const d = be64(b, tkhd.body + 28)
  return d < 0 ? null : d
}

// tkhd -> the display { width, height }: its size turned by its matrix,
// which may only be a rotation by 0, 90, 180 or 270 degrees (a player
// applies any other transform, a skew or a scale to a huge size), or null.
function displaySize (b, tkhd) {
  const version = b[tkhd.body]
  const m = tkhd.body + (version === 0 ? 40 : 52)
  if ((version !== 0 && version !== 1) || tkhd.end - m < 44) return null
  const a = s32(b, m)
  const bb = s32(b, m + 4)
  const c = s32(b, m + 12)
  const d = s32(b, m + 16)
  if (s32(b, m + 8) !== 0 || s32(b, m + 20) !== 0 || s32(b, m + 32) !== 0x40000000) return null
  const straight = bb === 0 && c === 0 && ((a === ONE && d === ONE) || (a === -ONE && d === -ONE))
  const turned = a === 0 && d === 0 && ((bb === ONE && c === -ONE) || (bb === -ONE && c === ONE))
  if (!straight && !turned) return null
  const w = Math.round(be32(b, m + 36) / ONE)
  const h = Math.round(be32(b, m + 40) / ONE)
  return turned ? { width: h, height: w } : { width: w, height: h }
}

// A header duration agrees with the samples' ms when it is not given (0 or
// all ones), within VIDEO_MS_TOLERANCE of it, or the file is the sender's
// own (stripVideoMetadata rewrites it).
function headerAgrees (budget, duration, timescale, ms) {
  return budget.metadata || duration === 0 || duration === UNKNOWN || Math.abs(toMs(duration, timescale) - ms) <= VIDEO_MS_TOLERANCE
}

// elst (versions 0 and 1) agrees with ms of samples: one or two entries, an
// empty edit (media_time -1) only first and at most VIDEO_MS_TOLERANCE long,
// at most one media edit at media_time >= 0 and rate exactly 1, and segment
// durations (movie timescale) summing to within VIDEO_MS_TOLERANCE of ms. A
// media edit of duration 0 plays the whole media. -> the media edit's
// media_time (0 without one), or -1 when it does not agree.
function editList (b, elst, timescale, ms) {
  const n = elst.end - elst.body
  if (n < 8) return -1
  const version = b[elst.body]
  const size = version === 0 ? 12 : version === 1 ? 20 : 0
  const count = be32(b, elst.body + 4)
  if (size === 0 || count < 1 || count > 2 || count * size > n - 8) return -1
  let total = 0
  let media = 0
  let start = 0
  let whole = false
  for (let i = 0, p = elst.body + 8; i < count; i++, p += size) {
    let segment, time
    if (version === 0) {
      segment = be32(b, p)
      const t = be32(b, p + 4)
      time = t === 0xffffffff ? -1 : t >= 0x80000000 ? -2 : t
    } else {
      segment = be64(b, p)
      time = allOnes64(b, p + 8) ? -1 : be64(b, p + 8)
      if (time === -1 && !allOnes64(b, p + 8)) time = -2
    }
    if (segment < 0) return -1
    const rate = p + size - 4
    if (time === -1) {
      if (i !== 0 || toMs(segment, timescale) > VIDEO_MS_TOLERANCE) return -1
      total += segment
    } else if (time >= 0) {
      if (++media > 1) return -1
      if (b[rate] !== 0 || b[rate + 1] !== 1 || b[rate + 2] !== 0 || b[rate + 3] !== 0) return -1
      start = time
      if (segment === 0) whole = true
      else total += segment
    } else {
      return -1
    }
  }
  return whole || Math.abs(toMs(total, timescale) - ms) <= VIDEO_MS_TOLERANCE ? start : -1
}

// A track's tkhd duration and edit list, both in the movie timescale, agree
// with ms of its samples. -> the edit's media_time, or -1.
function trackAgrees (b, inTrak, tkhd, movie, ms, budget) {
  const d = tkhdDuration(b, tkhd)
  if (d === null || !headerAgrees(budget, d, movie.timescale, ms)) return -1
  const edts = inTrak.filter((x) => x.type === 'edts')
  if (edts.length === 0) return 0
  if (edts.length > 1) return -1
  const inEdts = inside(b, edts[0], budget, CHILDREN.edts)
  const elst = inEdts && only(inEdts, 'elst')
  return elst ? editList(b, elst, movie.timescale, ms) : -1
}

// Every sample's presentation time (its decode time from stts, plus its
// ctts offset, minus the edit's media_time) lies in 0..ticks + tolerance,
// and so does its end (that time plus its own stts delta). Profiles 77 and
// 100 reorder frames (B-frames), so the video track may carry a ctts; an
// offset could otherwise move a sample hours away from where stts puts it.
function presentationFits (b, ctts, run, timescale, start) {
  const last = run.ticks + Math.round(VIDEO_MS_TOLERANCE * timescale / 1000)
  const decode = []
  const lengths = []
  let t = 0
  for (const [n, delta] of run.deltas) {
    for (let i = 0; i < n; i++, t += delta) {
      decode.push(t)
      lengths.push(delta)
    }
  }
  const offsets = new Array(decode.length).fill(0)
  if (ctts) {
    if (ctts.end - ctts.body < 8) return false
    const version = b[ctts.body]
    const count = be32(b, ctts.body + 4)
    if ((version !== 0 && version !== 1) || count * 8 > ctts.end - ctts.body - 8) return false
    let i = 0
    for (let k = 0, p = ctts.body + 8; k < count; k++, p += 8) {
      const n = be32(b, p)
      const off = version === 0 ? be32(b, p + 4) : s32(b, p + 4)
      if (n === 0 || n > decode.length - i) return false
      for (let j = 0; j < n; j++) offsets[i++] = off
    }
    if (i !== decode.length) return false
  }
  for (let i = 0; i < decode.length; i++) {
    const pt = decode[i] + offsets[i] - start
    if (pt < 0 || pt + lengths[i] > last) return false
  }
  return true
}

// stss: sync sample numbers within the samples, no more of them than samples.
function syncFits (b, stss, samples) {
  if (!tableFits(b, stss, 4, samples)) return false
  const count = be32(b, stss.body + 4)
  for (let i = 0, p = stss.body + 8; i < count; i++, p += 4) {
    const n = be32(b, p)
    if (n < 1 || n > samples) return false
  }
  return true
}

// trak -> { handler, inTrak, inStbl, tkhd, media, timescale } for a track
// with exactly one 'vide' or 'soun' handler, media header, self-contained
// dref and one sample description list, or null.
function trackParts (b, trak, budget) {
  const inTrak = inside(b, trak, budget, CHILDREN.trak)
  if (!inTrak || !atMostOne(inTrak, 'tkhd')) return null
  const mdia = only(inTrak, 'mdia')
  const inMdia = mdia && inside(b, mdia, budget, CHILDREN.mdia)
  const hdlr = inMdia && only(inMdia, 'hdlr')
  if (!hdlr || hdlr.end - hdlr.body < 12) return null
  const handler = fourcc(b, hdlr.body + 8)
  if (handler !== 'vide' && handler !== 'soun') return null
  const mdhd = only(inMdia, 'mdhd')
  const media = mdhd && mediaTime(b, mdhd)
  const minf = only(inMdia, 'minf')
  const inMinf = media && minf && inside(b, minf, budget, MINF[handler])
  if (!inMinf) return null
  const dinf = only(inMinf, 'dinf')
  const inDinf = dinf && inside(b, dinf, budget, CHILDREN.dinf)
  if (!inDinf || !selfContained(b, only(inDinf, 'dref'), budget)) return null
  const stbl = only(inMinf, 'stbl')
  const inStbl = stbl && inside(b, stbl, budget, CHILDREN.stbl)
  if (!inStbl) return null
  const sampleEntries = entries(b, only(inStbl, 'stsd'), budget)
  if (!sampleEntries || sampleEntries.length !== 1) return null
  return { handler, trak, inTrak, inMinf, inStbl, entry: sampleEntries[0], tkhd: inTrak.find((x) => x.type === 'tkhd'), media }
}

function videoTrack (b, parts, movie, mdats, maxMs, budget) {
  const { inTrak, inMinf, inStbl, entry, tkhd, media } = parts
  if (!only(inMinf, 'vmhd') || inMinf.some((x) => x.type === 'smhd')) return null
  if (!tkhd || !avcEntry(b, entry, budget)) return null
  const size = displaySize(b, tkhd)
  if (!size || !sizeFits(size.width, size.height)) return null
  const tables = sampleTables(b, inStbl, mdats, media.timescale * (maxMs / 1000 + 1), MAX_VIDEO_SAMPLES)
  if (!tables) return null
  const ms = toMs(tables.run.ticks, media.timescale)
  if (ms < 1 || ms > maxMs || !headerAgrees(budget, media.duration, media.timescale, ms)) return null
  const start = trackAgrees(b, inTrak, tkhd, movie, ms, budget)
  if (start < 0) return null
  if (!atMostOne(inStbl, 'ctts') || !atMostOne(inStbl, 'stss')) return null
  const stss = inStbl.find((x) => x.type === 'stss')
  if (stss && !syncFits(b, stss, tables.run.samples)) return null
  if (!presentationFits(b, inStbl.find((x) => x.type === 'ctts'), tables.run, media.timescale, start)) return null
  return { ms, ticks: tables.run.ticks, ranges: tables.ranges, size }
}

function soundTrack (b, parts, movie, mdats, maxMs, budget) {
  const { inTrak, inMinf, inStbl, entry, tkhd, media } = parts
  if (inMinf.some((x) => x.type === 'vmhd') || !aacEntry(b, entry, budget)) return null
  // AAC has no composition offsets: a ctts could only move samples away from
  // where stts puts them.
  if (inStbl.some((x) => x.type === 'ctts')) return null
  const tables = sampleTables(b, inStbl, mdats, media.timescale * ((maxMs + VIDEO_MS_TOLERANCE) / 1000 + 1), MAX_SOUND_SAMPLES)
  if (!tables) return null
  const ms = toMs(tables.run.ticks, media.timescale)
  if (ms < 1 || !headerAgrees(budget, media.duration, media.timescale, ms)) return null
  // The edit must start inside the samples (an AAC priming offset such as 2112);
  // a whole-media edit skips the duration check, so this is the only bound.
  const start = trackAgrees(b, inTrak, tkhd, movie, ms, budget)
  if (start < 0 || start >= tables.run.ticks) return null
  if (!atMostOne(inStbl, 'stss')) return null
  const stss = inStbl.find((x) => x.type === 'stss')
  if (stss && !syncFits(b, stss, tables.run.samples)) return null
  return { ms, ticks: tables.run.ticks, ranges: tables.ranges }
}

// -> { ms, width, height, audio, top, tracks, movie, ranges } or null.
// tracks: [{ trak, ticks, timescale, handler }] in moov order. strip is set
// only by stripVideoMetadata (with metadata): see listed.
function parse (bytes, metadata, maxMs, strip = false) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) return null
  if (!Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > MAX_VIDEO_MS) return null
  const budget = { n: 0, metadata, strip }
  const top = listed(bytes, 0, bytes.byteLength, budget)
  if (!top || top.length < 2 || top[0].type !== 'ftyp' || !videoBrand(bytes, top[0])) return null
  if (top.some((x) => !TOP_LEVEL.includes(x.type)) || !atMostOne(top, 'ftyp')) return null
  const mdats = top.filter((x) => x.type === 'mdat')
  const moov = only(top, 'moov')
  const inMoov = moov && inside(bytes, moov, budget, CHILDREN.moov)
  const mvhd = inMoov && only(inMoov, 'mvhd')
  const movie = mvhd && mediaTime(bytes, mvhd)
  if (!movie) return null
  const traks = inMoov.filter((x) => x.type === 'trak')
  if (traks.length < 1 || traks.length > 2) return null
  const parts = traks.map((trak) => trackParts(bytes, trak, budget))
  if (parts.some((x) => x === null)) return null
  const videos = parts.filter((x) => x.handler === 'vide')
  const sounds = parts.filter((x) => x.handler === 'soun')
  if (videos.length !== 1 || videos.length + sounds.length !== parts.length) return null
  const video = videoTrack(bytes, videos[0], movie, mdats, maxMs, budget)
  if (!video || !headerAgrees(budget, movie.duration, movie.timescale, video.ms)) return null
  const sound = sounds.length === 1 ? soundTrack(bytes, sounds[0], movie, mdats, maxMs, budget) : null
  if (sounds.length === 1 && (!sound || sound.ms > video.ms + VIDEO_MS_TOLERANCE)) return null
  const tracks = parts.map((p) => ({ trak: p.trak, ticks: p === videos[0] ? video.ticks : sound.ticks, timescale: p.media.timescale, handler: p.handler }))
  return {
    ms: video.ms,
    width: video.size.width,
    height: video.size.height,
    audio: sound !== null,
    top,
    movie,
    video: tracks[parts.indexOf(videos[0])],
    tracks,
    ranges: sound ? video.ranges.concat(sound.ranges) : video.ranges
  }
}

// -> { ms, width, height, audio } or null. opts.maxMs (default
// MAX_VIDEO_MS, never above it) caps the duration; { metadata: true } is for
// the sender's own file, before stripVideoMetadata, and nowhere else.
function videoBounds (bytes, opts) {
  try {
    const maxMs = opts != null && opts.maxMs !== undefined ? opts.maxMs : MAX_VIDEO_MS
    const parsed = parse(bytes, opts != null && opts.metadata === true, maxMs)
    return parsed && { ms: parsed.ms, width: parsed.width, height: parsed.height, audio: parsed.audio }
  } catch {
    return null
  }
}

const TIMED = Object.freeze(['mvhd', 'tkhd', 'mdhd'])
// Where the duration of each header sits in its body: [version 0, version 1].
const DURATION_AT = Object.freeze({ mvhd: [16, 24], mdhd: [16, 24], tkhd: [20, 28] })
const CONTAINERS = Object.freeze(['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl', 'edts'])
const FILLER = Object.freeze(['free', 'skip', 'wide'])
// The 32-byte compressorname of a VisualSampleEntry.
const COMPRESSOR_AT = 42

// Zeroes creation_time and modification_time of mvhd, tkhd or mdhd.
function zeroTimes (b, box) {
  const n = box.end - box.body
  const version = b[box.body]
  if (version === 0 && n >= 12) b.fill(0, box.body + 4, box.body + 12)
  else if (version === 1 && n >= 20) b.fill(0, box.body + 4, box.body + 20)
}

function putBe32 (b, p, v) {
  b[p] = (v >>> 24) & 0xff
  b[p + 1] = (v >>> 16) & 0xff
  b[p + 2] = (v >>> 8) & 0xff
  b[p + 3] = v & 0xff
}

// Sets the duration of mvhd, tkhd or mdhd to value. A duration not given (0
// or all ones) stays so. false when the box is malformed or the value does
// not fit a version 0 field.
function setDuration (b, box, value) {
  if (box.end - box.body < 1) return false
  const version = b[box.body]
  if (version !== 0 && version !== 1) return false
  const p = box.body + DURATION_AT[box.type][version]
  if (p + (version === 0 ? 4 : 8) > box.end) return false
  if (version === 0) {
    const d = be32(b, p)
    if (d === 0 || d === 0xffffffff) return true
    if (value > 0xfffffffe) return false
    putBe32(b, p, value)
    return true
  }
  if ((be32(b, p) === 0 && be32(b, p + 4) === 0) || allOnes64(b, p)) return true
  putBe32(b, p, Math.floor(value / 0x100000000))
  putBe32(b, p + 4, value % 0x100000000)
  return true
}

// The CHILDREN list of a walked container, by its type and, for minf, its
// track's handler.
function childRule (type, ctx) {
  return type === 'minf' ? (ctx.track ? MINF[ctx.track.handler] : undefined) : CHILDREN[type]
}

// ctx: { parsed, track } with track the current trak's { ticks, timescale,
// handler }. allow: the CHILDREN list of the container boxes sit in, or null
// at the top level and in the avc1 entry, whose lists parse already holds
// them to.
function stripBoxes (b, boxes, budget, ctx, allow) {
  for (const x of boxes) {
    if (METADATA.includes(x.type) || (allow && !allowed(allow, x.type))) {
      // Same size, so every chunk offset still holds.
      b.set([0x66, 0x72, 0x65, 0x65], x.start + 4)
      b.fill(0, x.body, x.end)
    } else if (FILLER.includes(x.type)) {
      b.fill(0, x.body, x.end)
    } else if (TIMED.includes(x.type)) {
      zeroTimes(b, x)
      const { movie, video } = ctx.parsed
      const track = x.type === 'mvhd' ? video : ctx.track
      if (!track) return false
      const value = x.type === 'mdhd' ? track.ticks : Math.round(track.ticks / track.timescale * movie.timescale)
      if (!setDuration(b, x, value)) return false
    } else if (x.type === 'hdlr') {
      if (x.end - x.body > 24) b.fill(0, x.body + 24, x.end)
    } else if (x.type === 'stsd') {
      const list = x.end - x.body >= 8 ? children(b, x.body + 8, x.end, budget) : null
      if (!list) return false
      for (const entry of list) {
        const at = entry.type === 'avc1' ? VISUAL_ENTRY : entry.type === 'mp4a' ? AUDIO_ENTRY : -1
        if (at < 0 || entry.end - entry.body < at) return false
        if (entry.type === 'avc1') b.fill(0, entry.body + COMPRESSOR_AT, entry.body + COMPRESSOR_AT + 32)
        const inner = children(b, entry.body + at, entry.end, budget)
        if (!inner || !stripBoxes(b, inner, budget, ctx, entry.type === 'mp4a' ? CHILDREN.mp4a : null)) return false
      }
    } else if (CONTAINERS.includes(x.type)) {
      const inner = children(b, x.body, x.end, budget)
      if (!inner) return false
      const next = x.type === 'trak' ? { ...ctx, track: ctx.parsed.tracks.find((t) => t.trak.start === x.start) } : ctx
      if (x.type === 'trak' && !next.track) return false
      const list = childRule(x.type, next)
      if (!list || !stripBoxes(b, inner, budget, next, list)) return false
    }
  }
  return true
}

// Zeroes every byte of each top-level mdat payload that no sample covers.
// Every range lies inside one mdat (parse checked it) and both lists are in
// file order, so one pass over each does it.
function zeroUncovered (b, top, ranges) {
  const sorted = ranges.slice().sort((x, y) => x[0] - y[0])
  let i = 0
  for (const m of top) {
    if (m.type !== 'mdat') continue
    let p = m.body
    for (; i < sorted.length && sorted[i][0] < m.end; i++) {
      const [start, end] = sorted[i]
      if (start > p) b.fill(0, p, start)
      p = Math.max(p, end)
    }
    if (p < m.end) b.fill(0, p, m.end)
  }
}

// A video without its recording time, place or device tags: a copy of bytes
// with udta, meta and uuid boxes turned into zero-filled free boxes of the
// same size, free, skip and wide payloads zeroed, creation and modification
// times zeroed, header durations rewritten from the samples, handler names
// and the avc1 compressorname zeroed, and every mdat byte no sample covers
// zeroed. Sizes and offsets never move. A child of a walked container (or of
// the mp4a entry) that CHILDREN does not list for it is left unparsed and
// becomes a zero-filled free box of the same size too, whatever its type:
// only listed boxes are kept. null when the bytes fail videoBounds with
// { metadata: true } for any other reason (refused boxes, counts, bounds),
// or when the copy fails the strict videoBounds. Never mutates bytes, never
// throws.
function stripVideoMetadata (bytes) {
  try {
    const parsed = parse(bytes, true, MAX_VIDEO_MS, true)
    if (parsed === null) return null
    const out = new Uint8Array(bytes.byteLength)
    out.set(bytes)
    const budget = { n: 0 }
    const top = children(out, 0, out.byteLength, budget)
    if (!top || !stripBoxes(out, top, budget, { parsed, track: null }, null)) return null
    zeroUncovered(out, parsed.top, parsed.ranges)
    return parse(out, false, MAX_VIDEO_MS) === null ? null : out
  } catch {
    return null
  }
}

module.exports = {
  videoBounds,
  stripVideoMetadata,
  MAX_VIDEO_MS,
  MAX_MOMENT_VIDEO_MS,
  VIDEO_MS_TOLERANCE,
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_PIXELS,
  MAX_VIDEO_SAMPLES,
  VIDEO_BRANDS
}
