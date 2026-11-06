'use strict'

// The seeder's blob pool (lib/blob-pool.js) on a temporary directory. Stamps
// are checked by a stand-in verifyStamp that accepts a marked kid, so no RSA
// key is needed here.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const { createBlobPool, BLOBS_DIR, META_FILE, TOKENS_FILE, BLOB_PARTIAL_MS } = require('../lib/blob-pool')
const { BLOB_CHUNK_BYTES, BLOB_FRAME_BYTES, BLOB_MAX_CHUNKS, encodeChunk, newBlobId } = require('../lib/blob')
const { tmpDir } = require('./helpers/tmp')
const { until } = require('./helpers/net')

const DAY = 86400000
const HOUR = 3600000
const GOOD_KID = b4a.from('00112233aabbccdd', 'hex')
const OLD_KID = b4a.from('ffeeddccbbaa9988', 'hex')

function randomBytes (n) {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

function verifyStamp (kid, token, sig) {
  return (kid === '00112233aabbccdd' || kid === 'ffeeddccbbaa9988') && token.byteLength === 32 && sig.byteLength === 256
}

function blob (count, { id = newBlobId(), kid = GOOD_KID } = {}) {
  const frames = []
  for (let i = 0; i < count; i++) {
    frames.push(encodeChunk({ id, index: i, count, kid, sig: randomBytes(256), token: randomBytes(32), bytes: randomBytes(i === count - 1 ? 100 : BLOB_CHUNK_BYTES) }))
  }
  return { id, frames }
}

// Only the first chunk of a blob that declares count chunks.
function firstChunk (count, id = newBlobId()) {
  return encodeChunk({ id, index: 0, count, kid: GOOD_KID, sig: randomBytes(256), token: randomBytes(32), bytes: randomBytes(BLOB_CHUNK_BYTES) })
}

function clock (start) {
  const c = { t: start }
  c.now = () => c.t
  return c
}

function open (t, dir, extra = {}) {
  const pool = createBlobPool({ dir, verifyStamp, sweepMs: 0, ...extra })
  t.teardown(() => pool.close())
  return pool
}

test('valid put, incomplete blob not readable, persistence across reload', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now })
  const b = blob(3)
  t.alike(pool.submit(b.frames[0]), { ok: true, complete: false })
  t.alike(pool.submit(b.frames[2]), { ok: true, complete: false })
  t.alike(pool.info(b.id), { count: 3, have: 2, complete: false })
  t.is(pool.read(b.id, 0), null, 'incomplete blob is not readable')
  t.is(pool.bytes, 2 * BLOB_CHUNK_BYTES, 'only the stored chunks count')
  t.alike(pool.submit(b.frames[1]), { ok: true, complete: true })
  t.alike(pool.info(b.id), { count: 3, have: 3, complete: true })
  for (let i = 0; i < 3; i++) t.ok(b4a.equals(pool.read(b.id, i), b.frames[i]))
  t.ok(b4a.equals(pool.read(b4a.toString(b.id, 'hex'), 1), b.frames[1]), 'hex id')
  t.is(pool.read(b.id, 3), null)
  t.is(pool.info(newBlobId()), null)
  pool.close()
  t.exception(() => pool.submit(b.frames[0]), /closed/)

  const again = open(t, dir, { now: c.now })
  t.is(again.size, 1)
  t.is(again.bytes, 3 * BLOB_CHUNK_BYTES)
  t.alike(again.info(b.id), { count: 3, have: 3, complete: true })
  t.ok(b4a.equals(again.read(b.id, 2), b.frames[2]))
  t.alike(again.submit(b.frames[0]), { ok: true, complete: true, repeated: true }, 'idempotent after reload')

  const d = path.join(dir, BLOBS_DIR, b4a.toString(b.id, 'hex'))
  t.is(fs.statSync(path.join(d, '0')).mode & 0o777, 0o600)
  t.is(fs.statSync(path.join(d, '0')).size, BLOB_FRAME_BYTES)
  t.is(fs.statSync(path.join(d, META_FILE)).mode & 0o777, 0o600)
  t.is(fs.statSync(d).mode & 0o777, 0o700)
})

