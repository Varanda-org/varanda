'use strict'

// The member's "seen" document synced between devices through the account
// service: which Avisos, page notices, DM messages and group posts were
// already seen, whom the member blocked (lib/member-block.js) and what they
// decided about the depoimentos they received (lib/testimonial-decision.js).
// The service stores an opaque blob of a fixed size, so it learns neither what
// was seen nor how much, nor who was blocked, nor any decision.
//
// Key: seenKeyFromSeed() hashes a domain string, the identity seed
// (keyPair.secretKey.subarray(0, 32)) and the association and member keys.
// The seed is identity-wide, so every device of the member derives the same
// key with no device nonce and no exchange. The raw seed is never the
// secretbox key: the domain string keeps this key apart from every other
// key derived from the same seed (the notice seen token uses another one).
// Callers own the derived key and zero it (sodium_memzero) when done.
//
// Sealing uses crypto_secretbox_easy directly with a fresh random nonce
// per call, never a counter, since two devices may seal at the same time.
// It never goes through group-crypto sealRecord, whose input cap is far
// below SEEN_PLAIN_BYTES.
//
// Plaintext (SEEN_PLAIN_BYTES, little-endian), version 3:
//   u8 version = 3, u8 flags = 0, u32 gen, member 32, association 32,
//   u16 nAvisos, u8 nPages, u16 nDm, u8 nGroups, u8 nBlocks,
//   u8 nTestimonials                                          (78 bytes)
//   nAvisos x token entry
//   nPages x (page key 32, u8 n, n x token entry)
//   nDm x token entry
//   nGroups x (group 32, writer 32, at i64 ms, seq u32)       (76 bytes each)
//   nBlocks x (key 32, u8 on, u32 t)                          (37 bytes each)
//   nTestimonials x (from 32, u32 seq, u8 state, u32 t)       (41 bytes each)
//   random pad up to SEEN_PLAIN_BYTES
// A token entry is the 16 raw token bytes and u32 t (unix seconds, the time
// the mark was made). A testimonial state is 1 = kept, 2 = declined. Lists
// are stored oldest first.
//
// Version 2 has no nTestimonials and no testimonial entries, a 77-byte header
// and room for more dm tokens (SYNC_DM_MAX_V2). It is still read, and written
// only as version 3 afterwards: its dm list is cut to the version 3 window.
//
// Version 1 has no nBlocks either, a 76-byte header and room for even more dm
// tokens (SYNC_DM_MAX_V1). It is still read the same way.
//
// Document in JS:
//   { gen, member, association,
//     avisos: { own: [{ token, t }], pages: { 'page:<hex64>': [{ token, t }] } },
//     dm: [{ token, t }],
//     groups: [{ group, at, writer, seq }],
//     blocks: [{ key, on, t }],
//     testimonials: [{ from, seq, state, t }] }
//
// Dm tokens are one per incoming message, so the blob is a recency window
// of the newest marks, not a full copy of the local state.
//
// merge() is a pure function of the two sets: commutative and idempotent,
// so devices that keep merging and writing converge. A group keeps the mark
// ahead by compareOrder(orderKey()). The causal position of a post (the
// rule group.seen applies when the post is listed) needs the group core, so
// this module cannot use it; a device never moves its own mark backwards
// when applying the merged one. A block entry keeps the newer time per key,
// and a testimonial decision the newer time per testimonial.

const sodium = require('sodium-universal')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { orderKey, compareOrder } = require('./group')
const { isCanonicalIso } = require('./records')
const { normalizeBlocks, mergeBlocks } = require('./member-block')
const { normalizeDecisions, mergeDecisions } = require('./testimonial-decision')
const { TESTIMONIAL_KEPT_MAX, TESTIMONIAL_DECLINED_MAX } = require('@varanda/rpc')

const SEEN_VERSION = 3
const SEEN_VERSION_2 = 2
const SEEN_VERSION_1 = 1
const SEEN_PLAIN_BYTES = 32768
const SEEN_NONCE_BYTES = 24
const SEEN_MAC_BYTES = 16
const SEEN_BLOB_BYTES = SEEN_NONCE_BYTES + SEEN_MAC_BYTES + SEEN_PLAIN_BYTES
const SEEN_BLOB_B64 = Math.ceil(SEEN_BLOB_BYTES / 3) * 4
const SEEN_KEY_BYTES = 32

