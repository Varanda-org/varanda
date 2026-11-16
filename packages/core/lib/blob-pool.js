'use strict'

// The seeder's blob pool (docs/protocol.md section 13): the stamped chunks
// of encrypted DM media (lib/blob.js) under <dir>/blobs/, kept for
// retentionMs from the first chunk and then swept. The pool never holds a
// key or a nonce, and never learns who put a blob or who will fetch it. No id,
// token or address is ever logged: logs carry counts and fixed reasons.
//
// Layout:
//   blobs/<id hex>/meta.json   { v: 2, count, receivedAt }
//   blobs/<id hex>/acks        one ACK_BYTES record per acked chunk
//   blobs/<id hex>/<index>     the whole chunk frame (BLOB_FRAME_BYTES)
//   blobs/tokens.json          { v: 1, tokens: [{ h, at, kid }] }
// acks is created empty and fsynced, then meta.json is written atomically,
// before the first chunk. Each chunk is written to a temporary name, fsynced
// and renamed, then its record [index u16be | kid 8 | token hash 32 | frame
// hash 32] is written into acks and fsynced, and only then is it acked. The
// journal is what the pool acked, so a load never takes a file's word for it:
// an acked chunk whose file is gone or no longer the recorded frame (a token,
// kid or signature changed at rest included) breaks its blob, and its token
// stays spent from the record. A valid chunk without a record was written but
// never acked (a crash between the rename and the record): the load records
// it. A put that fails after the rename removes its chunk, first cutting
// acks back to its whole records when its record was being written; when
// that cut fails too, the chunk stays, and the load finds it with its record
// or unrecorded. A meta.json of v: 1 (no journal) is the earlier layout, read
// as before until its blob ages out.
// receivedAt is the arrival of the blob's first chunk and is never refreshed:
// not by a later chunk, not by a repeated put. A blob past its retention (or
// past partialMs while incomplete) is neither read nor added to, even before
// the sweep removes it: a put for it sweeps first.
//
// The pool counts the chunks it actually stores, BLOB_CHUNK_BYTES each, never
// a blob's declared count: a put is answered 'cheio' when storing its chunk
// would take that total over maxBytes. Nothing is reserved ahead, so a blob
// declaring many chunks costs only what it sends, and an upload can be
// answered 'cheio' half way when the pool fills (the sender keeps its frames;
// the partial blob is swept). A blob is readable only once all its chunks are
// stored. An incomplete blob is swept partialMs (an hour by default) after its
// first chunk.
//
// A chunk is accepted once: an identical frame already stored is a repeated
// success without a new stamp check (a user's retry of an uncertain put,
// even once its key aged out); another frame for a stored (id, index), a
// count that differs from the blob's and a spent stamp token are refused.
// Stamps are checked through verifyStamp(kidHex, token, sig), which the
// seeder binds to its blob stamp key.
//
// Spent tokens outlive their chunks, as in lib/dm-pool.js: a token hash stays
// while verifyStamp could still accept its stamp. A hash goes only when it is
// older than tokenRetentionMs AND isKidAccepted(kid) says its key is no
// longer accepted. The tokens of stored chunks are read back from the acks
// records and the frames at load; tokens.json holds the rest, and the pool writes it before it
// deletes any chunk (a sweep, a load, a broken blob), so a hash is never on
// disk only inside a deleted file.
//
// Restart recovery: temporary files are removed, a blob directory without a
// readable meta.json and a valid frame filed under another blob, index or
// count are removed (the tokens of any frame found are written to tokens.json
// first), and a receivedAt more than a day ahead of the clock is rewritten as
// the load time.
//
// Chunk files are fsynced and renamed into place, so a stored chunk whose file
// is missing, short or not the frame that was acked means disk corruption or
// tampering. Its blob is broken: every token of it stays spent (tokens.json is
// written first) and the whole directory is removed, at load, on a read or on
// a put. Readers then miss the blob and the sender sends it again under a new
// seal. A blob whose directory cannot be removed (a sweep or a broken blob)
// still counts against maxBytes, is no longer served, and the next sweep tries
// again.
//
// A blob directory is removed meta.json first, then its chunk files, then the
// directory, after its tokens are in tokens.json. A crash midway leaves a
// directory without meta.json, which the next load removes; it never leaves a
// meta.json whose blob lost chunks that were acked.
//
// Retention is never cut short on request, with one exception: the seeder
// purges the blobs a blocked diary's momentos name (purge(ids)).
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const fs = require('#fs')
const path = require('#path')
const { writeJsonAtomic } = require('./store')
const { BLOB_CHUNK_BYTES, BLOB_FRAME_BYTES, BLOB_MAX_CHUNKS, BLOB_RETENTION_MS, BLOB_POOL_BYTES, decodeChunk } = require('./blob')