test('an identical repeat succeeds without a stamp check and does not refresh expiry', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  let accept = true
  const pool = open(t, dir, { now: c.now, verifyStamp: (...a) => accept && verifyStamp(...a) })
  const b = blob(1)
  t.alike(pool.submit(b.frames[0]), { ok: true, complete: true })
  accept = false
  c.t += 6 * DAY
  t.alike(pool.submit(b.frames[0]), { ok: true, complete: true, repeated: true })
  c.t += DAY
  t.is(pool.sweep(), 1, 'expires 7 days after the first put')
  t.is(pool.info(b.id), null)
})

test('a mismatched re-put and a different count are refused', (t) => {
  const dir = tmpDir(t)
  const pool = open(t, dir)
  const b = blob(2)
  t.ok(pool.submit(b.frames[0]))
  const other = encodeChunk({ id: b.id, index: 0, count: 2, kid: GOOD_KID, sig: randomBytes(256), token: randomBytes(32), bytes: randomBytes(10) })
  t.is(pool.submit(other), null, 'same (id, index), other frame')
  const sameBytesOtherSig = b4a.from(b.frames[0])
  sameBytesOtherSig[50] ^= 1
  t.is(pool.submit(sameBytesOtherSig), null, 'same chunk, other stamp bytes')
  const wrongCount = encodeChunk({ id: b.id, index: 1, count: 3, kid: GOOD_KID, sig: randomBytes(256), token: randomBytes(32), bytes: randomBytes(10) })
  t.is(pool.submit(wrongCount), null)
  t.alike(pool.info(b.id), { count: 2, have: 1, complete: false })
  t.is(pool.read(b.id, 0), null, 'still incomplete')
})

test('a spent token cannot stamp another chunk, in the same blob or another, across a reload', (t) => {
  const dir = tmpDir(t)
  const pool = open(t, dir)
  const token = randomBytes(32)
  const sig = randomBytes(256)
  const first = blob(2)
  const spend = encodeChunk({ id: first.id, index: 0, count: 2, kid: GOOD_KID, sig, token, bytes: randomBytes(100) })
  t.alike(pool.submit(spend), { ok: true, complete: false })
  const sameBlob = encodeChunk({ id: first.id, index: 1, count: 2, kid: GOOD_KID, sig, token, bytes: randomBytes(100) })
  t.is(pool.submit(sameBlob), null, 'the next chunk of the same blob')
  const otherId = newBlobId()
  const otherBlob = encodeChunk({ id: otherId, index: 0, count: 1, kid: GOOD_KID, sig, token, bytes: randomBytes(100) })
  t.is(pool.submit(otherBlob), null, 'a chunk of another blob')
  t.is(pool.info(otherId), null, 'nothing reserved for it')
  t.alike(pool.info(first.id), { count: 2, have: 1, complete: false })
  pool.close()

  const again = open(t, dir)
  t.is(again.submit(otherBlob), null, 'still spent after a reload')
  t.alike(again.submit(first.frames[1]), { ok: true, complete: true }, 'a fresh token still fits the blob')
})

test('bad stamps and truncated frames are refused', (t) => {
  const dir = tmpDir(t)
  const pool = open(t, dir, { verifyStamp: (kid, token, sig) => { if (kid === 'ffeeddccbbaa9988') throw new Error('x'); return verifyStamp(kid, token, sig) } })
  const b = blob(1)
  t.is(pool.submit(b.frames[0].subarray(0, BLOB_FRAME_BYTES - 1)), null, 'truncated')
  t.is(pool.submit(b4a.alloc(10)), null)
  t.is(pool.submit(blob(1, { kid: b4a.alloc(8) }).frames[0]), null, 'stamp refused')
  t.is(pool.submit(blob(1, { kid: OLD_KID }).frames[0]), null, 'a throwing verifier refuses')
  t.is(pool.size, 0)
  t.is(pool.bytes, 0)
  t.alike(fs.readdirSync(path.join(dir, BLOBS_DIR)), [], 'nothing written')
})

