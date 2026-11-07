'use strict'

// The seeder's direct message pool (lib/dm-pool.js) on a temporary directory.
// Stamps are checked by a stand-in verifyStamp that accepts a marked kid, so
// no RSA key is needed here (dm-postage.test.js covers the stamps).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const sodium = require('sodium-universal')
const { createDmPool, POOL_DIR, LOG_FILE, HEAD_FILE, SEQ_FILE, RECORD_BYTES } = require('../lib/dm-pool')
const { DM_DROP_BYTES, DROP, encodeDrop, newDropId, buildInner, sealInner } = require('../lib/dm')
const { tmpDir } = require('./helpers/tmp')

const DAY = 86400000
const GOOD_KID = b4a.from('00112233aabbccdd', 'hex')

function randomBytes (n) {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

function drop ({ token = randomBytes(32), kid = GOOD_KID, sealed = randomBytes(DROP.SEALED_BYTES) } = {}) {
  return encodeDrop({ dropId: newDropId(), kid, rsaSig: randomBytes(256), token, sealed })
}

function verifyStamp (kid, token, sig) {
  return kid === '00112233aabbccdd' && token.byteLength === 32 && sig.byteLength === 256
}

function clock (start) {
  const c = { t: start }
  c.now = () => c.t
  return c
}

function open (t, dir, extra = {}) {
  const pool = createDmPool({ dir, verifyStamp, ...extra })
  t.teardown(() => pool.close())
  return pool
}

test('submit, page and persistence across reload', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now })
  const d1 = drop()
  const d2 = drop()
  const d3 = drop()
  t.alike(pool.submit(d1), { seq: 1 })
  t.alike(pool.submit(d2), { seq: 2 })
  t.alike(pool.submit(d3), { seq: 3 })

  const p = pool.page({ after: 0, limit: 2 })
  t.alike(p.items.map((it) => it.seq), [1, 2])
  t.ok(b4a.equals(p.items[0].bytes, d1))
  t.is(p.next, 2)
  t.is(p.oldest, 1)
  const p2 = pool.page({ after: 2, limit: 2 })
  t.alike(p2.items.map((it) => it.seq), [3])
  t.is(p2.next, null)
  t.alike(pool.page({ after: 3, limit: 8 }), { items: [], next: null, oldest: 1 })
  pool.close()

  const again = open(t, dir, { now: c.now })
  t.is(again.size, 3)
  t.is(again.nextSeq, 4)
  const all = again.page({ after: 0, limit: 8 })
  t.ok(b4a.equals(all.items[2].bytes, d3))
  t.alike(again.submit(d2), { seq: 2, repeated: true }, 'idempotent after reload')
  t.alike(again.submit(drop()), { seq: 4 })

  const st = fs.statSync(path.join(dir, POOL_DIR, LOG_FILE))
  t.is(st.size, 4 * RECORD_BYTES)
  t.is(st.mode & 0o777, 0o600)
  t.is(fs.statSync(path.join(dir, POOL_DIR, HEAD_FILE)).mode & 0o777, 0o600)
})

test('refusals: bad frame, bad stamp, spent token, same dropId on other bytes', (t) => {
  const pool = open(t, tmpDir(t))
  t.is(pool.submit(randomBytes(DM_DROP_BYTES)), null, 'not a drop')
  t.is(pool.submit(b4a.alloc(10)), null, 'wrong size')
  t.is(pool.submit(drop({ kid: randomBytes(8) })), null, 'bad stamp')
  t.is(open(t, tmpDir(t), { verifyStamp: () => { throw new Error('x') } }).submit(drop()), null, 'a throwing verifier refuses')

  const token = randomBytes(32)
  const first = drop({ token })
  t.alike(pool.submit(first), { seq: 1 })
  t.is(pool.submit(drop({ token })), null, 'same token, other bytes')
  t.alike(pool.submit(first), { seq: 1, repeated: true }, 'identical bytes again')

  const other = b4a.from(first)
  other[other.byteLength - 1] ^= 1
  t.is(pool.submit(other), null, 'same dropId, other bytes')
  t.is(pool.size, 1)
})

test('at max the pool answers cheio', (t) => {
  const pool = open(t, tmpDir(t), { max: 2 })
  t.alike(pool.submit(drop()), { seq: 1 })
  t.alike(pool.submit(drop()), { seq: 2 })
  t.is(pool.submit(drop()), 'cheio')
  t.is(pool.size, 2)
})

