// The member's link to a seeder over a WebSocket: Noise initiator with an
// ephemeral key (never the diary key), Hypercore 10 replication on the
// secret stream and the admission channel from @varanda/core/lib/admission
// (never lib/net.js, which loads the node-only network stack).
// Seeder pinning is done on 'connect' by comparing noise.remotePublicKey
// ourselves: @hyperswarm/secret-stream 6.9.2 overwrites the remotePublicKey
// option from the wire under the default XX pattern (index.js:191, 385;
// noise-handshake noise.js:184) and never compares it, so the option is no
// pin. The seeder is then verified exactly as lib/sync.js:864-866 does: hello
// role 'seeder' and seederCertForKey(cert, remote Noise key, association).
// The diary's replication channel is opened only AFTER that verification:
// before it, the stream carries the Protomux and the admission channel alone,
// so an endpoint impersonating a seeder can never request a diary block.
// The transport runs behind a frame guard (./ws-stream.js guardedWsStream,
// MAX_EXTERNAL_FRAME: a member's legitimate batches reach 8 MiB): a frame
// declaring more is cut at its header, before the secret stream allocates
// it, and the link then fails through the ordinary close path.
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { seederCertForKey } = require('@varanda/core/lib/cert')
const { guardedWsStream } = require('./ws-stream')

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function connectSeeder ({ member, socket, association, seederPublicKey = null, onEvent = noop, timeoutMs = 20000, admitTimeoutMs = timeoutMs }) {
  const core = member.core
  const key = member.key
  const { stream: duplex } = guardedWsStream(socket)
  const noise = new NoiseSecretStream(true, duplex, { keyPair: crypto.keyPair() })
  noise.on('error', noop)

  let settled = false
  let resolveAdmitted
  let rejectAdmitted
  const admitted = new Promise((resolve, reject) => {
    resolveAdmitted = resolve
    rejectAdmitted = reject
  })
  // The caller may only look at `admitted` later; its rejection is never
  // unhandled here, and the returned promise still rejects for the caller.
  admitted.catch(noop)
  // One deadline covers the Noise handshake, the verified hello and the
  // admission: a silent endpoint must not keep the link open forever.
  const admitTimer = setTimeout(() => {
    if (!settled) fail(new Error('tempo esgotado: o semeador não admitiu o diário'))
  }, admitTimeoutMs)
  if (admitTimer.unref) admitTimer.unref()

  let replicating = false // the diary is attached only after a verified hello
  let served = -1 // highest length the seeder reported having for our key
  const waiters = new Set()
  const link = {
    noise,
    peer: null,
    hello: null,
    verified: false,
    admitted,
    waitServed,
    close
  }

  const onAppend = () => {
    if (link.peer) link.peer.send({ type: 'have', key, length: core.length })
  }

  noise.once('connect', onConnect)
  noise.once('close', onClose)
  return link

  function fail (err) {
    clearTimeout(admitTimer)
    if (!settled) {
      settled = true
      rejectAdmitted(err)
    }
    for (const w of waiters) w.reject(err)
    waiters.clear()
    noise.destroy()
  }

  function onConnect () {
    const remote = hex(noise.remotePublicKey)
    if (seederPublicKey !== null && remote !== seederPublicKey) {
      fail(new Error('semeador desconhecido'))
      return
    }
    let peer
    try {
      // Protomux on the stream (in noise.userData) WITHOUT attaching the
      // diary: hypercore 10.38.2 index.js:157-187 creates or reuses the
      // muxer and opens no core channel. core.replicate(noise) later reuses
      // the same muxer (index.js:517-522, guarded by index.js:174).
      Hypercore.createProtocolStream(noise)
      // Our own hello's have reveals the diary key and length to an
      // unverified endpoint: both are public data (the CLI member sends the
      // same), unlike the blocks, which only replicate after verification.
      peer = attachAdmission(noise, {
        role: 'member',
        have: [{ key, length: core.length }],
        onmessage: onMessage
      })
    } catch (err) {
      fail(err)
      return
    }
    link.peer = peer
    core.on('append', onAppend)
    onEvent({ event: 'connected', peerKey: remote })
  }

  function onMessage (msg, peer) {
    if (msg.type === 'hello') {
      const verified = msg.role === 'seeder' &&
        seederCertForKey(msg.cert, hex(noise.remotePublicKey), association).ok
      link.hello = msg
      link.verified = verified
      onEvent({ event: 'peer', role: msg.role, peerKey: peer.peerKey, verified })
      if (!verified) {
        fail(new Error('semeador não verificado'))
        return
      }
      // Verified: only now is the diary attached to the shared muxer.
      try {
        if (!replicating) {
          replicating = true
          core.replicate(noise)
        }
      } catch (err) {
        fail(err)
        return
      }
      announce().catch((err) => fail(err))
      return
    }
    if (msg.key !== key) return
    // Only a verified seeder (hello role 'seeder' with a certificate that
    // verifies for its Noise key, the lib/sync.js:864-866 rule) may move the
    // served length, admit or reject us: without a seederPublicKey pin any
    // endpoint can send have/admitted before or instead of a hello.
    if (link.verified !== true) return
    if (msg.type === 'have' || msg.type === 'admitted') {
      if (msg.type === 'admitted') {
        onEvent({ event: 'admitted', key, length: msg.length })
        clearTimeout(admitTimer)
        if (!settled) {
          settled = true
          resolveAdmitted(msg)
        }
      } else {
        onEvent({ event: 'have', key, length: msg.length })
      }
      if (msg.length > served) served = msg.length
      for (const w of waiters) {
        if (served >= w.length) w.resolve(served)
      }
      return
    }
    if (msg.type === 'rejected') {
      onEvent({ event: 'rejected', key, reason: msg.reason })
      fail(new Error(msg.reason))
    }
  }

  async function announce () {
    const block0 = await member.block(0)
    if (block0 === null || block0.cert === null || typeof block0.cert !== 'object') throw new Error('certificado ausente no bloco 0')
    if (link.peer) link.peer.send({ type: 'announce', key, cert: block0.cert })
  }

  // Resolves with the served length once the seeder reports (have or
  // admitted) at least `length` blocks of our key.
  function waitServed (length) {
    if (served >= length) return Promise.resolve(served)
    if (noise.destroyed) return Promise.reject(new Error('conexão com o semeador encerrada'))
    return new Promise((resolve, reject) => {
      const waiter = {
        length,
        resolve: (n) => {
          clearTimeout(timer)
          waiters.delete(waiter)
          resolve(n)
        },
        reject: (err) => {
          clearTimeout(timer)
          waiters.delete(waiter)
          reject(err)
        }
      }
      const timer = setTimeout(() => waiter.reject(new Error('tempo esgotado: semeador não serviu ' + length + ' blocos')), timeoutMs)
      if (timer.unref) timer.unref()
      waiters.add(waiter)
    })
  }

  function onClose () {
    core.off('append', onAppend)
    fail(new Error('conexão com o semeador encerrada'))
    onEvent({ event: 'closed' })
  }

  function close () {
    noise.destroy()
  }
}

module.exports = { connectSeeder }