test('a spent token is refused after its blob is swept, across a reload, until its key ages out', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  let accepted = new Set(['00112233aabbccdd'])
  const isKidAccepted = (kid) => accepted.has(kid)
  const pool = open(t, dir, { now: c.now, isKidAccepted })
  const b = blob(2)
  t.ok(pool.submit(b.frames[0]))
  t.ok(pool.submit(b.frames[1]))
  c.t += 7 * DAY
  t.is(pool.sweep(), 1)
  t.is(pool.info(b.id), null)
  t.is(pool.submit(b.frames[0]), null, 'replay of a swept chunk refused')
  t.is(pool.size, 0)
  t.ok(fs.existsSync(path.join(dir, BLOBS_DIR, TOKENS_FILE)))
  pool.close()

  const again = open(t, dir, { now: c.now, isKidAccepted })
  t.is(again.submit(b.frames[1]), null, 'still spent after reload')
  c.t += 30 * DAY
  again.sweep()
  t.is(again.submit(b.frames[1]), null, 'kept while the kid is accepted')
  accepted = new Set()
  again.sweep()
  t.alike(again.submit(b.frames[1]), { ok: true, complete: false }, 'forgotten once old and the kid is gone')
})

test('sweep after retention; an incomplete blob goes after partialMs', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now, partialMs: DAY })
  const done = blob(1)
  const part = blob(2)
  t.ok(pool.submit(done.frames[0]))
  t.ok(pool.submit(part.frames[0]))
  c.t += DAY - 1
  t.is(pool.sweep(), 0)
  c.t += 1
  t.is(pool.sweep(), 1)
  t.is(pool.info(part.id), null, 'partial swept')
  t.ok(pool.info(done.id))
  t.absent(fs.existsSync(path.join(dir, BLOBS_DIR, b4a.toString(part.id, 'hex'))))
  c.t += 6 * DAY
  t.is(pool.sweep(), 1)
  t.is(pool.size, 0)
  t.is(pool.bytes, 0)
  t.alike(fs.readdirSync(path.join(dir, BLOBS_DIR)), [TOKENS_FILE])
})

test('the byte cap counts stored chunks and answers cheio for the chunk that would pass it', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now, maxBytes: 3 * BLOB_CHUNK_BYTES })
  const a = blob(2)
  const b = blob(2)
  const small = blob(1)
  t.ok(pool.submit(a.frames[0]))
  t.ok(pool.submit(b.frames[0]), 'a second started blob is taken while chunks fit')
  t.ok(pool.submit(small.frames[0]))
  t.is(pool.bytes, 3 * BLOB_CHUNK_BYTES)
  t.is(pool.submit(a.frames[1]), 'cheio', 'the chunk that would pass the cap')
  t.is(pool.submit(blob(1).frames[0]), 'cheio')
  t.alike(pool.info(a.id), { count: 2, have: 1, complete: false })
  c.t += 7 * DAY
  t.is(pool.sweep(), 3)
  t.is(pool.bytes, 0)
  t.alike(pool.submit(a.frames[1]), { ok: true, complete: false }, 'a cheio chunk keeps its token unspent')
})

test('first chunks of huge declared blobs do not exhaust the pool for another blob', (t) => {
  const dir = tmpDir(t)
  const pool = open(t, dir, { maxBytes: 8 * BLOB_CHUNK_BYTES })
  for (let i = 0; i < 5; i++) {
    t.alike(pool.submit(firstChunk(BLOB_MAX_CHUNKS)), { ok: true, complete: false }, 'one chunk of a declared max blob costs one chunk')
  }
  t.is(pool.bytes, 5 * BLOB_CHUNK_BYTES)
  const other = blob(3)
  for (const f of other.frames) t.ok(pool.submit(f))
  t.alike(pool.info(other.id), { count: 3, have: 3, complete: true }, 'another put still completes')
  t.ok(b4a.equals(pool.read(other.id, 2), other.frames[2]))
  t.is(pool.bytes, 8 * BLOB_CHUNK_BYTES)
  t.is(pool.submit(blob(1).frames[0]), 'cheio', 'refused only once stored bytes would pass the cap')
})

test('a blob refused cheio half way keeps its stored chunks until the partial sweep', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now, maxBytes: 3 * BLOB_CHUNK_BYTES })
  const big = blob(4)
  for (let i = 0; i < 3; i++) t.ok(pool.submit(big.frames[i]))
  t.is(pool.submit(big.frames[3]), 'cheio')
  t.alike(pool.info(big.id), { count: 4, have: 3, complete: false })
  t.is(pool.read(big.id, 0), null, 'never served')
  t.is(pool.bytes, 3 * BLOB_CHUNK_BYTES)
  const d = path.join(dir, BLOBS_DIR, b4a.toString(big.id, 'hex'))
  t.alike(fs.readdirSync(d).sort(), ['0', '1', '2', META_FILE].sort(), 'stored chunks stay on disk')
  c.t += HOUR - 1
  t.is(pool.sweep(), 0)
  t.is(pool.bytes, 3 * BLOB_CHUNK_BYTES)
  c.t += 1
  t.is(pool.sweep(), 1, 'swept as a partial blob')
  t.is(pool.info(big.id), null)
  t.absent(fs.existsSync(d))
  t.is(pool.bytes, 0, 'its space is free again')
  for (let i = 0; i < 3; i++) t.is(pool.submit(big.frames[i]), null, 'its stored frames stay spent')
  t.ok(pool.submit(blob(1).frames[0]))
})