test('sweep removes an 8-day-old record and keeps a 1-day-old one; seqs never go back', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now })
  const token = randomBytes(32)
  const old = drop({ token })
  t.alike(pool.submit(old), { seq: 1 })
  c.t += 7 * DAY
  const young = drop()
  t.alike(pool.submit(young), { seq: 2 })
  c.t += DAY
  t.is(pool.sweep(), 1)
  t.is(pool.sweep(), 0)
  const p = pool.page({ after: 0, limit: 8 })
  t.alike(p.items.map((it) => it.seq), [2])
  t.ok(b4a.equals(p.items[0].bytes, young))
  t.is(p.oldest, 2)
  t.is(fs.statSync(path.join(dir, POOL_DIR, LOG_FILE)).size, RECORD_BYTES)
  const head = JSON.parse(fs.readFileSync(path.join(dir, POOL_DIR, HEAD_FILE), 'utf8'))
  t.alike(Object.keys(head), ['v', 'nextSeq', 'oldestSeq', 'tokens'])
  t.is(head.tokens.length, 2, 'the swept record keeps its spent token')
  t.ok(head.tokens.some((x) => x.h === b4a.toString(hcrypto.hash(token), 'hex') && x.at === 1700000000000))
  t.is(pool.submit(drop({ token })), null, 'the same token on new bytes is still refused')
  t.alike(pool.submit(drop()), { seq: 3 })

  c.t += 8 * DAY
  t.is(pool.sweep(), 2)
  t.is(pool.size, 0)
  pool.close()
  const again = open(t, dir, { now: c.now })
  t.is(again.oldestSeq, 4)
  t.alike(again.submit(drop()), { seq: 4 }, 'an empty pool keeps counting')
})

test('spent token hashes outlive their records and keep their ages across reload', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now })
  const token = randomBytes(32)
  const h = b4a.toString(hcrypto.hash(token), 'hex')
  t.alike(pool.submit(drop({ token })), { seq: 1 })
  c.t += 8 * DAY
  t.is(pool.sweep(), 1, 'the record is swept')
  t.is(pool.size, 0)
  t.is(pool.submit(drop({ token })), null, 'refused at 8 days')
  pool.close()

  c.t += DAY
  const again = open(t, dir, { now: c.now })
  const head = JSON.parse(fs.readFileSync(path.join(dir, POOL_DIR, HEAD_FILE), 'utf8'))
  t.alike(head.tokens, [{ h, at: 1700000000000, kid: '00112233aabbccdd' }], 'reload keeps the original age')
  t.is(again.submit(drop({ token })), null, 'refused after reload')
  c.t += 6 * DAY
  t.is(again.sweep(), 0)
  const after = JSON.parse(fs.readFileSync(path.join(dir, POOL_DIR, HEAD_FILE), 'utf8'))
  t.alike(after.tokens, [], 'gone after 15 days')
  t.alike(again.submit(drop({ token })), { seq: 2 }, 'the hash no longer blocks it')
  t.exception.all(() => createDmPool({ dir: tmpDir(t), verifyStamp, retentionMs: 10, tokenRetentionMs: 9 }), /tokenRetentionMs/)
})

test('old head.json with bare token hashes migrates, counting from load time', (t) => {
  const dir = tmpDir(t)
  const token = randomBytes(32)
  const h = b4a.toString(hcrypto.hash(token), 'hex')
  fs.mkdirSync(path.join(dir, POOL_DIR), { recursive: true })
  fs.writeFileSync(path.join(dir, POOL_DIR, HEAD_FILE), JSON.stringify({ v: 1, nextSeq: 5, oldestSeq: 5, tokens: [h, 'not-hex'] }))
  const c = clock(1800000000000)
  const pool = open(t, dir, { now: c.now })
  const head = JSON.parse(fs.readFileSync(path.join(dir, POOL_DIR, HEAD_FILE), 'utf8'))
  t.alike(head.tokens, [{ h, at: 1800000000000, kid: null }])
  t.is(pool.submit(drop({ token })), null)
  c.t += 13 * DAY
  pool.sweep()
  t.is(pool.submit(drop({ token })), null, 'still spent at 13 days after load')
  t.alike(pool.submit(drop()), { seq: 5 })
})