const SYNC_AVISOS_MAX = 256
const SYNC_PAGES_MAX = 4
const SYNC_PAGE_TOKENS_MAX = 32
const SYNC_DM_MAX = 256
const SYNC_DM_MAX_V2 = 520
const SYNC_DM_MAX_V1 = 736
const SYNC_GROUPS_MAX = 128
const SYNC_BLOCKS_MAX = 128
const SYNC_TESTIMONIALS_MAX = 128
const MERGE_AVISOS_MAX = 256
const MERGE_PAGE_TOKENS_MAX = 32

const HEADER_BYTES = 78
const TOKEN_BYTES = 16
const TOKEN_ENTRY_BYTES = TOKEN_BYTES + 4
const PAGE_HEAD_BYTES = 33
const GROUP_ENTRY_BYTES = 76
const BLOCK_ENTRY_BYTES = 37
const TESTIMONIAL_ENTRY_BYTES = 41
const U32_MAX = 4294967295
const MAX_DATE_MS = 8.64e15
const TWO_32 = 4294967296

// Every decision normalizeDecisions keeps must fit the window, or a device
// would read a capped list as a decision undone.
if (SYNC_TESTIMONIALS_MAX !== TESTIMONIAL_KEPT_MAX + TESTIMONIAL_DECLINED_MAX) {
  throw new Error('SYNC_TESTIMONIALS_MAX must equal TESTIMONIAL_KEPT_MAX + TESTIMONIAL_DECLINED_MAX')
}

const TESTIMONIAL_STATES = ['kept', 'declined']

const KEY_DOMAIN = b4a.from('varanda/member-seen/secretbox/v1\n', 'utf8')
const PAGE_PREFIX = 'page:'

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/

function isHex32 (s) {
  return typeof s === 'string' && HEX32.test(s)
}

function isHex64 (s) {
  return typeof s === 'string' && HEX64.test(s)
}

function isU32 (n) {
  return Number.isInteger(n) && n >= 0 && n <= U32_MAX
}

