'use strict'

// Reads the duration of a voice note (an MPEG-4 audio file, audio/mp4) from
// its ISO BMFF boxes, and refuses a file that is not audio only: the mime a
// peer declares is not trusted, and an .mp4 with a video track would reach a
// player that decodes video. The duration is the samples' (stts, trun), not
// a header's: a player plays every sample. Samples are never decoded.
// Anything truncated, malformed, over a bound, without a sound track, with
// any other track (exactly one sound track), or a data reference outside
// the file is null. Never throws. Works on Uint8Array only, with no Node
// built-ins, so the app bundle can use it.
//
// The top level, every container the walk visits and the sample entry may
// hold only the child boxes CHILDREN lists for them, each no more often than
// listed: a box the check does not read could still be read by a player (a
// second trak nested anywhere, a dac3 beside the checked esds that Media3
// decodes instead of it).
//
// A received note carries no metadata: a udta or meta box anywhere the walk
// goes is refused (a player parses their contents, and Media3 loops forever
// on a zero-size ilst entry), and so is any uuid box. Only the sender, about
// to strip its own recording, passes { metadata: true }: udta, meta and any
// child CHILDREN does not list are then skipped, never parsed (the strip
// blanks them), and header durations are not compared, since
// stripAudioMetadata rewrites them from the samples (recorders write them
// wrong: Chrome's mdhd).

const MAX_AUDIO_MS = 120000
// How far a voice note's declared ms may be from its container's duration:
// recorders round MPEG-4 durations, so a writer and a reader may differ by a
// little, never by more than this.
const AUDIO_MS_TOLERANCE = 1000
// Boxes walked before giving up; every step also advances, so the walk ends
// on any input regardless. A fragmented recording (browser MediaRecorder)
// spends about seven boxes per fragment, and a recorder asked for a fragment
// every 100 ms writes 1200 of them in two minutes, so 1024 would refuse real
// files. Each box costs at least 8 bytes, so the walk stays linear in size.
const MAX_BOXES = 16384
// The brand says little (the tracks decide: only 'soun' passes); the ISO
// base media brands iso3..iso9 are listed because browser recorders may write
// only those for a fragmented file.
const AUDIO_BRANDS = Object.freeze(['M4A ', 'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'dash'])
// Sample entries a sound track may carry: AAC and Opus. Anything else (a
// video entry behind a 'soun' handler) is refused.
const AUDIO_ENTRIES = Object.freeze(['mp4a', 'Opus'])
// Samples a track may list, in moov and fragments together. AAC at 48 kHz is
// about 47 frames a second and Opus 50, so 120 s is about 6000: the margin
// is wide, and a tiny file still cannot declare billions of samples for a
// recipient's demuxer to walk or allocate.
const MAX_SAMPLES = 20000
const UNKNOWN = -1
// MPEG-4 audio object types an esds may name: MPEG-4 AAC, and MPEG-2 AAC
// Main, LC and SSR.
const AAC_OBJECT_TYPES = Object.freeze([0x40, 0x66, 0x67, 0x68])
const AUDIO_STREAM = 0x05
// An AAC AudioSpecificConfig is a few bytes; 64 leaves room for extensions.
const MAX_DECODER_CONFIG = 64
const MANY = Infinity
// The child boxes the top level, each walked container and each sample entry
// may hold, with how many of each. free and skip may sit anywhere: the
// sender's strip turns udta, meta and any unlisted child into same-size free
// boxes, and its output must pass this check. Apple's AudioToolbox writer
// (afconvert, and AVAudioRecorder for .m4a) puts an sbtd in its mp4a entry;
// no player we ship reads it.
const FILL = { free: MANY, skip: MANY }
const rule = (list) => Object.freeze(Object.assign(Object.create(null), FILL, list))
const CHILDREN = Object.freeze({
  top: rule({ ftyp: 1, moov: 1, mdat: MANY, moof: MANY, wide: MANY }),
  moov: rule({ mvhd: 1, trak: 1, mvex: 1 }),
  trak: rule({ tkhd: 1, edts: 1, mdia: 1 }),
  edts: rule({ elst: 1 }),
  mdia: rule({ mdhd: 1, hdlr: 1, minf: 1 }),
  minf: rule({ smhd: 1, dinf: 1, stbl: 1 }),
  dinf: rule({ dref: 1 }),
  stbl: rule({ stsd: 1, stts: 1, stsc: 1, stsz: 1, stz2: 1, stco: 1, co64: 1, sgpd: MANY, sbgp: MANY }),
  mvex: rule({ mehd: 1, trex: 1 }),
  moof: rule({ mfhd: 1, traf: MANY }),
  traf: rule({ tfhd: 1, tfdt: 1, trun: MANY }),
  mp4a: rule({ esds: 1, btrt: 1, sbtd: 1 }),
  Opus: rule({ dOps: 1, btrt: 1 })
})
// A sample group of this type marks samples as encrypted (Common Encryption).
const ENCRYPTION_GROUP = 'seig'

function be32 (b, p) {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
}

// A 64-bit value, or -1 when it is not a safe integer.
function be64 (b, p) {
  const hi = be32(b, p)
  if (hi > 0x1fffff) return -1
  return hi * 0x100000000 + be32(b, p + 4)
}

function fourcc (b, p) {
  return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3])
}

