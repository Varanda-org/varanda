'use strict'

// Builds synthetic still AVIF files box by box, for the refusal cases of
// media-bounds.test.js. build(desc) lays out ftyp, meta and mdat from a plain
// description that a test can edit before building; single() and grid()
// return descriptions shaped like the real encoders' output.

function bytes (...parts) {
  const out = []
  for (const part of parts) {
    if (typeof part === 'string') for (const c of part) out.push(c.charCodeAt(0))
    else if (typeof part === 'number') out.push(part)
    else for (const x of part) out.push(x)
  }
  return out
}

const be16 = (v) => [(v >>> 8) & 0xff, v & 0xff]
const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]

function box (type, ...parts) {
  const body = bytes(...parts)
  return [...be32(body.length + 8), ...bytes(type), ...body]
}

function fullBox (type, version, flags, ...parts) {
  return box(type, version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff, ...parts)
}

function leb128 (v) {
  const out = []
  do {
    let x = v & 0x7f
    v = Math.floor(v / 128)
    if (v > 0) x |= 0x80
    out.push(x)
  } while (v > 0)
  return out
}

function bitWriter () {
  const bits = []
  return {
    put (n, v) {
      for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2)
    },
    // trailing_bits: a one, then zeros to the byte boundary.
    done () {
      bits.push(1)
      while (bits.length % 8) bits.push(0)
      const out = []
      for (let i = 0; i < bits.length; i += 8) {
        let x = 0
        for (let k = 0; k < 8; k++) x = x * 2 + bits[i + k]
        out.push(x)
      }
      return out
    }
  }
}

// An AV1 sequence header OBU (with an optional temporal delimiter before it)
// and a stand-in frame OBU after it. reduced: libavif's reduced still picture
// header; otherwise ImageIO's full header with one operating point. frame is
// the frame OBU payload: its first byte 0x10 reads, in a full header, as a
// shown key frame with frame_size_override_flag 0 (0x12 sets the flag).
// The full header can also carry, as frameHeader() reads them: timing
// { equal, decoderModel: { presentationBits } }, displayDelay, points,
// frameIds [delta_frame_id_length_minus_2, additional_frame_id_length_minus_1],
// orderHint, screen and integerMv (0 or 1 forced, 2 or unset for SELECT).
function sequenceHeader (o = {}) {
  const profile = o.profile || 0
  const reduced = o.reduced !== undefined ? o.reduced : true
  const still = o.still !== undefined ? o.still : reduced
  const level = o.level || 0
  const w = bitWriter()
  w.put(3, profile)
  w.put(1, still ? 1 : 0)
  w.put(1, reduced ? 1 : 0)
  if (reduced) {
    w.put(5, level)
  } else {
    const dm = o.timing && o.timing.decoderModel
    w.put(1, o.timing ? 1 : 0)
    if (o.timing) {
      w.put(32, 1) // num_units_in_display_tick
      w.put(32, 30) // time_scale
      w.put(1, o.timing.equal ? 1 : 0)
      if (o.timing.equal) w.put(1, 1) // num_ticks_per_picture_minus_1, uvlc 0
      w.put(1, dm ? 1 : 0)
      if (dm) {
        w.put(5, 9) // buffer_delay_length_minus_1
        w.put(32, 1) // num_units_in_decoding_tick
        w.put(5, 3) // buffer_removal_time_length_minus_1
        w.put(5, dm.presentationBits - 1)
      }
    }
    w.put(1, o.displayDelay ? 1 : 0)
    const points = o.points || 1
    w.put(5, points - 1)
    for (let i = 0; i < points; i++) {
      w.put(12, 0)
      w.put(5, level)
      if (level > 7) w.put(1, o.tier || 0)
      if (dm) {
        w.put(1, 1) // decoder_model_present_for_this_op
        w.put(10, 5)
        w.put(10, 7)
        w.put(1, 0)
      }
      if (o.displayDelay) {
        w.put(1, 1)
        w.put(4, 3)
      }
    }
  }
  w.put(4, 15)
  w.put(4, 15)
  w.put(16, o.width - 1)
  w.put(16, o.height - 1)
  if (!reduced) {
    w.put(1, o.frameIds ? 1 : 0)
    if (o.frameIds) {
      w.put(4, o.frameIds[0])
      w.put(3, o.frameIds[1])
    }
  }
  w.put(3, 0) // 128x128 superblock, filter intra, intra edge filter
  if (!reduced) {
    w.put(4, 0) // interintra, masked, warped, dual filter
    w.put(1, o.orderHint ? 1 : 0)
    if (o.orderHint) w.put(2, 0)
    const screen = o.screen === undefined ? 2 : o.screen
    w.put(1, screen === 2 ? 1 : 0)
    if (screen !== 2) w.put(1, screen)
    if (screen > 0) {
      const mv = o.integerMv === undefined ? 2 : o.integerMv
      w.put(1, mv === 2 ? 1 : 0)
      if (mv !== 2) w.put(1, mv)
    }
    if (o.orderHint) w.put(3, 6) // order_hint_bits_minus_1
  }
  // superres, cdef, restoration. With order hints, cdef and restoration are
  // on, so a reader that skips order_hint_bits_minus_1 reads mono_chrome 1.
  w.put(3, !reduced && o.orderHint ? 3 : 0)
  w.put(1, o.highBitdepth ? 1 : 0)
  if (profile === 2 && o.highBitdepth) w.put(1, 0)
  if (profile !== 1) w.put(1, o.mono ? 1 : 0)
  if (o.cicp) {
    w.put(1, 1)
    w.put(8, o.cicp[0])
    w.put(8, o.cicp[1])
    w.put(8, o.cicp[2])
  } else {
    w.put(1, 0)
  }
  w.put(1, 0) // color_range
  if (profile === 0 && !o.mono) w.put(2, 0) // chroma_sample_position
  w.put(1, 0) // separate_uv_delta_q
  w.put(1, 0) // film_grain_params_present
  const payload = w.done()
  const out = []
  if (o.temporalDelimiter) out.push(0x12, 0x00)
  out.push(0x0a, ...leb128(payload.length), ...payload)
  const frame = o.frame || [0x10, 0x00, 0x00]
  out.push(0x32, ...leb128(frame.length), ...frame)
  return out
}