test('a crash right after the compacted log is renamed keeps the swept token spent', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const crashAt = { step: 'renamed' }
  const pool = open(t, dir, { now: c.now, fault: (step) => { if (step === crashAt.step) throw new Error('crash') } })
  const token = randomBytes(32)
  t.alike(pool.submit(drop({ token })), { seq: 1 })
  c.t += DAY
  const young = drop()
  t.alike(pool.submit(young), { seq: 2 })
  c.t += 7 * DAY
  t.exception(() => pool.sweep(), /crash/)
  // The rename happened: memory follows the compacted log.
  t.is(pool.size, 1)
  t.is(pool.submit(drop({ token })), null)
  pool.close()

  const again = open(t, dir, { now: c.now })
  t.is(again.size, 1)
  t.ok(b4a.equals(again.page({ after: 0, limit: 8 }).items[0].bytes, young))
  t.is(again.submit(drop({ token })), null, 'still spent after crash and reload')
})

test('a crash before the rename leaves the old log and the old state', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const pool = open(t, dir, { now: c.now, fault: (step) => { if (step === 'head-written') throw new Error('crash') } })
  const token = randomBytes(32)
  const old = drop({ token })
  t.alike(pool.submit(old), { seq: 1 })
  c.t += 8 * DAY
  t.exception(() => pool.sweep(), /crash/)
  t.is(pool.size, 1, 'nothing swept in memory')
  t.ok(b4a.equals(pool.page({ after: 0, limit: 8 }).items[0].bytes, old))
  t.alike(pool.submit(drop()), { seq: 2 }, 'appends still land in the live log')
  t.is(pool.submit(drop({ token })), null)
  t.alike(fs.readdirSync(path.join(dir, POOL_DIR)).sort(), [HEAD_FILE, LOG_FILE, SEQ_FILE].sort(), 'temp log removed')
  pool.close()
  const again = open(t, dir, { now: c.now })
  t.is(again.size, 1, 'the load leaves the expired record out of the index')
  t.is(again.submit(drop({ token })), null)
})

test('short reads and writes are completed; a failed write is never acked', (t) => {
  const dir = tmpDir(t)
  const realRead = fs.readSync
  const realWrite = fs.writeSync
  const realFsync = fs.fsyncSync
  t.teardown(() => {
    fs.readSync = realRead
    fs.writeSync = realWrite
    fs.fsyncSync = realFsync
  })
  fs.readSync = (fd, buf, off, len, pos) => realRead(fd, buf, off, Math.min(len, 1000), pos)
  fs.writeSync = (fd, buf, off, len, pos) => realWrite(fd, buf, off, Math.min(len, 1000), pos)
  const pool = open(t, dir)
  const d1 = drop()
  t.alike(pool.submit(d1), { seq: 1 })
  t.ok(b4a.equals(pool.page({ after: 0, limit: 1 }).items[0].bytes, d1), 'chunked read is whole')

  fs.fsyncSync = () => { throw new Error('eio') }
  const d2 = drop()
  t.exception(() => pool.submit(d2), /eio/)
  fs.fsyncSync = realFsync
  t.is(pool.size, 1)
  t.is(fs.statSync(path.join(dir, POOL_DIR, LOG_FILE)).size, RECORD_BYTES, 'partial record cut')
  t.alike(pool.submit(d2), { seq: 2 }, 'the same drop is taken on a later try')
  pool.close()
  fs.readSync = realRead
  fs.writeSync = realWrite
  const again = open(t, dir)
  t.is(again.size, 2)
})

test('a failed reopen after compaction breaks the pool: no ack, no page', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const logFile = path.join(dir, POOL_DIR, LOG_FILE)
  const realOpen = fs.openSync
  t.teardown(() => { fs.openSync = realOpen })
  let armed = false
  fs.openSync = (p, ...rest) => {
    if (armed && p === logFile) throw Object.assign(new Error('emfile'), { code: 'EMFILE' })
    return realOpen(p, ...rest)
  }
  const logged = []
  const pool = open(t, dir, { now: c.now, log: (e) => logged.push(e), fault: (step) => { if (step === 'renamed') armed = true } })
  pool.submit(drop())
  c.t += DAY
  pool.submit(drop())
  c.t += 7 * DAY
  t.exception(() => pool.sweep(), /emfile/)
  armed = false
  t.alike(logged, [{ event: 'dm-pool-broken' }])
  t.exception(() => pool.submit(drop()), /broken/)
  t.exception(() => pool.page({ after: 0, limit: 8 }), /broken/)
  t.exception(() => pool.sweep(), /broken/)
  pool.close()
  const again = open(t, dir, { now: c.now })
  t.is(again.size, 1, 'the compacted log is what reloads')
  t.alike(again.submit(drop()), { seq: 3 })
})