test('an incomplete blob is swept an hour after its first chunk by default', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now })
  t.is(BLOB_PARTIAL_MS, HOUR)
  const part = blob(2)
  const done = blob(1)
  t.ok(pool.submit(part.frames[0]))
  t.ok(pool.submit(done.frames[0]))
  c.t += HOUR - 1
  t.is(pool.sweep(), 0)
  t.ok(pool.info(part.id))
  c.t += 1
  t.is(pool.sweep(), 1)
  t.is(pool.info(part.id), null)
  t.ok(pool.info(done.id), 'a complete blob keeps its full retention')
})

test('a crash after meta.json is removed leaves a directory the next load removes, tokens kept spent', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const logged = []
  const pool = open(t, dir, { now: c.now, log: (e) => logged.push(e) })
  const b = blob(3)
  for (const f of b.frames) t.ok(pool.submit(f))
  const d = path.join(dir, BLOBS_DIR, b4a.toString(b.id, 'hex'))

  // The process dies right after the first file of the directory is unlinked.
  const unlink = fs.unlinkSync
  let removed = 0
  fs.unlinkSync = (file) => {
    if (path.dirname(String(file)) === d && removed++ > 0) throw Object.assign(new Error('crash'), { code: 'EIO' })
    return unlink(file)
  }
  t.teardown(() => { fs.unlinkSync = unlink })
  c.t += 7 * DAY
  t.is(pool.sweep(), 0, 'the removal stopped half way')
  fs.unlinkSync = unlink
  pool.close()
  t.absent(fs.existsSync(path.join(d, META_FILE)), 'meta.json went first')
  t.ok(fs.readdirSync(d).length > 0, 'chunk files are left behind')

  const again = open(t, dir, { now: c.now })
  t.is(again.info(b.id), null, 'not restored as a half blob')
  t.absent(fs.existsSync(d), 'the directory is removed at load')
  t.is(again.bytes, 0)
  for (const f of b.frames) t.is(again.submit(f), null, 'no surviving chunk is acked again')
  again.close()

  const third = open(t, dir, { now: c.now })
  for (const f of b.frames) t.is(third.submit(f), null, 'still spent after a second restart')
})

test('restart recovery removes temporary files, misplaced chunks and directories without meta', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now })
  const b = blob(3)
  t.ok(pool.submit(b.frames[0]))
  t.ok(pool.submit(b.frames[1]))
  const orphan = blob(2)
  t.ok(pool.submit(orphan.frames[0]))
  pool.close()

  const root = path.join(dir, BLOBS_DIR)
  const d = path.join(root, b4a.toString(b.id, 'hex'))
  fs.writeFileSync(path.join(d, '.2.abcdef.tmp'), 'partial')
  fs.writeFileSync(path.join(root, '.tokens.json.1.abc.tmp'), 'partial')
  fs.writeFileSync(path.join(d, '7'), b.frames[0])
  const od = path.join(root, b4a.toString(orphan.id, 'hex'))
  fs.unlinkSync(path.join(od, META_FILE))

  const logged = []
  const again = open(t, dir, { now: c.now, log: (e) => logged.push(e) })
  t.alike(fs.readdirSync(d).sort(), ['0', '1', META_FILE].sort())
  t.absent(fs.existsSync(path.join(root, '.tokens.json.1.abc.tmp')))
  t.absent(fs.existsSync(od), 'directory without meta removed')
  t.alike(again.info(b.id), { count: 3, have: 2, complete: false })
  t.is(again.info(orphan.id), null)
  t.is(again.bytes, 2 * BLOB_CHUNK_BYTES)
  t.is(again.submit(orphan.frames[0]), null, 'a chunk found in a removed directory stays spent')
  t.alike(again.submit(b.frames[1]), { ok: true, complete: false, repeated: true })
  t.alike(again.submit(b.frames[2]), { ok: true, complete: true })
  t.alike(logged, [{ event: 'blob-pool-torn', chunks: 2 }])
  for (const e of logged) t.absent(JSON.stringify(e).includes(b4a.toString(b.id, 'hex')))
})