const BLOBS_DIR = 'blobs'
const META_FILE = 'meta.json'
const ACKS_FILE = 'acks'
const TOKENS_FILE = 'tokens.json'
const META_V = 2
const ACK_BYTES = 2 + 8 + 32 + 32
const BLOB_SWEEP_MS = 60000
const BLOB_PARTIAL_MS = 60 * 60 * 1000
const FILE_MODE = 0o600
const DIR_MODE = 0o700
const HEX64 = /^[0-9a-f]{64}$/
const HEX16 = /^[0-9a-f]{16}$/
const INDEX_NAME = /^(0|[1-9][0-9]{0,2})$/
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000
const FSYNC_DIR_IGNORED = new Set(['EISDIR', 'EPERM', 'EINVAL'])

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function tokenHash (token) {
  return hex(hcrypto.hash(token))
}

function writeFull (fd, buf, pos = 0) {
  let off = 0
  while (off < buf.byteLength) off += fs.writeSync(fd, buf, off, buf.byteLength - off, pos + off)
}

function ackRecord (index, rec) {
  const out = b4a.alloc(ACK_BYTES)
  out[0] = index >> 8
  out[1] = index & 0xff
  out.set(b4a.from(rec.kid, 'hex'), 2)
  out.set(b4a.from(rec.token, 'hex'), 10)
  out.set(b4a.from(rec.frame, 'hex'), 42)
  return out
}

// The records of an acks file: { records, whole, bad, rewrite } (records maps
// an index to { token, kid, frame }). A record outside count or two different
// records for one index make it bad; a partial last record (a crash while
// writing it, never acked) or a repeated one asks for a rewrite.
// records holds one record per index; every holds each whole record, a
// contradictory or out of range one included, so the tokens of a blob that
// breaks over its journal still stay spent.
function parseAcks (buf, count) {
  const records = new Map()
  const every = []
  const whole = Math.floor(buf.byteLength / ACK_BYTES)
  let bad = false
  let rewrite = buf.byteLength % ACK_BYTES !== 0
  for (let i = 0; i < whole; i++) {
    const o = i * ACK_BYTES
    const index = buf[o] * 256 + buf[o + 1]
    const rec = {
      kid: hex(buf.subarray(o + 2, o + 10)),
      token: hex(buf.subarray(o + 10, o + 42)),
      frame: hex(buf.subarray(o + 42, o + ACK_BYTES))
    }
    every.push(rec)
    const prev = records.get(index)
    if (index >= count || (prev !== undefined && (prev.token !== rec.token || prev.frame !== rec.frame || prev.kid !== rec.kid))) bad = true
    else if (prev !== undefined) rewrite = true
    else records.set(index, rec)
  }
  return { records, every, whole, bad, rewrite }
}

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

function isTmpName (name) {
  return name.startsWith('.') && name.endsWith('.tmp')
}

function idHexOf (id) {
  if (typeof id === 'string') return HEX64.test(id) ? id : null
  if (id instanceof Uint8Array && id.byteLength === 32) return hex(id)
  return null
}