test('seqs never go back, even when a damaged log is cut', (t) => {
  const dir = tmpDir(t)
  const pool = open(t, dir)
  t.alike(pool.submit(drop()), { seq: 1 })
  t.alike(pool.submit(drop()), { seq: 2 })
  t.alike(pool.submit(drop()), { seq: 3 })
  t.alike(JSON.parse(fs.readFileSync(path.join(dir, POOL_DIR, SEQ_FILE), 'utf8')), { v: 1, nextSeq: 4 })
  pool.close()
  // Damage record 2: records 2 and 3 are cut at load.
  const file = path.join(dir, POOL_DIR, LOG_FILE)
  const bytes = fs.readFileSync(file)
  bytes[RECORD_BYTES + 12] ^= 0xff
  fs.writeFileSync(file, bytes)
  // head.json alone would say 1 more than the last kept record.
  fs.writeFileSync(path.join(dir, POOL_DIR, HEAD_FILE), JSON.stringify({ v: 1, nextSeq: 1, oldestSeq: 1, tokens: [] }))
  const again = open(t, dir)
  t.is(again.size, 1)
  t.alike(again.submit(drop()), { seq: 4 }, 'seq 2 and 3 are never handed out again')
  t.is(fs.statSync(path.join(dir, POOL_DIR, SEQ_FILE)).mode & 0o777, 0o600)
})

test('an identical retry still stored is a repeated success after its key ages out', (t) => {
  let live = true
  const pool = open(t, tmpDir(t), { verifyStamp: (...args) => live && verifyStamp(...args) })
  const d = drop()
  t.alike(pool.submit(d), { seq: 1 })
  live = false
  t.alike(pool.submit(d), { seq: 1, repeated: true })
  t.is(pool.submit(drop()), null, 'a new drop still needs a live stamp')
})

test('a forward clock jump forgets no token hash whose kid is still accepted', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const kids = new Set(['00112233aabbccdd'])
  const pool = open(t, dir, { now: c.now, isKidAccepted: (kid) => kids.has(kid) })
  const token = randomBytes(32)
  t.alike(pool.submit(drop({ token })), { seq: 1 })
  c.t += 365 * DAY
  t.is(pool.sweep(), 1, 'the record goes on age')
  t.is(pool.submit(drop({ token })), null, 'the hash stays while its kid is accepted')
  kids.clear()
  pool.sweep()
  const head = JSON.parse(fs.readFileSync(path.join(dir, POOL_DIR, HEAD_FILE), 'utf8'))
  t.alike(head.tokens, [], 'gone once old and its kid retired')

  const throwing = open(t, tmpDir(t), { now: c.now, isKidAccepted: () => { throw new Error('x') } })
  const tok2 = randomBytes(32)
  throwing.submit(drop({ token: tok2 }))
  c.t += 365 * DAY
  throwing.sweep()
  t.is(throwing.submit(drop({ token: tok2 })), null, 'a throwing isKidAccepted keeps the hash')
})

test('a torn tail is cut at load and counted', (t) => {
  const dir = tmpDir(t)
  const pool = open(t, dir)
  pool.submit(drop())
  pool.submit(drop())
  pool.close()
  const file = path.join(dir, POOL_DIR, LOG_FILE)
  fs.appendFileSync(file, b4a.alloc(100, 7))
  const logged = []
  const again = open(t, dir, { log: (e) => logged.push(e) })
  t.alike(logged, [{ event: 'dm-pool-torn', records: 2, bytes: 100 }])
  t.is(again.size, 2)
  t.is(fs.statSync(file).size, 2 * RECORD_BYTES)
  t.alike(again.submit(drop()), { seq: 3 })
})

test('onStored is called with no arguments, only on a new append', (t) => {
  const calls = []
  const pool = open(t, tmpDir(t), { onStored: (...args) => calls.push(args) })
  const d = drop()
  pool.submit(d)
  pool.submit(d)
  pool.submit(b4a.alloc(3))
  t.alike(calls, [[]])
})