test('a receivedAt far in the future is read as the load time', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now })
  const b = blob(1)
  t.ok(pool.submit(b.frames[0]))
  pool.close()
  const meta = path.join(dir, BLOBS_DIR, b4a.toString(b.id, 'hex'), META_FILE)
  fs.writeFileSync(meta, JSON.stringify({ v: 1, count: 1, receivedAt: c.t + 365 * DAY }))
  c.t += DAY
  const again = open(t, dir, { now: c.now })
  c.t += 7 * DAY
  t.is(again.sweep(), 1)
})

test('the pool sweeps on its own timer', async (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now, sweepMs: 20 })
  const b = blob(1)
  t.ok(pool.submit(b.frames[0]))
  c.t += 7 * DAY
  await until(() => pool.size === 0, { name: 'timed sweep' })
  t.pass('swept')
})

test('tokens recovered at load stay spent after a second restart', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now })
  const b = blob(2)
  const orphan = blob(1)
  const moved = blob(1)
  t.ok(pool.submit(b.frames[0]))
  t.ok(pool.submit(orphan.frames[0]))
  t.ok(pool.submit(moved.frames[0]))
  pool.close()

  const root = path.join(dir, BLOBS_DIR)
  fs.unlinkSync(path.join(root, b4a.toString(orphan.id, 'hex'), META_FILE))
  const md = path.join(root, b4a.toString(moved.id, 'hex'))
  fs.renameSync(path.join(md, '0'), path.join(root, b4a.toString(b.id, 'hex'), '1'))

  const first = open(t, dir, { now: c.now })
  t.is(first.submit(orphan.frames[0]), null, 'spent after the first restart')
  t.is(first.submit(moved.frames[0]), null)
  first.close()

  const second = open(t, dir, { now: c.now })
  t.is(second.submit(orphan.frames[0]), null, 'a chunk of a removed directory stays spent after a second restart')
  t.is(second.submit(moved.frames[0]), null, 'a frame found in a torn file stays spent after a second restart')
  t.alike(second.info(b.id), { count: 2, have: 1, complete: false })
})

test('a clamped future receivedAt is written back, so a restart does not renew it', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const start = c.t
  const pool = open(t, dir, { now: c.now })
  const b = blob(1)
  t.ok(pool.submit(b.frames[0]))
  pool.close()
  const meta = path.join(dir, BLOBS_DIR, b4a.toString(b.id, 'hex'), META_FILE)
  fs.writeFileSync(meta, JSON.stringify({ v: 1, count: 1, receivedAt: c.t + 365 * DAY }))
  c.t += DAY
  open(t, dir, { now: c.now }).close()
  t.is(JSON.parse(fs.readFileSync(meta, 'utf8')).receivedAt, start + DAY, 'meta.json holds the load time')
  t.is(fs.statSync(meta).mode & 0o777, 0o600)
  c.t += 6 * DAY
  const again = open(t, dir, { now: c.now })
  c.t += DAY
  t.is(again.sweep(), 1, 'expires 7 days after the first clamp')
})

function noIdIn (t, logged, id) {
  for (const e of logged) t.absent(JSON.stringify(e).includes(b4a.toString(id, 'hex')), 'no id logged')
}

test('a short chunk file found by read removes the whole blob and its tokens stay spent across a restart', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const logged = []
  const pool = open(t, dir, { now: c.now, log: (e) => logged.push(e) })
  const b = blob(3)
  for (const f of b.frames) t.ok(pool.submit(f))
  const d = path.join(dir, BLOBS_DIR, b4a.toString(b.id, 'hex'))

  fs.writeFileSync(path.join(d, '1'), b.frames[1].subarray(0, 100))
  t.is(pool.read(b.id, 1), null, 'a short read is null, not a throw')
  t.is(pool.info(b.id), null, 'the blob is gone')
  t.is(pool.read(b.id, 0), null)
  t.absent(fs.existsSync(d), 'the whole directory is removed')
  t.is(pool.size, 0)
  t.is(pool.bytes, 0, 'the reservation is released')
  for (const f of b.frames) t.is(pool.submit(f), null, 'every frame of the blob stays spent')
  t.is(pool.size, 0)
  t.alike(logged, [{ event: 'blob-pool-broken', blobs: 1 }])
  noIdIn(t, logged, b.id)
  pool.close()

  const again = open(t, dir, { now: c.now })
  t.is(again.info(b.id), null)
  for (const f of b.frames) t.is(again.submit(f), null, 'an identical re-put is refused after a restart')
  t.is(again.size, 0)
  const next = blob(1)
  t.alike(again.submit(next.frames[0]), { ok: true, complete: true }, 'a new blob still works')
  t.ok(b4a.equals(again.read(next.id, 0), next.frames[0]))
})

