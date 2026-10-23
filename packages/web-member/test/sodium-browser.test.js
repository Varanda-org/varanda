// lib/sodium-browser.js (sodium-javascript completed with the two symbols
// noise-curve-ed needs) against sodium-native, which is libsodium:
//  - differential: crypto_scalarmult_ed25519_noclamp on thousands of random
//    cases, byte-for-byte equal where libsodium succeeds and the same
//    failure class (both throw) where it fails;
//  - a Noise XX handshake through @hyperswarm/secret-stream between a peer
//    whose sodium-universal is the shim (a child process with a require
//    hook mapping sodium-native to the shim, as the browser bundle does) and
//    a native peer in this process, over TCP on loopback, both roles, data
//    both ways, handshakeHash equal and remotePublicKey correct.
// This file is its own child: with VARANDA_SODIUM_SHIM_PEER set it runs the
// shim-backed peer and never loads brittle.
/* eslint-disable camelcase */
const path = require('node:path')

const SHIM = path.join(__dirname, '..', 'lib', 'sodium-browser.js')
const PAYLOAD = 4096

if (process.env.VARANDA_SODIUM_SHIM_PEER) {
  shimPeer(JSON.parse(process.env.VARANDA_SODIUM_SHIM_PEER))
} else {
  tests()
}

// The shim-backed peer. Installed before anything that loads
// sodium-universal: every require('sodium-native') resolves to the shim.
function shimPeer ({ port, initiator, seed }) {
  const Module = require('node:module')
  const net = require('node:net')
  const resolve = Module._resolveFilename
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'sodium-native') return SHIM
    return resolve.call(this, request, ...rest)
  }

  const shim = require(SHIM)
  const sodium = require('sodium-universal')
  const SecretStream = require('@hyperswarm/secret-stream')
  const usedShim = sodium.crypto_scalarmult_ed25519_noclamp === shim.crypto_scalarmult_ed25519_noclamp &&
    sodium.crypto_sign_keypair === require('sodium-javascript').crypto_sign_keypair &&
    !Object.keys(require.cache).some((f) => /node_modules\/sodium-native\//.test(f))

  const keyPair = SecretStream.keyPair(Buffer.from(seed, 'hex'))
  const socket = net.connect(port, '127.0.0.1')
  const stream = new SecretStream(initiator, socket, { keyPair })
  const sent = require('node:crypto').randomBytes(PAYLOAD)
  const chunks = []
  let received = 0

  const report = (extra) => {
    process.stdout.write(JSON.stringify({
      usedShim,
      publicKey: keyPair.publicKey.toString('hex'),
      sent: sent.toString('hex'),
      ...extra
    }) + '\n')
  }

  stream.on('error', (err) => { report({ error: err.message }); process.exit(1) })
  stream.on('connect', () => {
    stream.write(sent)
  })
  stream.on('data', (chunk) => {
    chunks.push(chunk)
    received += chunk.byteLength
    if (received < PAYLOAD) return
    report({
      remotePublicKey: stream.remotePublicKey.toString('hex'),
      handshakeHash: stream.handshakeHash.toString('hex'),
      received: Buffer.concat(chunks).subarray(0, PAYLOAD).toString('hex')
    })
    stream.end()
  })
  stream.on('close', () => process.exit(0))
}

