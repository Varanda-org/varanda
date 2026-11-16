'use strict'

// The seeder's direct message pool (docs/protocol.md section 11): an
// append-only store of fixed-size drops under <dir>/dm-pool/, kept for
// retentionMs and then swept. The pool never learns who wrote a drop or who
// it is for: it stores the drop, a sequence number and the time it arrived,
// and nothing else. No diary key is ever stored or logged here.
//
// log.bin is a run of fixed-size records:
//   uint64be receivedAt || uint32be seq || DM_DROP_BYTES drop bytes
// The top byte of receivedAt carries the bucket tag (docs/protocol.md section
// 11, "Buckets"): 0 for an untagged drop (every record written before the
// tags, every v1 put, a put at 0 bits or with no bucket), else
// (1 << bits) | bucket for bits 1..6 (2..127). receivedAt is the low 56 bits.
// A seeder rolled back to an older build reads a tagged record's time as more
// than a day ahead and takes it as the load time: the record lives up to one
// more retention, is never served wrongly and never crashes it. An untagged
// drop matches every bucket; a tagged one matches a request when the shorter
// of the two prefixes agrees, so a change of the seeder's bits never hides a
// drop.
// head.json is { v: 1, nextSeq, oldestSeq, tokens }, tokens being
// [{ h, at, kid }]: the BLAKE2b-256 hash (hex) of each spent stamp token, the
// time its drop arrived and the stamp's kid (hex, null for an entry from
// before kids were kept). seq.json is { v: 1, nextSeq }, rewritten
// atomically on every append before the ack: the seq high-water mark. The
// log is the truth for the records: load() rebuilds the index from it and
// takes nextSeq as the highest of seq.json, head.json and the last record
// kept plus one, so a seq a member saw is never handed out again, not after
// a sweep empties the log nor after a damaged tail is cut. receivedAt never
// leaves the pool: page() returns the drop bytes and the seq only.
//
// A drop is accepted once: an identical drop still stored is a repeated
// success without a new stamp check (a user's retry of an uncertain put,
// even after its key aged out), a spent stamp token on other bytes is
// refused (one stamp, one drop). Stamps are checked through verifyStamp,
// which the seeder binds to its own public key.
//
// Spent tokens outlive their records. Invariant: a token hash stays while
// verifyStamp could still accept its stamp. A hash goes only when it is
// older than tokenRetentionMs AND isKidAccepted(kid) says its key is no
// longer accepted, so a forward jump of the clock alone forgets nothing
// whose key is still live. Entries without a kid go on age alone, so
// tokenRetentionMs must still cover the key acceptance window (the seeder
// rotates its key every 7 days and accepts the current and the previous
// kid: 14 days, the default 2 * retentionMs).
//
// A sweep that expires records drops them from the index at once but
// rewrites log.bin only when the expired records exceed 1/8 of the log or
// compactAt records: until then they stay in the file, outside the index,
// and a load skips them again. A receivedAt more than a day ahead of the
// clock (a corrupt header) is read as the time of the load.
//
// When log.bin cannot be reopened after the compacted log replaced it, the
// pool is broken: every later call throws, so nothing is acked onto or
// served from an orphaned file.
//
// The seeder keeps a second pool for the quiet visit lane under
// <dir>/visit-pool/ (opts.name = VISIT_POOL_DIR): same format, its own
// files, nothing shared with the DM pool but the stamp keys, with
// retentionMs VISIT_RETENTION_MS and tokenRetentionMs
// VISIT_TOKEN_RETENTION_MS. Two pools
// taking the same stamps are tied by spentElsewhere(h), called with a stamp
// token hash before a new drop is stored: anything but false refuses it, so one stamp
// pays for one drop across both pools. hasSpent(h) answers it for the other.
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const fs = require('#fs')
const path = require('#path')
const { writeJsonAtomic } = require('./store')
const { DM_DROP_BYTES, DM_POOL_MAX, DM_RETENTION_MS, decodeDrop } = require('./dm')