// The uncompressed header of a frame under the full sequence header o, up to
// frame_size_override_flag (f.override), as a frame OBU payload. Every field
// before and after the flag is written as ones where the syntax allows, so a
// reader one bit off reads a 1.
function frameHeader (o = {}, f = {}) {
  const w = bitWriter()
  w.put(1, f.existing || 0)
  w.put(2, f.type || 0)
  w.put(1, f.show === undefined ? 1 : f.show)
  const dm = o.timing && o.timing.decoderModel
  if (dm && !o.timing.equal) w.put(dm.presentationBits, 2 ** dm.presentationBits - 1)
  w.put(1, 1) // disable_cdf_update
  const screen = o.screen === undefined ? 2 : o.screen
  let allow = screen
  if (screen === 2) {
    allow = f.screen === undefined ? 1 : f.screen
    w.put(1, allow)
  }
  const mv = o.integerMv === undefined ? 2 : o.integerMv
  if (allow && mv === 2) w.put(1, 1)
  if (o.frameIds) {
    const n = o.frameIds[0] + 2 + o.frameIds[1] + 1
    w.put(n, 2 ** n - 1)
  }
  w.put(1, f.override || 0)
  w.put(7, 127)
  return w.done()
}

// av1C for 8-bit 4:2:0 profile 0 unless told otherwise.
function av1C (o = {}) {
  const ssx = o.ssx !== undefined ? o.ssx : 1
  const ssy = o.ssy !== undefined ? o.ssy : 1
  const c2 = ((o.tier || 0) << 7) | ((o.highBitdepth ? 1 : 0) << 6) | ((o.twelveBit ? 1 : 0) << 5) |
    ((o.mono ? 1 : 0) << 4) | (ssx << 3) | (ssy << 2)
  return box('av1C', 0x81, ((o.profile || 0) << 5) | (o.level || 0), c2, o.delay || 0, ...(o.configOBUs || []))
}

const ispe = (w, h) => fullBox('ispe', 0, 0, be32(w), be32(h))
const colrNclx = () => box('colr', 'nclx', be16(1), be16(13), be16(6), 0x80)
const pixi = () => fullBox('pixi', 0, 0, 3, 8, 8, 8)
const irot = (angle) => box('irot', angle)