// The child boxes of b[start, end) as { type, start, body, end }, or null when a
// size does not fit its parent or the walk runs over the budget.
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

// The children of b[start, end), or null when malformed, when one is a uuid
// box, or when one is not on allow (a CHILDREN list) or is on it more often
// than it allows. On the sender's file (budget.metadata) a child not on
// allow, udta and meta among them, is kept unparsed instead of refused: the
// strip blanks it, and the explicit refusals (ctts, vmhd, sidx) still see it.
function listed (b, start, end, budget, allow) {
  const list = children(b, start, end, budget)
  if (!list || !clean(list, budget)) return null
  const seen = Object.create(null)
  for (const x of list) {
    if (!allowed(allow, x.type)) {
      if (budget.metadata) continue
      return null
    }
    seen[x.type] = (seen[x.type] || 0) + 1
    if (seen[x.type] > allow[x.type]) return null
  }
  return list
}

function inside (b, box, budget, allow) {
  return listed(b, box.body, box.end, budget, allow)
}

function allowed (allow, type) {
  return Object.prototype.hasOwnProperty.call(allow, type)
}

function clean (list, budget) {
  return !list.some((x) => x.type === 'uuid' || (!budget.metadata && (x.type === 'udta' || x.type === 'meta')))
}

function only (boxes, type) {
  const found = boxes.filter((x) => x.type === type)
  return found.length === 1 ? found[0] : null
}

function audioBrand (b, box) {
  if (box.end - box.body < 8 || (box.end - box.body) % 4 !== 0) return false
  if (AUDIO_BRANDS.includes(fourcc(b, box.body))) return true
  for (let p = box.body + 8; p < box.end; p += 4) {
    if (AUDIO_BRANDS.includes(fourcc(b, p))) return true
  }
  return false
}

// mvhd or mdhd (versions 0 and 1, same layout up to the duration) ->
// { timescale, duration } with duration UNKNOWN for all ones, or null.
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

function allOnes64 (b, p) {
  return be32(b, p) === 0xffffffff && be32(b, p + 4) === 0xffffffff
}

function toMs (ticks, timescale) {
  return Math.round(ticks * 1000 / timescale)
}