test('a short chunk file found by submit removes the whole blob', (t) => {
  const dir = tmpDir(t)
  const logged = []
  const pool = open(t, dir, { log: (e) => logged.push(e) })
  const b = blob(2)
  for (const f of b.frames) t.ok(pool.submit(f))
  const d = path.join(dir, BLOBS_DIR, b4a.toString(b.id, 'hex'))
  fs.unlinkSync(path.join(d, '1'))
  t.is(pool.submit(b.frames[1]), null, 'a missing file is not refilled')
  t.is(pool.info(b.id), null)
  t.absent(fs.existsSync(d))
  t.is(pool.bytes, 0)
  t.is(pool.submit(b.frames[0]), null)
  t.alike(logged, [{ event: 'blob-pool-broken', blobs: 1 }])
})

test('a short chunk file found at load removes the whole blob and the frames it can read stay spent', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now })
  const b = blob(2)
  for (const f of b.frames) t.ok(pool.submit(f))
  pool.close()
  const d = path.join(dir, BLOBS_DIR, b4a.toString(b.id, 'hex'))
  fs.writeFileSync(path.join(d, '0'), b.frames[0].subarray(0, 100))

  const logged = []
  const again = open(t, dir, { now: c.now, log: (e) => logged.push(e) })
  t.is(again.info(b.id), null, 'the blob is gone')
  t.absent(fs.existsSync(d), 'the whole directory is removed')
  t.is(again.size, 0)
  t.is(again.bytes, 0)
  t.alike(logged, [{ event: 'blob-pool-broken', blobs: 1 }])
  noIdIn(t, logged, b.id)
  t.is(again.submit(b.frames[1]), null, 'a readable frame of the broken blob stays spent')
  again.close()

  const third = open(t, dir, { now: c.now })
  t.is(third.submit(b.frames[1]), null, 'and stays spent after a second restart')
  t.is(third.info(b.id), null)
  const next = blob(1)
  t.alike(third.submit(next.frames[0]), { ok: true, complete: true }, 'a new blob still works')
})

test('a same-length corrupted chunk file is never served and removes its blob', (t) => {
  const dir = tmpDir(t)
  const logged = []
  const pool = open(t, dir, { log: (e) => logged.push(e) })
  const root = path.join(dir, BLOBS_DIR)
  const content = blob(2)
  const stamp = blob(2)
  const viaPut = blob(1)
  for (const b of [content, stamp, viaPut]) for (const f of b.frames) t.ok(pool.submit(f))

  const flip = (b, index, at) => {
    const bad = b4a.from(b.frames[index])
    bad[at] ^= 1
    fs.writeFileSync(path.join(root, b4a.toString(b.id, 'hex'), String(index)), bad)
  }
  flip(content, 1, BLOB_FRAME_BYTES - 1)
  t.is(pool.read(content.id, 1), null, 'changed chunk bytes are not served')
  t.is(pool.info(content.id), null)
  t.absent(fs.existsSync(path.join(root, b4a.toString(content.id, 'hex'))))

  flip(stamp, 0, 50)
  t.is(pool.read(stamp.id, 0), null, 'changed stamp bytes are not served')
  t.is(pool.info(stamp.id), null)
  t.absent(fs.existsSync(path.join(root, b4a.toString(stamp.id, 'hex'))))

  flip(viaPut, 0, BLOB_FRAME_BYTES - 1)
  t.is(pool.submit(viaPut.frames[0]), null, 'the original frame does not repair it')
  t.is(pool.info(viaPut.id), null)
  t.absent(fs.existsSync(path.join(root, b4a.toString(viaPut.id, 'hex'))))

  t.is(pool.size, 0)
  t.is(pool.bytes, 0)
  for (const b of [content, stamp, viaPut]) for (const f of b.frames) t.is(pool.submit(f), null, 'its frames stay spent')
  t.alike(logged, [{ event: 'blob-pool-broken', blobs: 1 }, { event: 'blob-pool-broken', blobs: 1 }, { event: 'blob-pool-broken', blobs: 1 }])
})