// One av01 item, libavif's layout (hdlr, pitm, iloc, iinf, iprp).
function single (o = {}) {
  const width = o.width || 16
  const height = o.height || 16
  return {
    major: 'avif',
    compatible: ['avif', 'mif1', 'miaf'],
    props: [ispe(width, height), pixi(), av1C(), colrNclx()],
    items: [{ id: 1, type: 'av01', data: sequenceHeader({ width, height, ...o.seq }), assoc: [[1, 0], [2, 0], [3, 1], [4, 0]] }],
    primary: 1
  }
}

// A grid item over rows x cols tiles of tw x th, ImageIO's layout.
function grid (o = {}) {
  const rows = o.rows || 2
  const cols = o.cols || 2
  const tw = o.tileWidth || 64
  const th = o.tileHeight || 64
  const width = o.width || cols * tw
  const height = o.height || rows * th
  const n = o.tiles || rows * cols
  const items = []
  for (let i = 1; i <= n; i++) {
    items.push({ id: i, type: 'av01', flags: 1, data: sequenceHeader({ width: tw, height: th, reduced: false, temporalDelimiter: true }), assoc: [[2, 1], [1, 1], [5, 1]] })
  }
  const big = width > 0xffff || height > 0xffff
  const descriptor = [0, big ? 1 : 0, rows - 1, cols - 1, ...(big ? [...be32(width), ...be32(height)] : [...be16(width), ...be16(height)])]
  items.push({ id: n + 1, type: 'grid', data: descriptor, method: 1, assoc: [[1, 1], [3, 0], [4, 0], [6, 1]] })
  return {
    major: 'avif',
    compatible: ['MiPr', 'avif', 'miaf', 'mif1'],
    dinf: true,
    ilocVersion: 1,
    props: [colrNclx(), ispe(tw, th), ispe(width, height), pixi(), av1C(), irot(0)],
    items,
    primary: n + 1,
    iref: [{ type: 'dimg', from: n + 1, to: items.slice(0, n).map((it) => it.id) }]
  }
}

function infe (it) {
  if (it.raw) return it.raw
  return fullBox('infe', 2, it.flags || 0, be16(it.id), be16(it.protection || 0), it.type, it.name || '', 0)
}

function metaBox (d, offsets) {
  const v = d.ilocVersion !== undefined ? d.ilocVersion : 0
  const ilocItems = []
  d.items.forEach((it, i) => {
    if (it.noLocation) return
    ilocItems.push(...be16(it.id))
    if (v === 1) ilocItems.push(...be16(it.method || 0))
    const extents = it.extents || 1
    ilocItems.push(...be16(it.dri || 0), ...be16(extents))
    for (let k = 0; k < extents; k++) ilocItems.push(...be32(offsets[i][0]), ...be32(offsets[i][1]))
  })
  const count = d.items.filter((it) => !it.noLocation).length
  const iloc = fullBox('iloc', v, 0, d.ilocSizes !== undefined ? d.ilocSizes : 0x44, d.ilocBase || 0, be16(count), ilocItems)
  const iinfCount = d.iinfCount !== undefined ? d.iinfCount : d.items.length
  const iinfVersion = d.iinfVersion || 0
  const iinf = fullBox('iinf', iinfVersion, 0, iinfVersion ? be32(iinfCount) : be16(iinfCount), ...d.items.map(infe))
  const ipmaEntries = d.items.filter((it) => it.assoc).map((it) => [...be16(it.id), it.assoc.length, ...it.assoc.map(([idx, ess]) => (ess << 7) | idx)])
  const ipma = d.ipma || fullBox('ipma', 0, 0, be32(ipmaEntries.length), ...ipmaEntries)
  const iprp = box('iprp', box('ipco', ...d.props), ipma, ...(d.iprpExtra || []))
  const hdlr = d.hdlr || fullBox('hdlr', 0, 0, be32(0), d.handler || 'pict', new Array(12).fill(0), 'libavif', 0)
  const pitm = d.pitm || fullBox('pitm', 0, 0, be16(d.primary))
  const kids = [hdlr]
  // dinf: true for ImageIO's dref with one self-contained url, or a raw box.
  if (d.dinf === true) kids.push(box('dinf', fullBox('dref', 0, 0, be32(1), fullBox('url ', 0, 1))))
  else if (d.dinf) kids.push(d.dinf)
  kids.push(pitm, iloc, iinf)
  if (d.iref) kids.push(fullBox('iref', 0, 0, ...d.iref.map((r) => box(r.type, be16(r.from), be16(r.to.length), ...r.to.map(be16)))))
  kids.push(iprp)
  const idat = d.items.filter((it) => it.method === 1).map((it) => it.data).flat()
  if (idat.length || d.idat) kids.push(box('idat', ...(d.idat || idat)))
  kids.push(...(d.metaExtra || []))
  return fullBox('meta', 0, 0, ...kids)
}