function cmp (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function seenKeyFromSeed (seed, association, member) {
  if (!b4a.isBuffer(seed) && !(seed instanceof Uint8Array)) throw new TypeError('seed must be bytes')
  if (seed.byteLength !== 32) throw new TypeError('seed must be 32 bytes')
  if (!isHex64(association) || !isHex64(member)) throw new TypeError('association and member must be hex64')
  return crypto.hash([KEY_DOMAIN, seed, b4a.from(association + '\n' + member, 'utf8')])
}

// Validation and canonical form. A malformed document from the caller is a
// programming error and throws; decode() validates peer data separately.

function normTokens (list, what) {
  if (!Array.isArray(list)) throw new TypeError(what + ' must be an array')
  const by = new Map()
  for (const e of list) {
    if (e === null || typeof e !== 'object' || !isHex32(e.token) || !isU32(e.t)) {
      throw new TypeError(what + ' entries must be { token: hex32, t: u32 }')
    }
    const prev = by.get(e.token)
    if (prev === undefined || e.t > prev) by.set(e.token, e.t)
  }
  return sortTokens(by)
}

function sortTokens (by) {
  const out = []
  for (const [token, t] of by) out.push({ token, t })
  out.sort((a, b) => (a.t - b.t) || cmp(a.token, b.token))
  return out
}

function unionTokens (a, b) {
  const by = new Map()
  for (const list of [a, b]) {
    for (const e of list) {
      const prev = by.get(e.token)
      if (prev === undefined || e.t > prev) by.set(e.token, e.t)
    }
  }
  return sortTokens(by)
}

function cutTokens (list, max) {
  return list.length > max ? list.slice(list.length - max) : list
}

function isEncodableMark (m) {
  return isU32(m.seq)
}

function groupAhead (a, b) {
  return compareOrder(orderKey(a.at, a.writer, a.seq), orderKey(b.at, b.writer, b.seq)) >= 0 ? a : b
}

function normGroups (list) {
  if (!Array.isArray(list)) throw new TypeError('groups must be an array')
  const by = new Map()
  for (const m of list) {
    if (m === null || typeof m !== 'object' || !isHex64(m.group) || !isHex64(m.writer) ||
        !isCanonicalIso(m.at) || !Number.isSafeInteger(m.seq) || m.seq < 0) {
      throw new TypeError('group marks must be { group, at, writer, seq }')
    }
    // A mark the blob cannot hold stays local only.
    if (!isEncodableMark(m)) continue
    const mark = { group: m.group, at: m.at, writer: m.writer, seq: m.seq }
    const prev = by.get(m.group)
    by.set(m.group, prev === undefined ? mark : groupAhead(prev, mark))
  }
  return sortGroups(by)
}

function sortGroups (by) {
  const out = [...by.values()]
  out.sort((a, b) => (Date.parse(a.at) - Date.parse(b.at)) || cmp(a.group, b.group))
  return out
}

function unionGroups (a, b) {
  const by = new Map()
  for (const list of [a, b]) {
    for (const m of list) {
      const prev = by.get(m.group)
      by.set(m.group, prev === undefined ? m : groupAhead(prev, m))
    }
  }
  return sortGroups(by)
}

function normPages (pages) {
  if (pages === null || typeof pages !== 'object' || Array.isArray(pages)) throw new TypeError('pages must be an object')
  const out = new Map()
  for (const key of Object.keys(pages)) {
    if (!key.startsWith(PAGE_PREFIX) || !isHex64(key.slice(PAGE_PREFIX.length))) {
      throw new TypeError('page keys must be page:<hex64>')
    }
    out.set(key, normTokens(pages[key], 'page tokens'))
  }
  return out
}

// Keeps the pages with the newest marks; a page's newest mark survives its
// own token cut, so the ranking is stable across merges.
function cutPages (map) {
  const ranked = []
  for (const [key, list] of map) {
    const tokens = cutTokens(list, SYNC_PAGE_TOKENS_MAX)
    if (tokens.length === 0) continue
    ranked.push({ key, tokens, newest: tokens[tokens.length - 1] })
  }
  ranked.sort((a, b) => (a.newest.t - b.newest.t) || cmp(a.newest.token, b.newest.token) || cmp(a.key, b.key))
  const kept = ranked.slice(Math.max(0, ranked.length - SYNC_PAGES_MAX))
  kept.sort((a, b) => cmp(a.key, b.key))
  const pages = {}
  for (const p of kept) pages[p.key] = p.tokens
  return pages
}

// A document without blocks reads as an empty list. A block too old for the
// window stays only in the device's own list, as a mark the blob cannot hold
// does, so it is never read as an unblock.
function normBlocks (list) {
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new TypeError('blocks must be an array')
  for (const e of list) {
    if (e === null || typeof e !== 'object' || !isHex64(e.key) || typeof e.on !== 'boolean' || !isU32(e.t)) {
      throw new TypeError('block entries must be { key: hex64, on: boolean, t: u32 }')
    }
  }
  return normalizeBlocks(list)
}

// A document without testimonial decisions reads as an empty list.
function normTestimonials (list) {
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new TypeError('testimonials must be an array')
  for (const e of list) {
    if (e === null || typeof e !== 'object' || !isHex64(e.from) || !isU32(e.seq) || e.seq === 0 ||
        !TESTIMONIAL_STATES.includes(e.state) || !isU32(e.t)) {
      throw new TypeError('testimonial entries must be { from: hex64, seq: u32 >= 1, state: kept | declined, t: u32 }')
    }
  }
  return normalizeDecisions(list)
}

function canonical (gen, member, association, own, pagesByKey, dm, groups, blocks, testimonials) {
  return {
    gen,
    member,
    association,
    avisos: { own: cutTokens(own, SYNC_AVISOS_MAX), pages: cutPages(pagesByKey) },
    dm: cutTokens(dm, SYNC_DM_MAX),
    groups: groups.length > SYNC_GROUPS_MAX ? groups.slice(groups.length - SYNC_GROUPS_MAX) : groups,
    blocks: blocks.length > SYNC_BLOCKS_MAX ? blocks.slice(blocks.length - SYNC_BLOCKS_MAX) : blocks,
    testimonials: testimonials.length > SYNC_TESTIMONIALS_MAX ? testimonials.slice(testimonials.length - SYNC_TESTIMONIALS_MAX) : testimonials
  }
}

// Validates a document into canonical lists, with no cap applied yet.
function normalize (doc) {
  if (doc === null || typeof doc !== 'object') throw new TypeError('doc must be an object')
  if (!isU32(doc.gen)) throw new TypeError('gen must be u32')
  if (!isHex64(doc.member) || !isHex64(doc.association)) throw new TypeError('member and association must be hex64')
  const avisos = doc.avisos
  if (avisos === null || typeof avisos !== 'object') throw new TypeError('avisos must be an object')
  return {
    gen: doc.gen,
    member: doc.member,
    association: doc.association,
    own: normTokens(avisos.own, 'avisos.own'),
    pages: normPages(avisos.pages),
    dm: normTokens(doc.dm, 'dm'),
    groups: normGroups(doc.groups),
    blocks: normBlocks(doc.blocks),
    testimonials: normTestimonials(doc.testimonials)
  }
}

function capped (n) {
  return canonical(n.gen, n.member, n.association, n.own, n.pages, n.dm, n.groups, n.blocks, n.testimonials)
}

// Validates and puts a document in canonical form within every cap,
// dropping the oldest marks first.
function trim (doc) {
  return capped(normalize(doc))
}

function writeI64 (view, off, ms) {
  const hi = Math.floor(ms / TWO_32)
  view.setInt32(off + 4, hi, true)
  view.setUint32(off, ms - hi * TWO_32, true)
}

function readI64 (view, off) {
  return view.getInt32(off + 4, true) * TWO_32 + view.getUint32(off, true)
}

function encode (doc) {
  const d = trim(doc)
  const out = b4a.alloc(SEEN_PLAIN_BYTES)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const pageKeys = Object.keys(d.avisos.pages)
  let off = 0
  out[off++] = SEEN_VERSION
  out[off++] = 0
  view.setUint32(off, d.gen, true); off += 4
  out.set(b4a.from(d.member, 'hex'), off); off += 32
  out.set(b4a.from(d.association, 'hex'), off); off += 32
  view.setUint16(off, d.avisos.own.length, true); off += 2
  out[off++] = pageKeys.length
  view.setUint16(off, d.dm.length, true); off += 2
  out[off++] = d.groups.length
  out[off++] = d.blocks.length
  out[off++] = d.testimonials.length

  const putTokens = (list) => {
    for (const e of list) {
      out.set(b4a.from(e.token, 'hex'), off); off += TOKEN_BYTES
      view.setUint32(off, e.t, true); off += 4
    }
  }

  putTokens(d.avisos.own)
  for (const key of pageKeys) {
    const list = d.avisos.pages[key]
    out.set(b4a.from(key.slice(PAGE_PREFIX.length), 'hex'), off); off += 32
    out[off++] = list.length
    putTokens(list)
  }
  putTokens(d.dm)
  for (const m of d.groups) {
    out.set(b4a.from(m.group, 'hex'), off); off += 32
    out.set(b4a.from(m.writer, 'hex'), off); off += 32
    writeI64(view, off, Date.parse(m.at)); off += 8
    view.setUint32(off, m.seq, true); off += 4
  }
  for (const e of d.blocks) {
    out.set(b4a.from(e.key, 'hex'), off); off += 32
    out[off++] = e.on ? 1 : 0
    view.setUint32(off, e.t, true); off += 4
  }
  for (const e of d.testimonials) {
    out.set(b4a.from(e.from, 'hex'), off); off += 32
    view.setUint32(off, e.seq, true); off += 4
    out[off++] = e.state === 'kept' ? 1 : 2
    view.setUint32(off, e.t, true); off += 4
  }
  if (off < SEEN_PLAIN_BYTES) sodium.randombytes_buf(out.subarray(off))
  return out
}

// Never throws: the bytes come from the service and any device of the
// member. Returns null on anything invalid, { unsupported: true } on a
// version this code does not know.
function decode (bytes, expect) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== SEEN_PLAIN_BYTES) return null
    if (!expect || !isHex64(expect.member) || !isHex64(expect.association)) return null
    const version = bytes[0]
    if (version !== SEEN_VERSION && version !== SEEN_VERSION_2 && version !== SEEN_VERSION_1) return { unsupported: true }
    if (bytes[1] !== 0) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const hex = (a, n) => b4a.toString(bytes.subarray(a, a + n), 'hex')
    let off = 2
    const gen = view.getUint32(off, true); off += 4
    const member = hex(off, 32); off += 32
    const association = hex(off, 32); off += 32
    if (member !== expect.member || association !== expect.association) return null
    const nAvisos = view.getUint16(off, true); off += 2
    const nPages = bytes[off++]
    const nDm = view.getUint16(off, true); off += 2
    const nGroups = bytes[off++]
    const nBlocks = version === SEEN_VERSION_1 ? 0 : bytes[off++]
    const nTestimonials = version === SEEN_VERSION ? bytes[off++] : 0
    const dmMax = version === SEEN_VERSION ? SYNC_DM_MAX : version === SEEN_VERSION_2 ? SYNC_DM_MAX_V2 : SYNC_DM_MAX_V1
    if (nAvisos > SYNC_AVISOS_MAX || nPages > SYNC_PAGES_MAX || nDm > dmMax || nGroups > SYNC_GROUPS_MAX ||
        nBlocks > SYNC_BLOCKS_MAX || nTestimonials > SYNC_TESTIMONIALS_MAX) return null

    const need = (n) => {
      if (off + n > SEEN_PLAIN_BYTES) throw new RangeError('short')
    }
    const getTokens = (n) => {
      need(n * TOKEN_ENTRY_BYTES)
      const by = new Map()
      for (let i = 0; i < n; i++) {
        const token = hex(off, TOKEN_BYTES); off += TOKEN_BYTES
        const t = view.getUint32(off, true); off += 4
        const prev = by.get(token)
        if (prev === undefined || t > prev) by.set(token, t)
      }
      return sortTokens(by)
    }

    const own = getTokens(nAvisos)
    const pages = new Map()
    for (let i = 0; i < nPages; i++) {
      need(PAGE_HEAD_BYTES)
      const key = PAGE_PREFIX + hex(off, 32); off += 32
      const n = bytes[off++]
      if (n > SYNC_PAGE_TOKENS_MAX) return null
      const list = getTokens(n)
      pages.set(key, pages.has(key) ? unionTokens(pages.get(key), list) : list)
    }
    const dm = getTokens(nDm)
    need(nGroups * GROUP_ENTRY_BYTES)
    const groups = new Map()
    for (let i = 0; i < nGroups; i++) {
      const group = hex(off, 32); off += 32
      const writer = hex(off, 32); off += 32
      const ms = readI64(view, off); off += 8
      const seq = view.getUint32(off, true); off += 4
      if (!Number.isSafeInteger(ms) || Math.abs(ms) > MAX_DATE_MS) return null
      const at = new Date(ms).toISOString()
      if (!isCanonicalIso(at)) return null
      const mark = { group, at, writer, seq }
      const prev = groups.get(group)
      groups.set(group, prev === undefined ? mark : groupAhead(prev, mark))
    }
    need(nBlocks * BLOCK_ENTRY_BYTES)
    const blocks = []
    for (let i = 0; i < nBlocks; i++) {
      const key = hex(off, 32); off += 32
      const on = bytes[off++]
      const t = view.getUint32(off, true); off += 4
      if (on !== 0 && on !== 1) return null
      blocks.push({ key, on: on === 1, t })
    }
    need(nTestimonials * TESTIMONIAL_ENTRY_BYTES)
    const testimonials = []
    for (let i = 0; i < nTestimonials; i++) {
      const from = hex(off, 32); off += 32
      const seq = view.getUint32(off, true); off += 4
      const state = bytes[off++]
      const t = view.getUint32(off, true); off += 4
      if (seq === 0 || (state !== 1 && state !== 2)) return null
      testimonials.push({ from, seq, state: state === 1 ? 'kept' : 'declined', t })
    }
    // canonical() cuts a version 1 or 2 dm list to the version 3 window.
    return canonical(gen, member, association, own, pages, dm, sortGroups(groups), normalizeBlocks(blocks), normalizeDecisions(testimonials))
  } catch {
    return null
  }
}