test('the pool directory holds no diary key, only drops, seqs and times', (t) => {
  const dir = tmpDir(t)
  const pool = open(t, dir)
  const sender = hcrypto.keyPair()
  const recipient = hcrypto.keyPair()
  const box = { publicKey: b4a.alloc(32), secretKey: b4a.alloc(32) }
  sodium.crypto_box_keypair(box.publicKey, box.secretKey)
  const inner = buildInner({ kind: 'msg', to: b4a.toString(recipient.publicKey, 'hex'), text: 'oi' }, sender)
  const sealed = sealInner(inner, b4a.toString(box.publicKey, 'hex'))
  t.alike(pool.submit(drop({ sealed })), { seq: 1 })
  pool.submit(drop())
  pool.sweep()
  pool.close()
  open(t, dir)

  const files = fs.readdirSync(path.join(dir, POOL_DIR))
  t.alike(files.sort(), [HEAD_FILE, LOG_FILE, SEQ_FILE].sort(), 'no other file, no temp left')
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(dir, POOL_DIR, name))
    const text = b4a.toString(bytes, 'utf8')
    for (const kp of [sender, recipient]) {
      t.absent(text.includes(b4a.toString(kp.publicKey, 'hex')), name + ': no hex key')
      t.is(b4a.indexOf(bytes, kp.publicKey), -1, name + ': no raw key')
    }
  }
  const log = fs.readFileSync(path.join(dir, POOL_DIR, LOG_FILE))
  t.is(log.byteLength % RECORD_BYTES, 0, 'only whole records')
})

test('a sweep rewrites the log only past 1/8 of it or compactAt expired records', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000)
  const logFile = path.join(dir, POOL_DIR, LOG_FILE)
  let renames = 0
  const counting = (step) => { if (step === 'renamed') renames++ }
  const pool = open(t, dir, { now: c.now, fault: counting })
  const old = drop()
  t.alike(pool.submit(old), { seq: 1 })
  c.t += 2 * DAY
  const young = []
  for (let i = 0; i < 8; i++) {
    young.push(drop())
    pool.submit(young[i])
  }
  c.t += 6 * DAY + 1
  t.is(pool.sweep(), 1, '1 of 9 expired: not past 1/8')
  t.is(renames, 0, 'no rewrite')
  t.is(fs.statSync(logFile).size, 9 * RECORD_BYTES, 'the expired record stays in the file')
  const p = pool.page({ after: 0, limit: 16 })
  t.alike(p.items.map((it) => it.seq), [2, 3, 4, 5, 6, 7, 8, 9], 'page skips it')
  t.ok(b4a.equals(p.items[0].bytes, young[0]))
  t.is(p.oldest, 2)
  const head = JSON.parse(fs.readFileSync(path.join(dir, POOL_DIR, HEAD_FILE), 'utf8'))
  t.is(head.oldestSeq, 2, 'head follows the index')
  t.is(pool.submit(old), null, 'its token stays spent')
  const late = drop()
  t.alike(pool.submit(late), { seq: 10 }, 'appends land past the expired record')
  t.ok(b4a.equals(pool.page({ after: 9, limit: 1 }).items[0].bytes, late))
  t.is(fs.statSync(logFile).size, 10 * RECORD_BYTES)
  pool.close()

  const again = open(t, dir, { now: c.now })
  t.is(again.size, 9, 'a load skips the expired record')
  t.is(again.page({ after: 0, limit: 1 }).items[0].seq, 2)
  t.is(again.submit(old), null)
  again.close()

  c.t = 1700000000000
  const small = open(t, tmpDir(t), { now: c.now, compactAt: 1, fault: counting })
  small.submit(drop())
  c.t += DAY
  for (let i = 0; i < 9; i++) small.submit(drop())
  c.t += 7 * DAY - 1
  t.is(small.sweep(), 1)
  t.is(renames, 1, 'compactAt records force the rewrite')

  c.t = 1700000000000
  const big = tmpDir(t)
  const p2 = open(t, big, { now: c.now })
  p2.submit(drop())
  p2.submit(drop())
  c.t += DAY
  for (let i = 0; i < 6; i++) p2.submit(drop())
  c.t += 7 * DAY - 1
  t.is(p2.sweep(), 2, '2 of 8 expired: past 1/8')
  t.is(fs.statSync(path.join(big, POOL_DIR, LOG_FILE)).size, 6 * RECORD_BYTES, 'compacted')
  t.exception.all(() => createDmPool({ dir: tmpDir(t), verifyStamp, compactAt: 0 }), /compactAt/)
})

test('a receivedAt more than a day ahead is read as the load time', (t) => {
  const dir = tmpDir(t)
  const c = clock(1700000000000 + 30 * DAY)
  const pool = open(t, dir, { now: c.now })
  t.alike(pool.submit(drop()), { seq: 1 })
  pool.close()
  c.t = 1700000000000
  const again = open(t, dir, { now: c.now })
  t.is(again.size, 1)
  c.t += 8 * DAY
  t.is(again.sweep(), 1, 'it expires 7 days after the load, not 30 days later')
  t.is(again.size, 0)
})