function fullBoxFlags (b, box) {
  return (b[box.body + 1] << 16) | (b[box.body + 2] << 8) | b[box.body + 3]
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

// stts -> { ticks, samples }: the sum of sample_count * sample_delta and of
// sample_count, or null when malformed, past cap or past MAX_SAMPLES. A run
// of zero samples or of zero-length samples is refused: only the product
// would be bounded, and a player still walks every sample. The walk is
// bounded by the box's own bytes.
function sttsTicks (b, stts, cap) {
  if (!stts || stts.end - stts.body < 8) return null
  const count = be32(b, stts.body + 4)
  if (count * 8 > stts.end - stts.body - 8) return null
  let ticks = 0
  let samples = 0
  for (let i = 0, p = stts.body + 8; i < count; i++, p += 8) {
    const n = be32(b, p)
    const delta = be32(b, p + 4)
    if (n === 0 || delta === 0 || n > MAX_SAMPLES - samples || n > cap - ticks) return null
    samples += n
    ticks += n * delta
    if (ticks > cap) return null
  }
  return { ticks, samples }
}

// stsz or stz2 -> { count, bytes }: sample_count and the sum of the sample
// sizes, or null when malformed, past MAX_SAMPLES, when the per-sample sizes
// it announces do not fit its own bytes, when a sample has no bytes, or when
// the sizes add up to more than the file. A player sizes its per-sample
// arrays from this count, so a 12-byte box with a constant sample size could
// otherwise claim billions of samples, and its codec input buffers from the
// largest size.
function sampleSizes (b, box) {
  if (box.end - box.body < 12) return null
  const n = box.end - box.body - 12
  const count = be32(b, box.body + 8)
  if (count > MAX_SAMPLES) return null
  const p = box.body + 12
  let bytes = 0
  if (box.type === 'stsz') {
    const size = be32(b, box.body + 4)
    if (size !== 0) {
      bytes = size * count
    } else {
      if (count * 4 > n) return null
      for (let i = 0; i < count; i++) {
        const s = be32(b, p + i * 4)
        if (s < 1) return null
        bytes += s
        if (bytes > b.byteLength) return null
      }
    }
  } else {
    const field = b[box.body + 7]
    if (field !== 4 && field !== 8 && field !== 16) return null
    if (Math.ceil(count * field / 8) > n) return null
    for (let i = 0; i < count; i++) {
      const s = field === 4
        ? (i % 2 === 0 ? b[p + (i >> 1)] >> 4 : b[p + (i >> 1)] & 0x0f)
        : field === 8 ? b[p + i] : (b[p + i * 2] << 8) | b[p + i * 2 + 1]
      if (s < 1) return null
      bytes += s
    }
  }
  return bytes <= b.byteLength ? { count, bytes } : null
}

// stsc walks every chunk of the stco or co64 (chunks entries) and lists as
// many samples as the sample size table: first_chunk starts at 1 and
// strictly increases, never past the last chunk, every entry names sample
// description 1 and at least one sample per chunk, and the last entry runs
// to the last chunk. A demuxer allocates its index from samples_per_chunk.
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

// An AudioSampleEntry (version 0) with exactly one decoder configuration:
// an esds naming AAC for 'mp4a', a dOps for 'Opus'.
function audioEntry (b, entry, budget) {
  if (!AUDIO_ENTRIES.includes(entry.type) || entry.end - entry.body < 28) return false
  if (b[entry.body + 8] !== 0 || b[entry.body + 9] !== 0) return false
  // Only listed children: a second decoder configuration would replace the
  // one checked here.
  const list = listed(b, entry.body + 28, entry.end, budget, CHILDREN[entry.type])
  if (!list) return false
  if (entry.type === 'Opus') {
    const dOps = only(list, 'dOps')
    return Boolean(dOps) && dOps.end - dOps.body >= 11 && b[dOps.body] === 0
  }
  const esds = only(list, 'esds')
  return Boolean(esds) && aacConfig(b, esds)
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
// type in an audio stream.
function aacConfig (b, esds) {
  if (esds.end - esds.body < 5 || b[esds.body + 4] !== 0x03) return false
  const es = descriptor(b, esds.body + 5, esds.end)
  if (!es || es.end - es.at < 3) return false
  const f = b[es.at + 2]
  let p = es.at + 3
  if (f & 0x80) p += 2
  if (f & 0x40) {
    if (p >= es.end) return false
    p += 1 + b[p]
  }
  if (f & 0x20) p += 2
  if (p >= es.end || b[p] !== 0x04) return false
  const dc = descriptor(b, p + 1, es.end)
  if (!dc || dc.end - dc.at < 13) return false
  if (!AAC_OBJECT_TYPES.includes(b[dc.at]) || (b[dc.at + 1] >> 2) !== AUDIO_STREAM) return false
  // The DecoderSpecificInfo (the AudioSpecificConfig, 2 to 5 bytes for AAC)
  // must follow, small and inside its parent: Media3 allocates a buffer of
  // the length it declares before reading it.
  const q = dc.at + 13
  if (q >= dc.end || b[q] !== 0x05) return false
  const dsi = descriptor(b, q + 1, dc.end)
  return Boolean(dsi) && dsi.end - dsi.at >= 2 && dsi.end - dsi.at <= MAX_DECODER_CONFIG
}

// A table of entry_count entries of `size` bytes (stsc, stco, co64) holds
// them in its own bytes and stays under MAX_SAMPLES.
function tableFits (b, box, size) {
  if (box.end - box.body < 8) return false
  const count = be32(b, box.body + 4)
  return count <= MAX_SAMPLES && count * size <= box.end - box.body - 8
}

// The sample group boxes stbl lists hold their own fields, as video-bounds.js
// requires: no encryption group, an sbgp whole entries covering no more than
// the samples, an sgpd its header and, in version 1, whole entries. Versions
// 0 and 2 size each sgpd entry by its grouping type, which the walk does not
// read, so there only an empty table passes. Editions of the format disagree
// on the version 2 header (16 bytes, or 20 with a default_length first), so
// it passes only when every reading finds no entry.
function groupsFit (b, inStbl, samples) {
  for (const x of inStbl) {
    if (x.type !== 'sbgp' && x.type !== 'sgpd') continue
    const n = x.end - x.body
    const version = n >= 4 ? b[x.body] : -1
    if (n >= 8 && fourcc(b, x.body + 4) === ENCRYPTION_GROUP) return false
    if (x.type === 'sbgp') {
      const head = version === 0 ? 12 : version === 1 ? 16 : 0
      if (head === 0 || n < head) return false
      const count = be32(b, x.body + head - 4)
      if (count * 8 !== n - head) return false
      let total = 0
      for (let i = 0, p = x.body + head; i < count; i++, p += 8) {
        total += be32(b, p)
        if (total > samples) return false
      }
    } else {
      const head = version === 0 ? 12 : version === 1 || version === 2 ? 16 : 0
      if (head === 0 || n < head) return false
      if (version === 1 ? !groupEntriesFit(b, x, head) : !emptyGroupTable(b, x, version, n)) return false
    }
  }
  return true
}

function emptyGroupTable (b, sgpd, version, n) {
  if (version === 0) return n === 12 && be32(b, sgpd.body + 8) === 0
  if (n === 16) return be32(b, sgpd.body + 12) === 0
  return n === 20 && be32(b, sgpd.body + 12) === 0 && be32(b, sgpd.body + 16) === 0
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

// trak -> { inTrak, media, stts, sizes, cap } for a self-contained sound
// track with one audio sample entry, no video media header, one sample
// size table (sizes is { count, bytes }) and chunk tables that cover every
// sample, or null.
function soundTrack (b, trak, budget) {
  const inTrak = inside(b, trak, budget, CHILDREN.trak)
  const mdia = inTrak && only(inTrak, 'mdia')
  const inMdia = mdia && inside(b, mdia, budget, CHILDREN.mdia)
  const hdlr = inMdia && only(inMdia, 'hdlr')
  if (!hdlr || hdlr.end - hdlr.body < 12 || fourcc(b, hdlr.body + 8) !== 'soun') return null
  const mdhd = only(inMdia, 'mdhd')
  const media = mdhd && mediaTime(b, mdhd)
  const minf = only(inMdia, 'minf')
  const inMinf = media && minf && inside(b, minf, budget, CHILDREN.minf)
  if (!inMinf || inMinf.some((x) => x.type === 'vmhd')) return null
  const dinf = only(inMinf, 'dinf')
  const inDinf = dinf && inside(b, dinf, budget, CHILDREN.dinf)
  if (!inDinf || !selfContained(b, only(inDinf, 'dref'), budget)) return null
  const stbl = only(inMinf, 'stbl')
  const inStbl = stbl && inside(b, stbl, budget, CHILDREN.stbl)
  const sampleEntries = inStbl && entries(b, only(inStbl, 'stsd'), budget)
  if (!sampleEntries || sampleEntries.length !== 1 || !audioEntry(b, sampleEntries[0], budget)) return null
  const stts = only(inStbl, 'stts')
  // AAC and Opus have no composition offsets: a ctts could only move
  // samples away from where stts puts them.
  if (!stts || inStbl.some((x) => x.type === 'ctts')) return null
  const sizeBoxes = inStbl.filter((x) => x.type === 'stsz' || x.type === 'stz2')
  const sizes = sizeBoxes.length === 1 ? sampleSizes(b, sizeBoxes[0]) : null
  if (sizes === null || !groupsFit(b, inStbl, sizes.count)) return null
  const stsc = inStbl.filter((x) => x.type === 'stsc')
  const offsets = inStbl.filter((x) => x.type === 'stco' || x.type === 'co64')
  if (stsc.length > 1 || offsets.length > 1) return null
  if (stsc.length === 1 && !tableFits(b, stsc[0], 12)) return null
  if (offsets.length === 1 && !tableFits(b, offsets[0], offsets[0].type === 'stco' ? 4 : 8)) return null
  // Samples in moov are found through stsc and the chunk offsets.
  if (stsc.length === 0 ? sizes.count !== 0 : offsets.length === 0 || !chunksAgree(b, stsc[0], be32(b, offsets[0].body + 4), sizes.count)) return null
  return { inTrak, media, stts, sizes, cap: media.timescale * (MAX_AUDIO_MS / 1000 + 1) }
}

// tkhd (versions 0 and 1) -> duration in the movie timescale, UNKNOWN for
// all ones or when there is no tkhd (nothing to disagree), or null when
// malformed.
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

// elst (versions 0 and 1) agrees with ms of samples: one or two entries, an
// empty edit (media_time -1) only first and at most AUDIO_MS_TOLERANCE long,
// at most one media edit at media_time >= 0 and rate exactly 1, and segment
// durations (movie timescale) summing to within AUDIO_MS_TOLERANCE of ms. A
// media edit of duration 0 plays the whole media. Players follow the edit
// list, so one could repeat samples or insert hours of silence.
function editListAgrees (b, elst, timescale, ms) {
  const n = elst.end - elst.body
  if (n < 8) return false
  const version = b[elst.body]
  const size = version === 0 ? 12 : version === 1 ? 20 : 0
  const count = be32(b, elst.body + 4)
  if (size === 0 || count < 1 || count > 2 || count * size > n - 8) return false
  let total = 0
  let media = 0
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
    if (segment < 0) return false
    const rate = p + size - 4
    if (time === -1) {
      if (i !== 0 || toMs(segment, timescale) > AUDIO_MS_TOLERANCE) return false
      total += segment
    } else if (time >= 0) {
      if (++media > 1) return false
      if (b[rate] !== 0 || b[rate + 1] !== 1 || b[rate + 2] !== 0 || b[rate + 3] !== 0) return false
      if (segment === 0) whole = true
      else total += segment
    } else {
      return false
    }
  }
  return whole || Math.abs(toMs(total, timescale) - ms) <= AUDIO_MS_TOLERANCE
}

// A track's tkhd duration and edit list, both in the movie timescale, agree
// with ms of its samples.
function trackAgrees (b, inTrak, movie, ms, budget) {
  const tkhds = inTrak.filter((x) => x.type === 'tkhd')
  const d = tkhds.length > 1 ? null : tkhdDuration(b, tkhds[0])
  if (d === null || !headerAgrees(budget, d, movie.timescale, ms)) return false
  const edts = inTrak.filter((x) => x.type === 'edts')
  if (edts.length === 0) return true
  if (edts.length > 1) return false
  const inEdts = inside(b, edts[0], budget, CHILDREN.edts)
  const elst = inEdts && only(inEdts, 'elst')
  return Boolean(elst) && editListAgrees(b, elst, movie.timescale, ms)
}

// tkhd (versions 0 and 1) -> track_ID, or 0.
function trackId (b, tkhd) {
  if (!tkhd || tkhd.end - tkhd.body < 1) return 0
  const at = b[tkhd.body] === 0 ? 12 : b[tkhd.body] === 1 ? 20 : -1
  if (at < 0 || tkhd.end - tkhd.body < at + 4) return 0
  return be32(b, tkhd.body + at)
}

// mehd (versions 0 and 1) -> fragment duration in the movie timescale,
// UNKNOWN for all ones, or null when malformed.
function mehdDuration (b, mehd) {
  const n = mehd.end - mehd.body
  if (n < 8) return null
  if (b[mehd.body] === 0) {
    const d = be32(b, mehd.body + 4)
    return d === 0xffffffff ? UNKNOWN : d
  }
  if (b[mehd.body] !== 1 || n < 12) return null
  if (allOnes64(b, mehd.body + 4)) return UNKNOWN
  const d = be64(b, mehd.body + 4)
  return d < 0 ? null : d
}

// The trex { duration, size } defaults for one track, both UNKNOWN without
// a trex, or null when malformed or given twice.
function trexDefault (b, inMvex, id) {
  let found = null
  for (const trex of inMvex) {
    if (trex.type !== 'trex') continue
    if (trex.end - trex.body < 24) return null
    if (be32(b, trex.body + 4) !== id) continue
    if (found !== null) return null
    found = { duration: be32(b, trex.body + 12), size: be32(b, trex.body + 16) }
  }
  return found || { duration: UNKNOWN, size: UNKNOWN }
}

// tfdt (versions 0 and 1) -> base media decode time, or null when malformed
// or not a safe integer.
function decodeTime (b, tfdt) {
  const n = tfdt.end - tfdt.body
  if (n < 8) return null
  if (b[tfdt.body] === 0) return be32(b, tfdt.body + 4)
  if (b[tfdt.body] !== 1 || n < 12) return null
  const t = be64(b, tfdt.body + 4)
  return t < 0 ? null : t
}

// Sums the sample durations of every top-level moof, in the sound track's
// media timescale, starting from `ticks`. null when a sample has no duration
// (none given, or zero: a player would still play it) or no size (none
// given, or zero), the sizes with those of moov pass the file's length,
// a fragment names
// another track, a trun claims more samples than its own bytes hold, a box
// is malformed, the sum passes cap (already too long), the samples with
// those of moov pass MAX_SAMPLES, or a sample has a composition offset. A
// traf's tfdt, when given (at most one), must be the running total: a
// player places the fragment there, so a gap would play as an hour of
// silence and an overlap would hide samples.
function fragmentTicks (b, top, id, fallback, start, cap, budget) {
  let { ticks, samples, bytes } = start
  for (const moof of top) {
    if (moof.type !== 'moof') continue
    const inMoof = inside(b, moof, budget, CHILDREN.moof)
    if (!inMoof) return null
    for (const traf of inMoof) {
      if (traf.type !== 'traf') continue
      const inTraf = inside(b, traf, budget, CHILDREN.traf)
      const tfhd = inTraf && only(inTraf, 'tfhd')
      if (!tfhd || tfhd.end - tfhd.body < 8) return null
      if (be32(b, tfhd.body + 4) !== id) return null
      const tfdts = inTraf.filter((x) => x.type === 'tfdt')
      if (tfdts.length > 1) return null
      if (tfdts.length === 1 && decodeTime(b, tfdts[0]) !== ticks) return null
      const tf = fullBoxFlags(b, tfhd)
      let dflt = fallback.duration
      let dsize = fallback.size
      let at = tfhd.body + 8 + (tf & 0x01 ? 8 : 0) + (tf & 0x02 ? 4 : 0)
      if (tf & 0x08) {
        if (at + 4 > tfhd.end) return null
        dflt = be32(b, at)
        at += 4
      }
      if (tf & 0x10) {
        if (at + 4 > tfhd.end) return null
        dsize = be32(b, at)
      }
      for (const trun of inTraf) {
        if (trun.type !== 'trun') continue
        if (trun.end - trun.body < 8) return null
        const f = fullBoxFlags(b, trun)
        const count = be32(b, trun.body + 4)
        const p = trun.body + 8 + (f & 0x01 ? 4 : 0) + (f & 0x04 ? 4 : 0)
        const per = 4 * ((f & 0x100 ? 1 : 0) + (f & 0x200 ? 1 : 0) + (f & 0x400 ? 1 : 0) + (f & 0x800 ? 1 : 0))
        if (p > trun.end || count * per > trun.end - p) return null
        if (count > MAX_SAMPLES - samples) return null
        samples += count
        const sizeAt = f & 0x100 ? 4 : 0
        const listed = per > 0 ? count : 0
        for (let i = 0, q = p; i < listed; i++, q += per) {
          if (f & 0x800 && be32(b, q + per - 4) !== 0) return null
          if (f & 0x100) {
            const d = be32(b, q)
            if (d === 0) return null
            ticks += d
            if (ticks > cap) return null
          }
          if (f & 0x200) {
            const s = be32(b, q + sizeAt)
            if (s === 0) return null
            bytes += s
            if (bytes > b.byteLength) return null
          }
        }
        if (count > 0 && !(f & 0x100)) {
          if (dflt === UNKNOWN || dflt === 0) return null
          ticks += count * dflt
          if (ticks > cap) return null
        }
        if (count > 0 && !(f & 0x200)) {
          if (dsize === UNKNOWN || dsize === 0) return null
          bytes += count * dsize
          if (bytes > b.byteLength) return null
        }
      }
    }
  }
  return ticks
}

// A header duration agrees with the samples' ms when it is not given (0 or
// all ones) or is within AUDIO_MS_TOLERANCE of it.
function agrees (duration, timescale, ms) {
  return duration === 0 || duration === UNKNOWN || Math.abs(toMs(duration, timescale) - ms) <= AUDIO_MS_TOLERANCE
}

// The duration of mvhd, tkhd, mdhd or mehd agrees with the samples. On the
// sender's own recording (budget.metadata) it is not compared:
// stripAudioMetadata rewrites it from the samples before the note leaves
// the device. Chrome's MPEG-4 writer puts milliseconds in an mdhd whose
// timescale is 48000, so its header claims 0.1 s for a 5 s recording.
function headerAgrees (budget, duration, timescale, ms) {
  return budget.metadata || agrees(duration, timescale, ms)
}

// A file without mvex: the sound track's samples, from its stts, which
// the sample size table must count too. -> { ms, ticks } or null.
function sampledMs (b, track, movie, budget) {
  const run = sttsTicks(b, track.stts, track.cap)
  if (run === null || run.samples === 0 || track.sizes.count !== run.samples) return null
  const ms = toMs(run.ticks, track.media.timescale)
  if (!headerAgrees(budget, track.media.duration, track.media.timescale, ms)) return null
  if (!trackAgrees(b, track.inTrak, movie, ms, budget)) return null
  return { ms, ticks: run.ticks }
}

// A file whose moov has mvex: the samples of its sound track, those listed
// in moov (as many in stts as in the sample size table) plus every
// fragment's. mehd must agree. -> { ms, ticks } or null.
function fragmentedMs (b, top, mvex, track, movie, budget) {
  const { inTrak, media, stts, sizes, cap } = track
  const id = trackId(b, only(inTrak, 'tkhd'))
  const inMvex = inside(b, mvex, budget, CHILDREN.mvex)
  if (id < 1 || !inMvex) return null
  const mehds = inMvex.filter((x) => x.type === 'mehd')
  if (mehds.length > 1) return null
  const fallback = trexDefault(b, inMvex, id)
  if (fallback === null) return null
  const inMoov = sttsTicks(b, stts, cap)
  if (inMoov !== null && inMoov.samples !== sizes.count) return null
  const ticks = inMoov === null ? null : fragmentTicks(b, top, id, fallback, { ...inMoov, bytes: sizes.bytes }, cap, budget)
  if (ticks === null) return null
  const ms = toMs(ticks, media.timescale)
  if (!headerAgrees(budget, media.duration, media.timescale, ms)) return null
  if (!trackAgrees(b, inTrak, movie, ms, budget)) return null
  if (mehds.length === 1) {
    const d = mehdDuration(b, mehds[0])
    if (d === null || !headerAgrees(budget, d, movie.timescale, ms)) return null
  }
  return { ms, ticks }
}

// -> { top, inMoov, ms, ticks, media, movie } or null, with ticks the
// samples' total in the media timescale (media) and movie the mvhd
// timescale. metadata: the sender's own recording, whose udta and meta are
// skipped instead of refused and whose header durations are not compared.
function parse (bytes, metadata) {
  if (!(bytes instanceof Uint8Array)) return null
  const budget = { n: 0, metadata: metadata === true }
  const top = listed(bytes, 0, bytes.byteLength, budget, CHILDREN.top)
  if (!top || top.length < 2 || top[0].type !== 'ftyp' || !audioBrand(bytes, top[0])) return null
  // A segment index could describe another timeline than the samples'.
  if (top.some((x) => x.type === 'sidx')) return null
  const moov = only(top, 'moov')
  const inMoov = moov && inside(bytes, moov, budget, CHILDREN.moov)
  const mvhd = inMoov && only(inMoov, 'mvhd')
  if (!mvhd) return null
  const traks = inMoov.filter((x) => x.type === 'trak')
  if (traks.length !== 1) return null
  const track = soundTrack(bytes, traks[0], budget)
  if (!track) return null
  const movie = mediaTime(bytes, mvhd)
  if (!movie) return null
  const mvexes = inMoov.filter((x) => x.type === 'mvex')
  if (mvexes.length > 1) return null
  // Without mvex a player reading fragments would play samples that moov
  // does not list.
  if (mvexes.length === 0 && top.some((x) => x.type === 'moof' || x.type === 'styp')) return null
  // The samples decide: a player plays every sample whatever the headers
  // say, so each header that gives a duration must agree with them.
  const run = mvexes.length === 0
    ? sampledMs(bytes, track, movie, budget)
    : fragmentedMs(bytes, top, mvexes[0], track, movie, budget)
  const ms = run && run.ms
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_AUDIO_MS) return null
  if (!headerAgrees(budget, movie.duration, movie.timescale, ms)) return null
  return { top, inMoov, ms, ticks: run.ticks, media: track.media.timescale, movie: movie.timescale }
}

// -> { ms } or null. { metadata: true } is for the sender's own recording,
// before stripAudioMetadata, and nowhere else.
function audioBounds (bytes, opts) {
  try {
    const parsed = parse(bytes, opts != null && opts.metadata === true)
    return parsed && { ms: parsed.ms }
  } catch {
    return null
  }
}

// Containers stripAudioMetadata walks into, blanking each child their
// CHILDREN list does not hold (udta and meta among them).
const STRIP_INSIDE = Object.freeze(['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl', 'edts', 'mvex', 'moof', 'traf'])
const TIMED = Object.freeze(['mvhd', 'tkhd', 'mdhd'])
// Where the duration of each header sits in its body: [version 0, version 1].
const DURATION_AT = Object.freeze({ mvhd: [16, 24], mdhd: [16, 24], tkhd: [20, 28], mehd: [4, 4] })

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

// Sets the duration of mvhd, tkhd, mdhd or mehd to the samples' (media
// timescale for mdhd, movie timescale for the others). A duration not
// given (0 or all ones) stays so. false when the box is malformed or the
// value does not fit a version 0 field.
function setDuration (b, box, durations) {
  if (box.end - box.body < 1) return false
  const version = b[box.body]
  if (version !== 0 && version !== 1) return false
  const p = box.body + DURATION_AT[box.type][version]
  if (p + (version === 0 ? 4 : 8) > box.end) return false
  const value = box.type === 'mdhd' ? durations.media : durations.movie
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

// allow: the CHILDREN list of the container (or sample entry) boxes sit in.
function stripBoxes (b, boxes, budget, durations, allow) {
  for (const x of boxes) {
    if (!allowed(allow, x.type)) {
      // Same size, so every offset (stco, co64, trun data_offset) still holds.
      b.set([0x66, 0x72, 0x65, 0x65], x.start + 4)
      b.fill(0, x.body, x.end)
    } else if (TIMED.includes(x.type)) {
      zeroTimes(b, x)
      if (!setDuration(b, x, durations)) return false
    } else if (x.type === 'mehd') {
      if (!setDuration(b, x, durations)) return false
    } else if (x.type === 'stsd') {
      // parse found exactly one entry, an AUDIO_ENTRIES one.
      const list = x.end - x.body >= 8 ? children(b, x.body + 8, x.end, budget) : null
      if (!list || list.length !== 1 || !AUDIO_ENTRIES.includes(list[0].type) || list[0].end - list[0].body < 28) return false
      const inner = children(b, list[0].body + 28, list[0].end, budget)
      if (!inner || !stripBoxes(b, inner, budget, durations, CHILDREN[list[0].type])) return false
    } else if (STRIP_INSIDE.includes(x.type)) {
      const inner = children(b, x.body, x.end, budget)
      if (!inner) return false
      if (!stripBoxes(b, inner, budget, durations, CHILDREN[x.type])) return false
    }
  }
  return true
}

// A voice note without its recording time or device tags: a copy of bytes
// with creation and modification times zeroed in mvhd, every tkhd and mdhd,
// every duration those headers and mehd give rewritten from the samples,
// and every udta and meta box, and every other child CHILDREN does not list
// (top level, walked containers and the sample entry), turned into a free
// box of the same size, zero filled. null when audioBounds with
// { metadata: true } refuses the bytes, or when the stripped copy fails the
// strict audioBounds. Never mutates bytes, never throws.
function stripAudioMetadata (bytes) {
  try {
    const parsed = parse(bytes, true)
    if (parsed === null) return null
    // ticks is at most 121 s of the media timescale, so the movie value
    // stays a safe integer.
    const durations = { media: parsed.ticks, movie: Math.round(parsed.ticks / parsed.media * parsed.movie) }
    const out = new Uint8Array(bytes.byteLength)
    out.set(bytes)
    const budget = { n: 0 }
    const top = children(out, 0, out.byteLength, budget)
    if (!top || !stripBoxes(out, top, budget, durations, CHILDREN.top)) return null
    return parse(out) === null ? null : out
  } catch {
    return null
  }
}

module.exports = { audioBounds, stripAudioMetadata, MAX_AUDIO_MS, AUDIO_MS_TOLERANCE, MAX_SAMPLES, AUDIO_BRANDS, AUDIO_ENTRIES }