function checkKey (key) {
  if (!(key instanceof Uint8Array) || key.byteLength !== SEEN_KEY_BYTES) throw new TypeError('key must be 32 bytes')
}

function seal (doc, key) {
  checkKey(key)
  const plain = encode(doc)
  const out = b4a.alloc(SEEN_BLOB_BYTES)
  const nonce = out.subarray(0, SEEN_NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  sodium.crypto_secretbox_easy(out.subarray(SEEN_NONCE_BYTES), plain, nonce, key)
  sodium.sodium_memzero(plain)
  return out
}

function open (blob, key, expect) {
  try {
    if (!(blob instanceof Uint8Array) || blob.byteLength !== SEEN_BLOB_BYTES) return null
    if (!(key instanceof Uint8Array) || key.byteLength !== SEEN_KEY_BYTES) return null
    const plain = b4a.alloc(SEEN_PLAIN_BYTES)
    const ok = sodium.crypto_secretbox_open_easy(plain, blob.subarray(SEEN_NONCE_BYTES), blob.subarray(0, SEEN_NONCE_BYTES), key)
    if (!ok) return null
    const doc = decode(plain, expect)
    sodium.sodium_memzero(plain)
    return doc
  } catch {
    return null
  }
}

function contentKey (d) {
  return JSON.stringify([d.avisos.own, d.avisos.pages, d.dm, d.groups, d.blocks, d.testimonials])
}

// Compares the trimmed contents; gen is a write counter, not content.
function sameContent (a, b) {
  return contentKey(trim(a)) === contentKey(trim(b))
}

// The union is taken before any cap: capping each side first would drop a
// page (or a mark that is ahead) that the other side's marks keep.
function merge (local, remote) {
  const l = normalize(local)
  const r = normalize(remote)
  if (l.member !== r.member || l.association !== r.association) throw new TypeError('merge across members')
  const pages = new Map(l.pages)
  for (const [key, list] of r.pages) {
    pages.set(key, pages.has(key) ? unionTokens(pages.get(key), list) : list)
  }
  const doc = canonical(
    Math.min(Math.max(l.gen, r.gen) + 1, U32_MAX),
    l.member,
    l.association,
    unionTokens(l.own, r.own),
    pages,
    unionTokens(l.dm, r.dm),
    unionGroups(l.groups, r.groups),
    mergeBlocks(l.blocks, r.blocks),
    mergeDecisions(l.testimonials, r.testimonials)
  )
  return { doc, localOnly: contentKey(doc) !== contentKey(capped(r)) }
}

module.exports = {
  SEEN_VERSION,
  SEEN_PLAIN_BYTES,
  SEEN_NONCE_BYTES,
  SEEN_MAC_BYTES,
  SEEN_BLOB_BYTES,
  SEEN_BLOB_B64,
  SEEN_KEY_BYTES,
  SYNC_AVISOS_MAX,
  SYNC_PAGES_MAX,
  SYNC_PAGE_TOKENS_MAX,
  SYNC_DM_MAX,
  SYNC_DM_MAX_V2,
  SYNC_DM_MAX_V1,
  SYNC_GROUPS_MAX,
  SYNC_BLOCKS_MAX,
  SYNC_TESTIMONIALS_MAX,
  MERGE_AVISOS_MAX,
  MERGE_PAGE_TOKENS_MAX,
  HEADER_BYTES,
  TOKEN_ENTRY_BYTES,
  PAGE_HEAD_BYTES,
  GROUP_ENTRY_BYTES,
  BLOCK_ENTRY_BYTES,
  TESTIMONIAL_ENTRY_BYTES,
  seenKeyFromSeed,
  trim,
  encode,
  decode,
  seal,
  open,
  merge,
  sameContent
}