test('after a broken blob and a restart, another chunk for its id starts a fresh blob, never a half one', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now })
  const b = blob(2)
  for (const f of b.frames) t.ok(pool.submit(f))
  fs.writeFileSync(path.join(dir, BLOBS_DIR, b4a.toString(b.id, 'hex'), '1'), 'x')
  t.is(pool.read(b.id, 1), null)
  pool.close()

  const again = open(t, dir, { now: c.now })
  const other = encodeChunk({ id: b.id, index: 1, count: 2, kid: GOOD_KID, sig: randomBytes(256), token: randomBytes(32), bytes: randomBytes(100) })
  t.alike(again.submit(other), { ok: true, complete: false }, 'a fresh frame starts a new blob, not the old half one')
  t.alike(again.info(b.id), { count: 2, have: 1, complete: false })
  t.is(again.read(b.id, 1), null)
  t.is(again.submit(b.frames[0]), null, 'the old frames stay refused')
  t.is(again.submit(b.frames[1]), null)
  t.alike(again.info(b.id), { count: 2, have: 1, complete: false })
})

test('a broken blob whose directory cannot be removed stays reserved until a sweep removes it', (t) => {
  const dir = tmpDir(t)
  const logged = []
  const pool = open(t, dir, { maxBytes: 2 * BLOB_CHUNK_BYTES, log: (e) => logged.push(e) })
  const b = blob(2)
  for (const f of b.frames) t.ok(pool.submit(f))
  const d = path.join(dir, BLOBS_DIR, b4a.toString(b.id, 'hex'))
  fs.writeFileSync(path.join(d, '1'), 'x')
  fs.chmodSync(d, 0o500)
  t.teardown(() => { try { fs.chmodSync(d, 0o700) } catch {} })
  t.is(pool.read(b.id, 1), null)
  t.is(pool.info(b.id), null, 'no longer served')
  t.is(pool.read(b.id, 0), null)
  t.is(pool.bytes, 2 * BLOB_CHUNK_BYTES, 'still reserved')
  t.is(pool.submit(b.frames[0]), null)
  t.alike(logged, [{ event: 'blob-pool-broken', blobs: 1 }])
  fs.chmodSync(d, 0o700)
  t.is(pool.sweep(), 1, 'the sweep removes it')
  t.absent(fs.existsSync(d))
  t.is(pool.bytes, 0)
  t.is(pool.submit(b.frames[0]), null, 'its frames stay spent')
})

test('a failed directory delete keeps the reservation and the next sweep retries', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const logged = []
  const pool = open(t, dir, { now: c.now, maxBytes: 2 * BLOB_CHUNK_BYTES, log: (e) => logged.push(e) })
  const a = blob(2)
  t.ok(pool.submit(a.frames[0]))
  t.ok(pool.submit(a.frames[1]))
  const d = path.join(dir, BLOBS_DIR, b4a.toString(a.id, 'hex'))
  fs.chmodSync(d, 0o500)
  t.teardown(() => { try { fs.chmodSync(d, 0o700) } catch {} })
  c.t += 7 * DAY
  t.is(pool.sweep(), 0, 'nothing removed')
  t.is(pool.bytes, 2 * BLOB_CHUNK_BYTES, 'still reserved')
  t.is(pool.info(a.id), null, 'no longer served')
  t.is(pool.read(a.id, 0), null)
  t.is(pool.submit(a.frames[0]), null)
  t.is(pool.submit(blob(1).frames[0]), 'cheio', 'the space is not reused while the files stay')
  t.alike(logged, [{ event: 'blob-pool-remove-failed', blobs: 1 }])
  fs.chmodSync(d, 0o700)
  t.is(pool.sweep(), 1, 'retried')
  t.is(pool.bytes, 0)
  t.absent(fs.existsSync(d))
  t.alike(pool.submit(blob(1).frames[0]), { ok: true, complete: true })
})