function tests () {
  const test = require('brittle')
  const crypto = require('node:crypto')
  const fs = require('node:fs')
  const net = require('node:net')
  const { spawn } = require('node:child_process')
  const sodium = require('sodium-native')
  const sodiumJs = require('sodium-javascript')
  const SecretStream = require('@hyperswarm/secret-stream')
  const { ed25519, ED25519_TORSION_SUBGROUP } = require('@noble/curves/ed25519.js')
  const shim = require(SHIM)

  const L = ed25519.Point.Fn.ORDER

  function scalarLE (big) {
    const out = Buffer.alloc(32)
    let x = big
    for (let i = 0; i < 32; i++) {
      out[i] = Number(x & 255n)
      x >>= 8n
    }
    return out
  }

  function signPublicKey () {
    const pk = Buffer.alloc(32)
    const sk = Buffer.alloc(64)
    sodium.crypto_sign_keypair(pk, sk)
    return pk
  }

  // Random 32-byte scalars, with top bits set and values >= L among them:
  // no clamping must happen.
  function randomScalar (i) {
    const n = crypto.randomBytes(32)
    switch (i % 4) {
      case 1: n[31] |= 0x80; break
      case 2: n[31] |= 0xf0; break
      case 3: return scalarLE(L + (BigInt('0x' + crypto.randomBytes(31).toString('hex')) % L))
    }
    return n
  }

  // 'ok' with equal bytes, 'fail' when both throw, else a description.
  function compare (n, p) {
    const q1 = Buffer.alloc(32)
    const q2 = Buffer.alloc(32)
    let e1 = null
    let e2 = null
    try { sodium.crypto_scalarmult_ed25519_noclamp(q1, n, p) } catch (err) { e1 = err }
    try { shim.crypto_scalarmult_ed25519_noclamp(q2, n, p) } catch (err) { e2 = err }
    if (e1 && e2) return 'fail'
    if (!e1 && !e2) return q1.equals(q2) ? 'ok' : 'mismatch'
    return (e1 ? 'native' : 'shim') + ' failed alone'
  }

  // Runs compare over cases, asserting every result is `expected`; the first
  // differing case is reported with its inputs so it can be replayed.
  function differential (t, name, cases, expected) {
    let bad = null
    let count = 0
    for (const [n, p] of cases) {
      count++
      const r = compare(n, p)
      if (r !== expected && bad === null) bad = { r, n: n.toString('hex'), p: p.toString('hex') }
    }
    t.is(bad, null, name + ': ' + count + ' cases ' + expected + (bad ? ' (first bad: ' + JSON.stringify(bad) + ')' : ''))
    return count
  }

  test('the shim re-exports sodium-javascript and adds the two missing symbols', (t) => {
    for (const key of Object.keys(sodiumJs)) t.is(shim[key], sodiumJs[key], key)
    t.absent('crypto_scalarmult_ed25519_BYTES' in sodiumJs, 'sodium-javascript 0.8.0 lacks crypto_scalarmult_ed25519_BYTES')
    t.absent('crypto_scalarmult_ed25519_noclamp' in sodiumJs, 'sodium-javascript 0.8.0 lacks crypto_scalarmult_ed25519_noclamp')
    t.is(shim.crypto_scalarmult_ed25519_BYTES, sodium.crypto_scalarmult_ed25519_BYTES, 'BYTES as sodium-native')
    t.is(shim.crypto_scalarmult_ed25519_BYTES, 32)
    t.is(typeof shim.crypto_scalarmult_ed25519_noclamp, 'function')
    const extra = Object.keys(shim).filter((k) => !(k in sodiumJs)).sort()
    t.alike(extra, ['crypto_scalarmult_ed25519_BYTES', 'crypto_scalarmult_ed25519_noclamp'], 'nothing else is added')
    const source = fs.readFileSync(SHIM, 'utf8')
    t.absent(/require\(['"]node:/.test(source), 'no node: require')
    t.absent(/\bBuffer\b|\bprocess\b/.test(source), 'no Buffer or process global')
  })

  test('differential: valid main-subgroup points x random scalars, byte-for-byte', (t) => {
    const cases = []
    for (let i = 0; i < 2048; i++) cases.push([randomScalar(i), signPublicKey()])
    const count = differential(t, 'public keys', cases, 'ok')
    t.ok(count >= 2000, count + ' cases')
    // A few fixed scalars that must not be clamped or reduced away.
    const pk = signPublicKey()
    differential(t, 'fixed scalars', [
      [scalarLE(1n), pk],
      [scalarLE(L - 1n), pk],
      [scalarLE(L + 1n), pk],
      [Buffer.alloc(32, 0xff), pk],
      [scalarLE((1n << 255n) - 1n), pk],
      [scalarLE((1n << 255n) + 7n), pk]
    ], 'ok')
  })

  test('differential: libsodium accepts order-2L points (X-only subgroup check); the shim matches', (t) => {
    // ge25519_is_on_main_subgroup tests only X of L * P, so P0 + (0, -1) is
    // accepted and L * P is the order-2 point, not the identity: scalars
    // >= L (odd multiple of L) and L itself must give libsodium's result.
    const T2 = ed25519.Point.fromBytes(Buffer.from(ED25519_TORSION_SUBGROUP[4], 'hex'), true)
    const cases = []
    for (let i = 0; i < 256; i++) {
      const p = Buffer.from(ed25519.Point.fromBytes(signPublicKey()).add(T2).toBytes())
      cases.push([randomScalar(i), p])
    }
    const p = Buffer.from(ed25519.Point.fromBytes(signPublicKey()).add(T2).toBytes())
    cases.push([scalarLE(L), p], [scalarLE(L + 1n), p], [scalarLE(L + (1n << 255n)), p], [Buffer.alloc(32, 0xff), p])
    differential(t, 'order-2L points', cases, 'ok')
    differential(t, 'order-2L points, scalars that give the identity', [
      [Buffer.alloc(32), p],
      [scalarLE(2n * L), p],
      [scalarLE(1n << 255n), p]
    ], 'fail')
  })

  test('differential: invalid points and scalars fail on both', (t) => {
    const pk = signPublicKey()
    const K = ed25519.Point.fromBytes(pk)
    const torsion = ED25519_TORSION_SUBGROUP.map((h) => ed25519.Point.fromBytes(Buffer.from(h, 'hex'), true))

    // libsodium's blacklist (the torsion subgroup, sign bit ignored).
    const small = []
    for (const h of ED25519_TORSION_SUBGROUP) {
      const p = Buffer.from(h, 'hex')
      small.push([randomScalar(1), p])
      const flipped = Buffer.from(p)
      flipped[31] ^= 0x80
      small.push([randomScalar(2), flipped])
    }
    differential(t, 'small-order encodings', small, 'fail')

    // Non-canonical encodings: y >= p, with and without the sign bit.
    const nonCanonical = []
    for (const h of [
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'efffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'f3ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    ]) nonCanonical.push([randomScalar(0), Buffer.from(h, 'hex')])
    differential(t, 'non-canonical encodings', nonCanonical, 'fail')

    // Encodings that are not on the curve (no square root), found by trial.
    const offCurve = []
    while (offCurve.length < 64) {
      const p = crypto.randomBytes(32)
      p[31] &= 0x7f
      try { ed25519.Point.fromBytes(p, false) } catch { offCurve.push([randomScalar(offCurve.length), p]) }
    }
    differential(t, 'off-curve encodings', offCurve, 'fail')

    // Mixed-order points: a public key plus a torsion point of order 4 or 8
    // (indices 1, 2, 3, 5, 6, 7; 0 is the identity and 4 the order-2 point).
    const mixed = []
    for (const j of [1, 2, 3, 5, 6, 7]) {
      for (let i = 0; i < 32; i++) {
        const p = Buffer.from(ed25519.Point.fromBytes(signPublicKey()).add(torsion[j]).toBytes())
        mixed.push([randomScalar(i), p])
      }
    }
    differential(t, 'mixed-order points', mixed, 'fail')

    // Scalars that are zero or give the identity on a prime-order point.
    differential(t, 'zero and identity scalars', [
      [Buffer.alloc(32), pk],
      [scalarLE(L), pk],
      [scalarLE(2n * L), pk],
      [scalarLE(1n << 255n), pk],
      [scalarLE(L + (1n << 255n)), pk]
    ], 'fail')
    t.ok(K.isTorsionFree(), 'the public key used is in the prime-order subgroup')

    // Whatever class random bytes fall in, both agree.
    const random = []
    for (let i = 0; i < 512; i++) random.push([crypto.randomBytes(32), crypto.randomBytes(32)])
    let agree = 0
    let ok = 0
    for (const [n, p] of random) {
      const r = compare(n, p)
      if (r === 'ok') ok++
      if (r === 'ok' || r === 'fail') agree++
    }
    t.is(agree, random.length, 'random bytes: both agree on all ' + random.length + ' (' + ok + ' accepted)')
  })

  test('failures are signalled as sodium-native does: an Error is thrown', (t) => {
    const pk = signPublicKey()
    const q = Buffer.alloc(32)
    t.exception(() => sodium.crypto_scalarmult_ed25519_noclamp(q, Buffer.alloc(32), pk), /failed to derive shared secret/, 'sodium-native throws')
    t.exception(() => shim.crypto_scalarmult_ed25519_noclamp(q, Buffer.alloc(32), pk), /failed to derive shared secret/, 'the shim throws the same')
    t.exception(() => shim.crypto_scalarmult_ed25519_noclamp(q, Buffer.alloc(31), pk), /length 32/, 'short scalar')
    t.exception(() => shim.crypto_scalarmult_ed25519_noclamp(q, Buffer.alloc(32, 1), Buffer.alloc(31)), /length 32/, 'short point')
    t.exception(() => shim.crypto_scalarmult_ed25519_noclamp(Buffer.alloc(31), Buffer.alloc(32, 1), pk), /length 32/, 'short output')
    t.exception(() => sodium.crypto_scalarmult_ed25519_noclamp(q, Buffer.alloc(31), pk), 'sodium-native rejects a short scalar too')
  })

  // A TCP server on loopback for one shim-backed child; resolves with the
  // native side's result and the child's report.
  async function handshake (t, { nativeInitiator }) {
    const seed = crypto.randomBytes(32)
    const expectedChildPk = Buffer.alloc(32)
    const sk = Buffer.alloc(64)
    sodium.crypto_sign_seed_keypair(expectedChildPk, sk, seed)

    const nativeKeyPair = SecretStream.keyPair()
    const sent = crypto.randomBytes(PAYLOAD)

    const childReport = {}
    const child = new Promise((resolve) => { childReport.resolve = resolve })

    const native = new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        server.close()
        const stream = new SecretStream(nativeInitiator, socket, { keyPair: nativeKeyPair })
        const chunks = []
        let received = 0
        stream.on('error', reject)
        stream.on('connect', () => stream.write(sent))
        stream.on('data', (chunk) => {
          chunks.push(chunk)
          received += chunk.byteLength
          if (received < PAYLOAD) return
          resolve({
            stream,
            remotePublicKey: stream.remotePublicKey,
            handshakeHash: stream.handshakeHash,
            received: Buffer.concat(chunks).subarray(0, PAYLOAD)
          })
          stream.end()
        })
      })
      server.listen(0, '127.0.0.1', () => {
        const env = {
          ...process.env,
          VARANDA_SODIUM_SHIM_PEER: JSON.stringify({ port: server.address().port, initiator: !nativeInitiator, seed: seed.toString('hex') })
        }
        const child = spawn(process.execPath, [__filename], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        t.teardown(() => { if (child.exitCode === null) child.kill('SIGKILL') }, { force: true })
        let out = ''
        let err = ''
        child.stdout.on('data', (d) => { out += d })
        child.stderr.on('data', (d) => { err += d })
        child.on('exit', (code) => {
          const line = out.split('\n').find((l) => l.startsWith('{'))
          let report = null
          try { report = JSON.parse(line) } catch {}
          if (!report || report.error) reject(new Error('peer: ' + (report && report.error) + ' exit ' + code + ' ' + err.trim()))
          else childReport.resolve({ ...report, code, stderr: err.trim() })
        })
      })
    })

    const n = await native
    const c = await child
    return { native: n, child: c, sent, expectedChildPk, nativePk: nativeKeyPair.publicKey }
  }

  for (const nativeInitiator of [false, true]) {
    const roles = nativeInitiator ? 'native initiator, shim responder' : 'shim initiator, native responder'
    test('Noise XX through secret-stream, ' + roles + ', data both ways', async (t) => {
      t.timeout(60000)
      const r = await handshake(t, { nativeInitiator })
      t.ok(r.child.usedShim, 'the peer resolved sodium-native to the shim and never loaded the native binding')
      t.is(r.child.code, 0, 'peer exited 0 ' + r.child.stderr)
      t.is(r.native.handshakeHash.toString('hex'), r.child.handshakeHash, 'handshakeHash equal on both ends')
      t.is(r.native.remotePublicKey.toString('hex'), r.expectedChildPk.toString('hex'), 'native sees the peer key derived from the seed')
      t.is(r.child.publicKey, r.expectedChildPk.toString('hex'), 'the shim-backed key pair matches sodium-native for the same seed')
      t.is(r.child.remotePublicKey, r.nativePk.toString('hex'), 'the peer sees the native key')
      t.is(r.child.received, r.sent.toString('hex'), 'native -> shim payload')
      t.is(r.native.received.toString('hex'), r.child.sent, 'shim -> native payload')
    })
  }
}