const POOL_DIR = 'dm-pool'
const VISIT_POOL_DIR = 'visit-pool'
// The visit pool keeps pings for 3 days (a visit is news of the week, not
// mail), but remembers each spent stamp as long as the DM pool does
// (2 * DM_RETENTION_MS, its default): a stamp forgotten early here would be
// spendable again in the DM pool, whose spentElsewhere asks this pool.
const VISIT_RETENTION_MS = 3 * 86400000
const VISIT_TOKEN_RETENTION_MS = 2 * DM_RETENTION_MS
const POOL_NAME = /^[a-z][a-z0-9-]{0,31}$/
const LOG_FILE = 'log.bin'
const HEAD_FILE = 'head.json'
const SEQ_FILE = 'seq.json'
const AT_BYTES = 8
const SEQ_BYTES = 4
const RECORD_HEADER = AT_BYTES + SEQ_BYTES
const RECORD_BYTES = RECORD_HEADER + DM_DROP_BYTES
const MAX_SEQ = 0xffffffff
const TAG_MAX = 127
const AT_HIGH_MASK = 0x00ffffff
const FILE_MODE = 0o600
const HEX64 = /^[0-9a-f]{64}$/
const HEX16 = /^[0-9a-f]{16}$/
const DM_POOL_COMPACT_RECORDS = 512
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function readU32 (buf, offset) {
  return ((buf[offset] << 24) >>> 0) + (buf[offset + 1] << 16) + (buf[offset + 2] << 8) + buf[offset + 3]
}

function writeU32 (buf, offset, n) {
  buf[offset] = (n >>> 24) & 0xff
  buf[offset + 1] = (n >>> 16) & 0xff
  buf[offset + 2] = (n >>> 8) & 0xff
  buf[offset + 3] = n & 0xff
}

// fs.readSync and fs.writeSync may move fewer bytes than asked.
function readFull (fd, buf, position) {
  let off = 0
  while (off < buf.byteLength) {
    const n = fs.readSync(fd, buf, off, buf.byteLength - off, position + off)
    if (n === 0) break
    off += n
  }
  return off
}

function writeFull (fd, buf, position) {
  let off = 0
  while (off < buf.byteLength) off += fs.writeSync(fd, buf, off, buf.byteLength - off, position + off)
}

// Makes a just-renamed entry durable (as lib/store.js fsyncDir): platforms
// that cannot fsync a directory fail with EISDIR, EPERM or EINVAL, and only
// those are ignored.
const FSYNC_DIR_IGNORED = new Set(['EISDIR', 'EPERM', 'EINVAL'])