// d.extent(i, natural, layout) may move item i's extent: layout has the
// absolute metaStart, metaEnd and mdatStart (the payload).
function build (d) {
  const ftyp = box('ftyp', d.major, be32(0), ...d.compatible.map((x) => bytes(x)))
  const mdatData = []
  const natural = []
  let idatAt = 0
  for (const it of d.items) {
    if (it.method === 1) {
      natural.push([idatAt, it.data.length])
      idatAt += it.data.length
    } else {
      natural.push([mdatData.length, it.data.length])
      mdatData.push(...it.data)
    }
  }
  const before = [...ftyp, ...(d.before || []).flat()]
  const placeholder = metaBox(d, natural)
  const metaStart = before.length
  const metaEnd = metaStart + placeholder.length
  const head = d.mdatHeader === 'largesize' ? 16 : 8
  const mdatStart = metaEnd + (d.between || []).flat().length + head
  const layout = { metaStart, metaEnd, mdatStart }
  const offsets = d.items.map((it, i) => {
    const abs = it.method === 1 ? natural[i] : [mdatStart + natural[i][0], natural[i][1]]
    return d.extent ? d.extent(i, abs, layout) : abs
  })
  const meta = metaBox(d, offsets)
  let mdat
  // largeHigh sets the upper 32 bits of the largesize; largeDelta moves its low half.
  if (d.mdatHeader === 'largesize') mdat = [...be32(1), ...bytes('mdat'), ...be32(d.largeHigh || 0), ...be32(mdatData.length + 16 + (d.largeDelta || 0)), ...mdatData]
  else if (d.mdatHeader === 'zero') mdat = [...be32(0), ...bytes('mdat'), ...mdatData]
  else mdat = box('mdat', ...mdatData)
  return new Uint8Array([...before, ...meta, ...(d.between || []).flat(), ...mdat, ...(d.after || []).flat()])
}

const read32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
const read4cc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3])

// The same file with ImageIO's 64-bit largesize mdat header rewritten as a
// 32-bit one, every mdat extent in iloc moved back by the 8 bytes saved.
// Only for well-formed encoder output with ftyp, meta, then mdat.
function withoutLargesize (src) {
  const b = Uint8Array.from(src)
  let p = 0
  let meta = -1
  while (read4cc(b, p + 4) !== 'mdat') {
    if (read4cc(b, p + 4) === 'meta') meta = p
    p += read32(b, p)
  }
  const mdat = p
  if (read32(b, mdat) !== 1) return b
  let q = meta + 12
  while (read4cc(b, q + 4) !== 'iloc') q += read32(b, q)
  const version = b[q + 8]
  const count = (b[q + 14] << 8) | b[q + 15]
  let r = q + 16
  for (let i = 0; i < count; i++) {
    r += 2
    let method = 0
    if (version === 1) {
      method = b[r + 1] & 0x0f
      r += 2
    }
    r += 4
    if (method === 0) b.set(be32(read32(b, r) - 8), r)
    r += 8
  }
  const out = new Uint8Array(b.length - 8)
  out.set(b.subarray(0, mdat))
  out.set([...be32(read32(b, mdat + 12) - 8), ...bytes('mdat')], mdat)
  out.set(b.subarray(mdat + 16), mdat + 8)
  return out
}

module.exports = { bytes, be16, be32, box, fullBox, sequenceHeader, frameHeader, av1C, ispe, colrNclx, pixi, irot, single, grid, build, withoutLargesize }