function createBlobPool (opts = {}) {
  const {
    dir,
    now = Date.now,
    retentionMs = BLOB_RETENTION_MS,
    partialMs = Math.min(BLOB_PARTIAL_MS, retentionMs),
    tokenRetentionMs = 2 * retentionMs,
    maxBytes = BLOB_POOL_BYTES,
    verifyStamp,
    isKidAccepted = () => false,
    onStored = noop,
    log = noop,
    sweepMs = BLOB_SWEEP_MS
  } = opts
  if (typeof dir !== 'string' || dir === '') throw new TypeError('invalid dir')
  if (typeof now !== 'function' || typeof verifyStamp !== 'function' || typeof isKidAccepted !== 'function' ||
      typeof onStored !== 'function' || typeof log !== 'function') {
    throw new TypeError('now, verifyStamp, isKidAccepted, onStored and log must be functions')
  }
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new TypeError('invalid retentionMs')
  if (!Number.isSafeInteger(partialMs) || partialMs < 1 || partialMs > retentionMs) throw new TypeError('invalid partialMs')
  if (!Number.isSafeInteger(tokenRetentionMs) || tokenRetentionMs < retentionMs) throw new TypeError('invalid tokenRetentionMs')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < BLOB_CHUNK_BYTES) throw new TypeError('invalid maxBytes')
  if (!Number.isSafeInteger(sweepMs) || sweepMs < 0) throw new TypeError('invalid sweepMs')

  const poolDir = path.join(dir, BLOBS_DIR)
  const tokensFile = path.join(poolDir, TOKENS_FILE)

  // id hex -> { count, receivedAt, expired, chunks }; chunks maps an index to
  // { token, kid, frame } (frame: hash of the stored frame).
  const blobs = new Map()
  // Every spent token hash, stored chunks' included: h -> { at, kid }.
  const byToken = new Map()
  // BLOB_CHUNK_BYTES per chunk held on disk, expired blobs' included.
  let stored = 0
  // A tokens.json write that failed and is still owed to the next sweep.
  let tokensDirty = false
  let closed = false
  let timer = null

  load()
  if (sweepMs > 0) {
    timer = setInterval(tick, sweepMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  return {
    submit,
    info,
    read,
    purge,
    sweep,
    close,
    get size () { return blobs.size },
    get bytes () { return stored }
  }

  function usable () {
    if (closed) throw new Error('blob pool closed')
  }

  function nowMs () {
    return Math.max(0, Math.floor(now()))
  }

  function blobDir (idHex) {
    return path.join(poolDir, idHex)
  }

  function readJsonFile (file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err
      return null
    }
  }

  function readDirNames (d) {
    try {
      return fs.readdirSync(d)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
      throw err
    }
  }

  function spend (h, at, kid) {
    const prev = byToken.get(h)
    if (prev === undefined) byToken.set(h, { at, kid })
    else byToken.set(h, { at: Math.max(prev.at, at), kid: prev.kid === null ? kid : prev.kid })
  }

  function readFrameFile (file) {
    try {
      const buf = fs.readFileSync(file)
      return buf.byteLength === BLOB_FRAME_BYTES ? buf : null
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  function load () {
    fs.mkdirSync(poolDir, { recursive: true, mode: DIR_MODE })
    const loadNow = nowMs()
    const head = readJsonFile(tokensFile)
    if (head !== null && typeof head === 'object' && Array.isArray(head.tokens)) {
      for (const t of head.tokens) {
        if (t !== null && typeof t === 'object' && typeof t.h === 'string' && HEX64.test(t.h) &&
            Number.isSafeInteger(t.at) && t.at >= 0) {
          spend(t.h, t.at, typeof t.kid === 'string' && HEX16.test(t.kid) ? t.kid : null)
        }
      }
    }

    // Frames are only read here; every file that may hold a token is deleted
    // after tokens.json is written below.
    const tornFiles = []
    const badDirs = []
    const brokenDirs = []
    const clamped = []
    const journals = []
    for (const name of readDirNames(poolDir) || []) {
      if (isTmpName(name)) {
        unlinkQuiet(path.join(poolDir, name))
        continue
      }
      if (!HEX64.test(name)) continue
      const d = blobDir(name)
      const names = readDirNames(d)
      if (names === null) continue
      const meta = readJsonFile(path.join(d, META_FILE))
      const valid = meta !== null && typeof meta === 'object' && (meta.v === 1 || meta.v === META_V) &&
        Number.isInteger(meta.count) && meta.count >= 1 && meta.count <= BLOB_MAX_CHUNKS &&
        Number.isSafeInteger(meta.receivedAt) && meta.receivedAt >= 0
      const receivedAt = valid && meta.receivedAt <= loadNow + FUTURE_SLACK_MS ? meta.receivedAt : loadNow
      // undefined for a v1 blob; null when a v2 blob lost its journal, which
      // only corruption or tampering explains.
      const acks = valid && meta.v === META_V ? readAcks(path.join(d, ACKS_FILE), meta.count) : undefined
      const chunks = new Map()
      let broken = acks === null || (acks !== undefined && acks.bad)
      let rewrite = acks ? acks.rewrite : false
      if (acks) {
        for (const r of acks.every) spend(r.token, receivedAt, r.kid)
      }
      for (const f of names) {
        if (f === META_FILE || f === ACKS_FILE) continue
        const file = path.join(d, f)
        if (isTmpName(f) || !INDEX_NAME.test(f)) {
          unlinkQuiet(file)
          continue
        }
        const frame = readFrameFile(file)
        const chunk = frame === null ? null : decodeChunk(frame)
        if (chunk !== null) spend(tokenHash(chunk.token), receivedAt, hex(chunk.kid))
        const rec = acks ? acks.records.get(Number(f)) : undefined
        if (chunk === null && (rec !== undefined || (acks === undefined && valid && Number(f) < meta.count))) {
          broken = true
          continue
        }
        if (!valid || chunk === null || hex(chunk.id) !== name || chunk.count !== meta.count || String(chunk.index) !== f) {
          if (rec !== undefined) broken = true
          else tornFiles.push(file)
          continue
        }
        const got = { token: tokenHash(chunk.token), kid: hex(chunk.kid), frame: frameHash(frame) }
        if (rec !== undefined && (rec.token !== got.token || rec.frame !== got.frame)) {
          broken = true
          continue
        }
        if (acks && rec === undefined) rewrite = true
        chunks.set(chunk.index, got)
      }
      if (!valid) {
        badDirs.push(name)
        continue
      }
      if (acks) {
        for (const index of acks.records.keys()) {
          if (!chunks.has(index)) broken = true
        }
      }
      const acked = acks ? (rewrite ? chunks.size : acks.whole) : 0
      blobs.set(name, { v: meta.v, count: meta.count, receivedAt, expired: broken, chunks, acked })
      stored += chunks.size * BLOB_CHUNK_BYTES
      if (broken) {
        brokenDirs.push(name)
        continue
      }
      if (rewrite) journals.push(name)
      if (receivedAt !== meta.receivedAt) clamped.push(name)
    }

    if (tornFiles.length > 0 || badDirs.length > 0 || brokenDirs.length > 0) writeTokens(new Set())
    for (const file of tornFiles) unlinkQuiet(file)
    for (const name of badDirs) removeBlobDir(name)
    for (const name of brokenDirs) removeBroken(name)
    for (const name of journals) {
      const blob = blobs.get(name)
      const records = [...blob.chunks.keys()].sort((a, b) => a - b).map((i) => ackRecord(i, blob.chunks.get(i)))
      writeFileAtomic(blobDir(name), ACKS_FILE, b4a.concat(records))
    }
    for (const name of clamped) {
      const blob = blobs.get(name)
      writeJsonAtomic(path.join(blobDir(name), META_FILE), { v: blob.v, count: blob.count, receivedAt: blob.receivedAt }, FILE_MODE)
    }
    if (tornFiles.length > 0) log({ event: 'blob-pool-torn', chunks: tornFiles.length })
    if (brokenDirs.length > 0) log({ event: 'blob-pool-broken', blobs: brokenDirs.length })
  }

  function readAcks (file, count) {
    let buf
    try {
      buf = fs.readFileSync(file)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') return null
      throw err
    }
    return parseAcks(buf, count)
  }

  function frameHash (frame) {
    return hex(hcrypto.hash(frame))
  }

  // Writes every spent hash of tokens that is not the token of a stored
  // chunk of a live blob, skipping the blobs in skip (a sweep's expired ones).
  function writeTokens (skip, tokens = byToken) {
    const live = new Set()
    for (const [idHex, blob] of blobs) {
      if (blob.expired || skip.has(idHex)) continue
      for (const c of blob.chunks.values()) live.add(c.token)
    }
    const spent = []
    for (const [h, tok] of tokens) {
      if (live.has(h)) continue
      spent.push({ h, at: tok.at, kid: tok.kid })
    }
    writeJsonAtomic(tokensFile, { v: 1, tokens: spent }, FILE_MODE)
    tokensDirty = false
  }

  // Whether frame (null for a missing or short file) is the chunk the pool
  // acked as index of idHex.
  function isStoredFrame (idHex, blob, index, frame) {
    if (frame === null) return false
    const chunk = decodeChunk(frame)
    const rec = blob.chunks.get(index)
    return chunk !== null && rec !== undefined && hex(chunk.id) === idHex && chunk.index === index &&
      chunk.count === blob.count && tokenHash(chunk.token) === rec.token && frameHash(frame) === rec.frame
  }

  // A stored chunk turned out damaged: the blob stops being served at once,
  // its tokens are written to tokens.json and its directory goes. If either
  // step fails the blob still counts and the next sweep finishes the job.
  function dropBroken (idHex, blob) {
    blob.expired = true
    const at = nowMs()
    for (const c of blob.chunks.values()) spend(c.token, at, c.kid)
    log({ event: 'blob-pool-broken', blobs: 1 })
    try {
      writeTokens(new Set())
    } catch {
      tokensDirty = true
      return
    }
    removeBroken(idHex)
  }

  function removeBroken (idHex) {
    const blob = blobs.get(idHex)
    try {
      removeBlobDir(idHex)
    } catch {
      return
    }
    blobs.delete(idHex)
    stored -= blob.chunks.size * BLOB_CHUNK_BYTES
  }

  function unlinkQuiet (file) {
    try { fs.unlinkSync(file) } catch {}
  }

  // meta.json first, so a directory left half removed by a crash has no
  // meta.json and the next load removes the rest instead of restoring a blob
  // that lost acked chunks.
  function removeBlobDir (idHex) {
    const d = blobDir(idHex)
    try {
      fs.unlinkSync(path.join(d, META_FILE))
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err
    }
    const names = readDirNames(d) || []
    for (const f of names) {
      try {
        fs.unlinkSync(path.join(d, f))
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
    try {
      fs.rmdirSync(d)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  function complete (blob) {
    return blob.chunks.size === blob.count
  }

  // Broken, or past its retention (partialMs while incomplete) by the clock,
  // whether or not a sweep has removed it yet.
  function gone (blob, t) {
    return blob.expired || blob.receivedAt + (complete(blob) ? retentionMs : partialMs) <= t
  }

  // An empty journal, fsynced, before meta.json names the blob as v2.
  function createAcks (d) {
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
    const fd = fs.openSync(path.join(d, ACKS_FILE), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  // Writes rec at the slot after the last whole record, so a failed write is
  // overwritten by the next one instead of shifting every later record.
  function appendAck (idHex, blob, index, rec) {
    const fd = fs.openSync(path.join(blobDir(idHex), ACKS_FILE), fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW)
    try {
      writeFull(fd, ackRecord(index, rec), blob.acked * ACK_BYTES)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    blob.acked++
  }

  // Cuts acks back to its whole records after a failed appendAck. false
  // when that fails too: the record may then still be on disk.
  function dropAck (idHex, blob) {
    try {
      const fd = fs.openSync(path.join(blobDir(idHex), ACKS_FILE), fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW)
      try {
        fs.ftruncateSync(fd, blob.acked * ACK_BYTES)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      return true
    } catch {
      return false
    }
  }

  function writeFileAtomic (d, name, bytes) {
    const file = path.join(d, name)
    const tmp = path.join(d, '.' + name + '.' + hex(hcrypto.randomBytes(6)) + '.tmp')
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
    const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE)
    let renamed = false
    try {
      try {
        writeFull(fd, bytes)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, file)
      renamed = true
    } finally {
      if (!renamed) unlinkQuiet(tmp)
    }
    fsyncDir(d)
  }

  // { ok: true, complete } | { ok: true, complete, repeated: true } | null |
  // 'cheio'. Never throws on what a peer sent; a disk failure throws (the
  // channel then answers nothing and the put stays uncertain).
  function submit (bytes) {
    usable()
    const chunk = decodeChunk(bytes)
    if (chunk === null) return null
    const idHex = hex(chunk.id)
    let blob = blobs.get(idHex)
    if (blob !== undefined && !blob.expired && gone(blob, nowMs())) {
      sweep()
      blob = blobs.get(idHex)
    }
    if (blob !== undefined) {
      if (blob.expired || blob.count !== chunk.count) return null
      if (blob.chunks.has(chunk.index)) {
        const stored = readFrameFile(path.join(blobDir(idHex), String(chunk.index)))
        if (isStoredFrame(idHex, blob, chunk.index, stored)) {
          return b4a.equals(stored, bytes) ? { ok: true, complete: complete(blob), repeated: true } : null
        }
        dropBroken(idHex, blob)
        blob = blobs.get(idHex)
        if (blob !== undefined) return null
      }
    }
    let stamped = false
    try {
      stamped = verifyStamp(hex(chunk.kid), chunk.token, chunk.sig) === true
    } catch {}
    if (!stamped) return null
    const token = tokenHash(chunk.token)
    if (byToken.has(token)) return null

    if (stored + BLOB_CHUNK_BYTES > maxBytes) return 'cheio'
    const at = nowMs()
    const fresh = blob === undefined
    if (fresh) {
      const d = blobDir(idHex)
      fs.mkdirSync(d, { recursive: true, mode: DIR_MODE })
      try {
        // The new directory's entry in blobs/ must be durable before any ack,
        // or a power cut can lose a blob the member was told is stored.
        fsyncDir(poolDir)
        createAcks(d)
        writeJsonAtomic(path.join(d, META_FILE), { v: META_V, count: chunk.count, receivedAt: at }, FILE_MODE)
      } catch (err) {
        try { removeBlobDir(idHex) } catch {}
        throw err
      }
      blob = { v: META_V, count: chunk.count, receivedAt: at, expired: false, chunks: new Map(), acked: 0 }
    }
    const rec = { token, kid: hex(chunk.kid), frame: frameHash(bytes) }
    let recording = false
    try {
      writeFileAtomic(blobDir(idHex), String(chunk.index), bytes)
      if (blob.v === META_V) {
        recording = true
        appendAck(idHex, blob, chunk.index, rec)
      }
    } catch (err) {
      if (fresh) {
        try { removeBlobDir(idHex) } catch {}
      } else if (!recording || dropAck(idHex, blob)) {
        // No record names the chunk (the failure came before it, or it was
        // cut off): the file goes, renamed into place or not, so the disk
        // holds only what is counted.
        unlinkQuiet(path.join(blobDir(idHex), String(chunk.index)))
      }
      // Otherwise the chunk stays next to a record that may have reached
      // the disk: the load finds the two matching, or the chunk unrecorded,
      // and a retry of this index overwrites both.
      throw err
    }
    if (fresh) blobs.set(idHex, blob)
    stored += BLOB_CHUNK_BYTES
    blob.chunks.set(chunk.index, rec)
    spend(token, at, rec.kid)
    onStored()
    return { ok: true, complete: complete(blob) }
  }

  // { count, have, complete } or null for a blob the pool does not hold.
  function info (id) {
    usable()
    const idHex = idHexOf(id)
    const blob = idHex === null ? undefined : blobs.get(idHex)
    if (blob === undefined || gone(blob, nowMs())) return null
    return { count: blob.count, have: blob.chunks.size, complete: complete(blob) }
  }

  // The stored frame of one chunk, or null unless the whole blob is stored.
  function read (id, index) {
    usable()
    const idHex = idHexOf(id)
    const blob = idHex === null ? undefined : blobs.get(idHex)
    if (blob === undefined || gone(blob, nowMs()) || !complete(blob) || !Number.isInteger(index) || !blob.chunks.has(index)) return null
    const frame = readFrameFile(path.join(blobDir(idHex), String(index)))
    if (isStoredFrame(idHex, blob, index, frame)) return frame
    dropBroken(idHex, blob)
    return null
  }

  // Removes the named blobs now, for a blocked author's momentos: each stops
  // being served at once, its tokens stay spent (tokens.json first) and its
  // directory goes. Unknown ids are skipped. When tokens.json or a directory
  // cannot be written or removed, the blobs left stay expired (not served,
  // still counted, retried by the next sweep) and purge throws, because a
  // restart would load them back: the caller keeps its reason to purge.
  // Returns the count removed.
  function purge (ids) {
    usable()
    const named = new Set()
    for (const id of ids) {
      const idHex = idHexOf(id)
      if (idHex !== null && blobs.has(idHex)) named.add(idHex)
    }
    if (named.size === 0) return 0
    for (const idHex of named) blobs.get(idHex).expired = true
    try {
      writeTokens(new Set())
    } catch (err) {
      tokensDirty = true
      throw err
    }
    let removed = 0
    for (const idHex of named) {
      const blob = blobs.get(idHex)
      try {
        removeBlobDir(idHex)
      } catch {
        continue
      }
      blobs.delete(idHex)
      stored -= blob.chunks.size * BLOB_CHUNK_BYTES
      removed++
    }
    if (removed < named.size) {
      log({ event: 'blob-pool-remove-failed', blobs: named.size - removed })
      throw new Error('blob pool purge failed')
    }
    return removed
  }

  // Removes every complete blob older than retentionMs, every incomplete one
  // older than partialMs, and every spent token hash older than
  // tokenRetentionMs whose kid is no longer accepted. A blob whose directory
  // cannot be removed still counts against maxBytes and is tried again by the
  // next sweep. Returns the count of blobs removed.
  function sweep () {
    usable()
    const t = nowMs()
    const expired = new Set()
    for (const [idHex, blob] of blobs) {
      if (gone(blob, t)) expired.add(idHex)
    }
    const live = new Set()
    for (const [idHex, blob] of blobs) {
      if (expired.has(idHex)) continue
      for (const c of blob.chunks.values()) live.add(c.token)
    }
    const tokenCutoff = t - tokenRetentionMs
    const accepted = new Map()
    const kept = new Map()
    for (const [h, tok] of byToken) {
      if (live.has(h) || tok.at >= tokenCutoff || kidAccepted(tok.kid, accepted)) kept.set(h, tok)
    }
    if (expired.size === 0 && kept.size === byToken.size && !tokensDirty) return 0

    writeTokens(expired, kept)
    byToken.clear()
    for (const [h, tok] of kept) byToken.set(h, tok)

    let removed = 0
    let failed = 0
    for (const idHex of expired) {
      const blob = blobs.get(idHex)
      try {
        removeBlobDir(idHex)
      } catch {
        blob.expired = true
        failed++
        continue
      }
      blobs.delete(idHex)
      stored -= blob.chunks.size * BLOB_CHUNK_BYTES
      removed++
    }
    if (failed > 0) log({ event: 'blob-pool-remove-failed', blobs: failed })
    return removed
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

  function tick () {
    if (closed) return
    try {
      sweep()
    } catch {
      log({ event: 'blob-pool-sweep-failed', reason: 'erro' })
    }
  }

  function close () {
    if (closed) return
    closed = true
    if (timer !== null) clearInterval(timer)
    timer = null
  }
}

module.exports = {
  BLOBS_DIR,
  META_FILE,
  ACKS_FILE,
  ACK_BYTES,
  TOKENS_FILE,
  BLOB_SWEEP_MS,
  BLOB_PARTIAL_MS,
  createBlobPool
}
