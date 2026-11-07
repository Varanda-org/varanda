'use strict'

// A seeder stand-in for the direct message tests: a loopback WebSocket
// server that speaks admission (role 'seeder', certified by the
// association), 'varanda/dm/1' over an in-memory pool and
// 'varanda/dm-stamp/1' with an RSA-2048 postage key generated here (no key
// material in the repository). Every put and page is recorded, so a test can
// check what crossed the anonymous channel.
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer } = require('ws')
const { createSeederCert } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { attachDm } = require('@varanda/core/lib/dm-net')
const { attachDmStamp } = require('@varanda/core/lib/dm-stamp-net')
const { decodeDrop } = require('@varanda/core/lib/dm')
const postage = require('@varanda/core/lib/dm-postage')
const { wsStream } = require('../../lib/ws-stream')

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

let cachedRsa = null

function rsaKey () {
  if (cachedRsa === null) {
    const { privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
    const jwk = privateKey.export({ format: 'jwk' })
    cachedRsa = { n: fromBase64url(jwk.n), d: fromBase64url(jwk.d) }
  }
  return cachedRsa
}

// The pool as lib/dm-pool.js answers it, in memory.
function memoryPool (pub) {
  const entries = []
  const byDrop = new Map()
  const tokens = new Set()
  let nextSeq = 1
  return {
    entries,
    submit (bytes) {
      const drop = decodeDrop(bytes)
      if (drop === null) return null
      if (hex(drop.kid) !== pub.kid || !postage.verify(drop.token, drop.rsaSig, pub)) return null
      const known = byDrop.get(hex(drop.dropId))
      if (known) return b4a.equals(known.bytes, bytes) ? { seq: known.seq, repeated: true } : null
      if (tokens.has(hex(drop.token))) return null
      tokens.add(hex(drop.token))
      const e = { seq: nextSeq++, bytes: b4a.from(bytes) }
      entries.push(e)
      byDrop.set(hex(drop.dropId), e)
      return { seq: e.seq }
    },
    page ({ after, limit }) {
      const rest = entries.filter((e) => e.seq > after)
      const items = rest.slice(0, limit)
      return { items, next: rest.length > items.length ? items[items.length - 1].seq : null, oldest: entries.length ? entries[0].seq : nextSeq }
    }
  }
}

// opts.dropPutAck(n): true -> the n-th put (0-based) is stored and the link
// is then destroyed before the ack (an uncertain put). opts.budget: stamps
// per diary (default 1000).
async function dmSeeder (t, { signer, dropPutAck = () => false, budget = 1000 } = {}) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const rsa = rsaKey()
  const pub = postage.publicKey(rsa.n)
  const pool = memoryPool(pub)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const issued = new Map()
  const seeder = {
    url: 'ws://127.0.0.1:' + wss.address().port + '/seeder',
    pool,
    pub,
    puts: [],
    pages: 0,
    traffic: [],
    stampProofs: [],
    budget,
    async close () {
      for (const s of wss.clients) s.terminate()
      await new Promise((resolve) => wss.close(() => resolve()))
    }
  }
  t.teardown(() => seeder.close(), { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', noop)
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      attachDm(noise, {
        role: 'seeder',
        putRate: 1000,
        putBurst: 1000,
        put: (bytes) => {
          const n = seeder.puts.length
          seeder.puts.push(b4a.from(bytes))
          seeder.traffic.push(b4a.toString(bytes, 'base64'))
          const r = pool.submit(bytes)
          if (dropPutAck(n)) {
            setImmediate(() => noise.destroy())
            return new Promise(noop)
          }
          return r
        },
        page: (q) => {
          seeder.pages++
          const r = pool.page(q)
          seeder.traffic.push(JSON.stringify({ after: q.after, limit: q.limit }))
          return r
        }
      })
      attachDmStamp(noise, {
        role: 'seeder',
        issueBurst: 1000,
        issueRate: 1000,
        // seeder.announce (tests): another public key to announce on new links.
        postage: { publicKey: seeder.announce || pub, sign: (blinded) => postage.sign(blinded, rsa.n, rsa.d) },
        budget: {
          take (diary) {
            seeder.stampProofs.push(diary)
            const n = issued.get(diary) || 0
            if (n >= seeder.budget) return false
            issued.set(diary, n + 1)
            return true
          }
        }
      })
      attachAdmission(noise, { role: 'seeder', cert, have: [] })
    })
  })
  return seeder
}

module.exports = { dmSeeder, memoryPool, rsaKey }