function fsyncDir (dir) {
  let fd
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } catch (err) {
    if (!FSYNC_DIR_IGNORED.has(err.code)) throw err
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

function encodeRecord (receivedAt, seq, bytes, tag = 0) {
  const out = b4a.alloc(RECORD_BYTES)
  writeU32(out, 0, (Math.floor(receivedAt / 0x100000000) & AT_HIGH_MASK) | (tag << 24))
  writeU32(out, 4, receivedAt % 0x100000000)
  writeU32(out, AT_BYTES, seq)
  out.set(bytes, RECORD_HEADER)
  return out
}

// The stored tag for a put at `bits` bits into `bucket` (null: untagged).
function tagFor (bits, bucket) {
  if (bucket === null || bucket === undefined || bits === 0) return 0
  return (1 << bits) | bucket
}

function isTag (n) {
  return Number.isSafeInteger(n) && (n === 0 || (n >= 2 && n <= TAG_MAX))
}

// Whether an entry with `tag` is for one of `buckets` (given at `bits`).
function tagMatches (tag, buckets, bits) {
  if (tag === 0) return true
  const entryBits = 31 - Math.clz32(tag)
  const entryBucket = tag - (1 << entryBits)
  const m = Math.min(entryBits, bits)
  const mine = entryBucket >> (entryBits - m)
  for (const b of buckets) if ((b >> (bits - m)) === mine) return true
  return false
}

function tokenHash (token) {
  return hex(hcrypto.hash(token))
}

function createDmPool (opts = {}) {
  const {
    dir,
    name = POOL_DIR,
    now = Date.now,
    retentionMs = DM_RETENTION_MS,
    tokenRetentionMs = 2 * retentionMs,
    max = DM_POOL_MAX,
    verifyStamp,
    onStored = noop,
    isKidAccepted = () => false,
    spentElsewhere = () => false,
    log = noop,
    compactAt = DM_POOL_COMPACT_RECORDS,
    // Test hook: called with 'head-written' and 'renamed' inside sweep(); a
    // throw there stands for a crash at that point.
    fault = noop
  } = opts
  if (typeof dir !== 'string' || dir === '') throw new TypeError('invalid dir')
  if (typeof name !== 'string' || !POOL_NAME.test(name)) throw new TypeError('invalid name')
  if (typeof spentElsewhere !== 'function') throw new TypeError('spentElsewhere must be a function')
  if (typeof now !== 'function' || typeof verifyStamp !== 'function' || typeof onStored !== 'function' ||
      typeof fault !== 'function' || typeof isKidAccepted !== 'function') {
    throw new TypeError('now, verifyStamp, onStored, isKidAccepted and fault must be functions')
  }
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new TypeError('invalid retentionMs')
  if (!Number.isSafeInteger(tokenRetentionMs) || tokenRetentionMs < retentionMs) throw new TypeError('invalid tokenRetentionMs')
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('invalid max')
  if (!Number.isSafeInteger(compactAt) || compactAt < 1) throw new TypeError('invalid compactAt')

  const poolDir = path.join(dir, name)
  const logFile = path.join(poolDir, LOG_FILE)
  const headFile = path.join(poolDir, HEAD_FILE)
  const seqFile = path.join(poolDir, SEQ_FILE)

  // Index of the records in log.bin, in seq order (the log is appended in
  // seq order). Each entry: { seq, receivedAt, index, dropId, token }, index
  // being the record's position in the file. records counts every record in
  // the file, expired ones not yet compacted away included.
  let entries = []
  let records = 0
  let byDropId = new Map()
  const byToken = new Map()
  let nextSeq = 1
  let fd = null
  let broken = false

  load()

  return {
    submit,
    page,
    sweep,
    close,
    hasSpent,
    get size () { return entries.length },
    get nextSeq () { return nextSeq },
    get oldestSeq () { return oldestSeq() }
  }

  function oldestSeq () {
    return entries.length > 0 ? entries[0].seq : nextSeq
  }

  function usable () {
    if (broken) throw new Error('dm pool broken')
    if (fd === null) throw new Error('dm pool closed')
  }

  function readJsonFile (file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err
      return null
    }
  }

  function seqOf (obj) {
    return obj !== null && typeof obj === 'object' && Number.isSafeInteger(obj.nextSeq) && obj.nextSeq >= 1 ? obj.nextSeq : 1
  }

  function load () {
    fs.mkdirSync(poolDir, { recursive: true, mode: 0o700 })
    const head = readJsonFile(headFile)
    nextSeq = Math.max(seqOf(head), seqOf(readJsonFile(seqFile)))
    // The first form held bare hashes with no time: they count from now, so
    // none is forgotten early. Entries without a kid go on age alone.
    if (head !== null && typeof head === 'object' && Array.isArray(head.tokens)) {
      const loadedAt = Math.max(0, Math.floor(now()))
      for (const t of head.tokens) {
        if (typeof t === 'string' && HEX64.test(t)) {
          spend(t, loadedAt, null)
        } else if (t !== null && typeof t === 'object' && typeof t.h === 'string' && HEX64.test(t.h) &&
            Number.isSafeInteger(t.at) && t.at >= 0) {
          spend(t.h, t.at, typeof t.kid === 'string' && HEX16.test(t.kid) ? t.kid : null)
        }
      }
    }

    let size = 0
    try {
      size = fs.statSync(logFile).size
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    fd = fs.openSync(logFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, FILE_MODE)
    const whole = Math.floor(size / RECORD_BYTES)
    if (whole * RECORD_BYTES !== size) {
      fs.ftruncateSync(fd, whole * RECORD_BYTES)
      log({ event: 'dm-pool-torn', records: whole, bytes: size - whole * RECORD_BYTES })
    }
    const buf = b4a.alloc(RECORD_BYTES)
    const loadNow = Math.max(0, Math.floor(now()))
    const cutoff = loadNow - retentionMs
    let prev = 0
    records = whole
    for (let i = 0; i < whole; i++) {
      const got = readFull(fd, buf, i * RECORD_BYTES)
      const seq = readU32(buf, AT_BYTES)
      const drop = got === RECORD_BYTES ? decodeDrop(buf.subarray(RECORD_HEADER)) : null
      // A short read, a record out of order or not a drop is a damaged log:
      // what follows it cannot be trusted either.
      if (seq <= prev || drop === null) {
        fs.ftruncateSync(fd, i * RECORD_BYTES)
        log({ event: 'dm-pool-torn', records: i, bytes: (whole - i) * RECORD_BYTES })
        records = i
        break
      }
      prev = seq
      const tag = isTag(buf[0]) ? buf[0] : 0
      let receivedAt = (readU32(buf, 0) & AT_HIGH_MASK) * 0x100000000 + readU32(buf, 4)
      if (receivedAt > loadNow + FUTURE_SLACK_MS) receivedAt = loadNow
      const entry = { seq, receivedAt, index: i, dropId: hex(drop.dropId), token: tokenHash(drop.token), kid: hex(drop.kid), tag }
      // An expired record left for a later compaction: its token stays spent.
      if (receivedAt < cutoff) spend(entry.token, entry.receivedAt, entry.kid)
      else index(entry)
    }
    if (prev >= nextSeq) nextSeq = prev + 1
    writeSeq(nextSeq)
    writeHead()
  }

  function writeSeq (n) {
    writeJsonAtomic(seqFile, { v: 1, nextSeq: n }, FILE_MODE)
  }

  function index (entry) {
    entries.push(entry)
    byDropId.set(entry.dropId, entry)
    spend(entry.token, entry.receivedAt, entry.kid)
  }

  function spend (h, at, kid) {
    const prev = byToken.get(h)
    if (prev === undefined) byToken.set(h, { at, kid })
    else byToken.set(h, { at: Math.max(prev.at, at), kid: prev.kid === null ? kid : prev.kid })
  }

  function writeHead (tokens = byToken, oldest = oldestSeq()) {
    writeJsonAtomic(headFile, {
      v: 1,
      nextSeq,
      oldestSeq: oldest,
      tokens: Array.from(tokens, ([h, tok]) => ({ h, at: tok.at, kid: tok.kid }))
    }, FILE_MODE)
  }

  function readDrop (entry) {
    const buf = b4a.alloc(DM_DROP_BYTES)
    if (readFull(fd, buf, entry.index * RECORD_BYTES + RECORD_HEADER) !== DM_DROP_BYTES) {
      throw new Error('dm pool short read')
    }
    return buf
  }

  // { seq } | { seq, repeated: true } | null | 'cheio'. Never throws on what
  // a peer sent; a disk failure throws (the channel then answers nothing).
  function submit (bytes, tag = 0) {
    usable()
    if (!isTag(tag)) throw new TypeError('invalid tag')
    const drop = decodeDrop(bytes)
    if (drop === null) return null
    // The stored copy first: an identical retry is a success even once its
    // stamp's key is no longer accepted.
    const known = byDropId.get(hex(drop.dropId))
    if (known !== undefined) {
      return b4a.equals(readDrop(known), bytes) ? { seq: known.seq, repeated: true } : null
    }
    let stamped = false
    try {
      stamped = verifyStamp(hex(drop.kid), drop.token, drop.rsaSig) === true
    } catch {}
    if (!stamped) return null
    const token = tokenHash(drop.token)
    if (byToken.has(token) || spentElsewhere(token) !== false) return null
    if (entries.length >= max || nextSeq > MAX_SEQ) return 'cheio'

    const receivedAt = Math.max(0, Math.floor(now()))
    const seq = nextSeq
    const entry = { seq, receivedAt, index: records, dropId: hex(drop.dropId), token, kid: hex(drop.kid), tag }
    const record = encodeRecord(receivedAt, seq, bytes, tag)
    // Acked only once the whole record is written and fsynced and the seq
    // high-water mark is past it; a failure cuts the record off and the put
    // gets no ack (a seq.json already past it only skips a seq).
    try {
      writeFull(fd, record, entry.index * RECORD_BYTES)
      fs.fsyncSync(fd)
      writeSeq(seq + 1)
    } catch (err) {
      try { fs.ftruncateSync(fd, entry.index * RECORD_BYTES) } catch {}
      throw err
    }
    nextSeq++
    records++
    index(entry)
    onStored()
    return { seq }
  }

  // { items: [{ seq, bytes }], next, oldest }: the drops after the cursor,
  // oldest first. next is the last seq returned when more follow, else null.
  // With buckets (a list of ints below 2^bits, ascending) only the drops for
  // one of them and the untagged ones come back, and next looks at matching
  // drops only; without buckets (a v1 channel) every drop does. oldest is
  // always the first retained seq of the whole pool, so a gap is still seen.
  function page ({ after = 0, limit = 1, buckets, bits = 0 } = {}) {
    usable()
    if (buckets !== undefined) {
      if (!Array.isArray(buckets) || !Number.isSafeInteger(bits) || bits < 0 || bits > 6 ||
          !buckets.every((b) => Number.isSafeInteger(b) && b >= 0 && b < (1 << bits))) {
        throw new TypeError('invalid buckets')
      }
    }
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('invalid after')
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('invalid limit')
    let lo = 0
    let hi = entries.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (entries[mid].seq <= after) lo = mid + 1
      else hi = mid
    }
    const slice = []
    let more = false
    for (let i = lo; i < entries.length; i++) {
      if (buckets !== undefined && !tagMatches(entries[i].tag, buckets, bits)) continue
      if (slice.length === limit) {
        more = true
        break
      }
      slice.push(entries[i])
    }
    const items = slice.map((e) => ({ seq: e.seq, bytes: readDrop(e) }))
    return { items, next: more ? slice[slice.length - 1].seq : null, oldest: oldestSeq() }
  }

  // Removes every record older than retentionMs and every spent token hash
  // older than tokenRetentionMs whose kid is no longer accepted. Returns the
  // count of records removed.
  //
  // Crash order: the new state is computed first; head.json, which already
  // holds the hashes of the records being removed, is written before the
  // compacted log is renamed over log.bin, so at no point is a hash on disk
  // only inside a record that is gone. In memory nothing changes until the
  // rename succeeded; a throw before it leaves the old log and the old state.
  function sweep () {
    usable()
    const t = now()
    const cutoff = t - retentionMs
    const tokenCutoff = t - tokenRetentionMs
    const accepted = new Map()
    const tokens = new Map()
    for (const [h, tok] of byToken) {
      if (tok.at >= tokenCutoff || kidAccepted(tok.kid, accepted)) tokens.set(h, tok)
    }
    const keep = entries.filter((e) => e.receivedAt >= cutoff)
    const removed = entries.length - keep.length
    if (removed === 0) {
      if (tokens.size !== byToken.size) {
        writeHead(tokens)
        replaceTokens(tokens)
      }
      return 0
    }

    const dead = records - keep.length
    if (dead * 8 <= records && dead < compactAt) {
      writeHead(tokens, keep.length > 0 ? keep[0].seq : nextSeq)
      replaceTokens(tokens)
      entries = keep
      byDropId = new Map(keep.map((e) => [e.dropId, e]))
      return removed
    }

    const tmp = path.join(poolDir, '.' + LOG_FILE + '.' + hex(hcrypto.randomBytes(6)) + '.tmp')
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
    const out = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
    const buf = b4a.alloc(RECORD_BYTES)
    let renamed = false
    try {
      try {
        for (let i = 0; i < keep.length; i++) {
          if (readFull(fd, buf, keep[i].index * RECORD_BYTES) !== RECORD_BYTES) throw new Error('dm pool short read')
          writeFull(out, buf, i * RECORD_BYTES)
        }
        fs.fsyncSync(out)
      } finally {
        fs.closeSync(out)
      }
      writeHead(tokens, keep.length > 0 ? keep[0].seq : nextSeq)
      fault('head-written')
      fs.renameSync(tmp, logFile)
      renamed = true
    } finally {
      if (!renamed) {
        try { fs.unlinkSync(tmp) } catch {}
      }
    }

    // log.bin is now the compacted log: the state follows it even when a
    // later step throws.
    try {
      fault('renamed')
      fsyncDir(poolDir)
    } finally {
      reopen(tokens, keep)
    }
    return removed
  }

  // The old fd is on the replaced file: it is closed whatever happens, and a
  // pool that cannot open the new log.bin is broken for good.
  function reopen (tokens, keep) {
    const old = fd
    fd = null
    try { fs.closeSync(old) } catch {}
    try {
      fd = fs.openSync(logFile, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, FILE_MODE)
    } catch (err) {
      broken = true
      log({ event: 'dm-pool-broken' })
      throw err
    }
    entries = []
    byDropId = new Map()
    records = keep.length
    replaceTokens(tokens)
    for (let i = 0; i < keep.length; i++) index({ ...keep[i], index: i })
  }

  // A throw from isKidAccepted keeps the hash (forgetting is the risk).
  function kidAccepted (kid, cache) {
    if (kid === null) return false
    if (!cache.has(kid)) {
      let ok = true
      try {
        ok = isKidAccepted(kid) !== false
      } catch {}
      cache.set(kid, ok)
    }
    return cache.get(kid)
  }

  function replaceTokens (tokens) {
    byToken.clear()
    for (const [h, tok] of tokens) byToken.set(h, tok)
  }

  // Whether a stamp token hash (hex) is spent here. Never throws.
  function hasSpent (h) {
    return byToken.has(h)
  }

  function close () {
    if (fd === null) return
    fs.closeSync(fd)
    fd = null
  }
}

module.exports = {
  POOL_DIR,
  VISIT_POOL_DIR,
  VISIT_RETENTION_MS,
  VISIT_TOKEN_RETENTION_MS,
  LOG_FILE,
  HEAD_FILE,
  SEQ_FILE,
  RECORD_BYTES,
  DM_POOL_COMPACT_RECORDS,
  tagFor,
  tagMatches,
  createDmPool
}
