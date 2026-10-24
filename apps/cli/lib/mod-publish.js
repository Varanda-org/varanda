'use strict'

// Publishes a signed blocklist snapshot from the operator machine (`mod
// block`, `mod publish` and friends) to ONE node: the association's seeder,
// dialed directly by its Noise public key (`seed status` prints it) with
// hyperswarm's joinPeer. The publisher never joins the association's public
// rendezvous topic and never listens, so it never connects to, or is reached
// by, arbitrary peers of the association. Any connection from another key is
// closed at once.
//
// The publisher is a throwaway peer: a temporary data dir, an empty
// corestore (store.replicate only creates the protomux the channels ride
// on, admission.js:173-176) and an ephemeral Noise key, never the moderator
// or the association key. Who sees the operator machine's address: the
// seeder (association infrastructure) and the DHT nodes that route the
// lookup and the connection to the seeder's key. Peers on the topic do not.
//
// Delivery is decided on the seeder's connection only, and needs BOTH, in
// either order of arrival:
// - its admission hello verified it as a seeder of this association: role
//   'seeder' and a seeder certificate from the association for the very
//   Noise key of the connection (the same check as packages/core/lib/sync.js
//   onMessage 'hello'); and
// - its 'varanda/blocklist/1' `have` equals the new snapshot's
//   (moderatorDate, seq) under compareSnapshots AND its `sig` equals the
//   first 32 hex characters of the new snapshot's signature, i.e. it
//   verified and stored THIS snapshot (blocklist-net.js answers with a have
//   only after offer() adopted).
// A `have` from an unverified peer never counts: anyone can echo the have
// the publisher itself sends first. From the seeder the nodes fan the
// snapshot out (C4).
//
// Conflict: a verified seeder whose have has the same (moderatorDate, seq)
// but another sig holds a DIFFERENT snapshot under the same ordering key
// (the operator restored an old backup of the moderation dir and signed a
// new change at a seq already used). The seeder keeps its own ('stale' for
// ours) and the publisher never even sends ours (equal keys), so publishing
// stops at once with { delivered: false, conflict: true }.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { createSwarm, generateNoiseKeyPair, refuseOverConnectionLimit, attachAdmission } = require('@varanda/core/lib/net')
const { attachBlocklist, SIG_HEX_LENGTH } = require('@varanda/core/lib/blocklist-net')
const { compareSnapshots } = require('@varanda/core/lib/blocklist')
const { seederCertForKey } = require('@varanda/core/lib/cert')

const DEFAULT_TIMEOUT_MS = 30000
// hyperswarm 4 gives up on an explicit peer after a few failed attempts
// (index.js _attemptClientConnections, attempts >= 5); joinPeer again
// re-queues it, and is a no-op while a connection to that key is open or in
// flight (index.js joinPeer, _allConnections.has).
const REDIAL_MS = 2000
// After delivery: how long the connection may take to end gracefully before
// the swarm is destroyed anyway.
const END_WAIT_MS = 2000
const HEX64_RE = /^[0-9a-f]{64}$/

function noop () {}

// offer() of a publisher: whatever a peer sends is not adopted. 'stale' is
// never counted as a bad message by the peer-side rules (blocklist-net.js
// BAD_REASONS), and the publisher's own snapshot stays the one it announces.
async function refuseOffer () {
  return { adopted: false, reason: 'stale', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() }
}

// Ends the socket and waits (bounded) for it to close, so nothing still
// queued on it is cut by swarm.destroy().
function endGracefully (socket) {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve()
    const timer = setTimeout(resolve, END_WAIT_MS)
    if (timer.unref) timer.unref()
    socket.once('close', () => { clearTimeout(timer); resolve() })
    try {
      socket.end()
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

// Resolves { delivered, conflict, peers }: delivered is true as soon as the
// verified seeder holds the snapshot, false after timeoutMs without that or
// at once on a conflict (conflict true, see the header). `peers`
// counts connections from the seeder's key. Never prints or returns a peer
// address. Everything it opened is closed and the temp dir removed before it
// resolves.
async function publish ({ snapshot, association, seeder, bootstrap, host, timeoutMs = DEFAULT_TIMEOUT_MS, log = noop } = {}) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('snapshot required')
  if (typeof seeder !== 'string' || !HEX64_RE.test(seeder)) throw new TypeError('seeder key required')
  const seederKey = b4a.from(seeder, 'hex')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-mod-'))
  let store = null
  let swarm = null
  let timer = null
  let redial = null
  let peers = 0
  let deliveredOn = null
  let conflict = false
  const ownSig = typeof snapshot.signature === 'string' ? snapshot.signature.slice(0, SIG_HEX_LENGTH) : ''
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })

  try {
    store = new Corestore(path.join(tmp, 'store'))
    await store.ready()
    swarm = createSwarm({ bootstrap, host, keyPair: generateNoiseKeyPair() })
    swarm.on('connection', (socket) => {
      socket.on('error', noop)
      // Only the seeder's key is ever dialed and the swarm never listens;
      // anything else is closed before a channel is opened on it.
      if (!socket.remotePublicKey || !b4a.equals(socket.remotePublicKey, seederKey)) {
        socket.destroy()
        return
      }
      if (refuseOverConnectionLimit(swarm, socket, { log })) return
      peers++
      let verified = false
      let holds = false
      let differs = false
      const check = () => {
        if (!verified || deliveredOn !== null || conflict) return
        if (holds) {
          deliveredOn = socket
          resolveDone(true)
        } else if (differs) {
          conflict = true
          resolveDone(false)
        }
      }
      try {
        store.replicate(socket)
        // Blocklist first, before the hello (C2): whichever side opens the
        // channel first is paired.
        attachBlocklist(socket, {
          current: () => snapshot,
          offer: refuseOffer,
          compare: compareSnapshots,
          log,
          onhave: (have) => {
            const sameKey = compareSnapshots(have, snapshot) === 0
            holds = sameKey && have.sig === ownSig
            differs = sameKey && have.sig !== ownSig
            check()
          }
        })
        // An empty member hello keeps the seeder from dropping us on its
        // hello timeout before the snapshot is through; ITS hello is what
        // proves it is a seeder of this association.
        attachAdmission(socket, {
          role: 'member',
          have: [],
          log,
          onmessage: (msg, peer) => {
            if (msg.type !== 'hello') return
            verified = msg.role === 'seeder' &&
              peer.peerKey === seeder &&
              seederCertForKey(peer.remoteCert, peer.peerKey, association).ok
            check()
          }
        })
      } catch (err) {
        log({ event: 'publish-peer-error', error: err.message })
        socket.destroy()
      }
    })
    timer = setTimeout(() => resolveDone(false), timeoutMs)
    // Never swarm.join(topic): only this one key is dialed.
    swarm.joinPeer(seederKey)
    redial = setInterval(() => {
      if (!swarm.destroyed) swarm.joinPeer(seederKey)
    }, REDIAL_MS)
    if (redial.unref) redial.unref()
    const delivered = await done
    if (delivered) await endGracefully(deliveredOn)
    return { delivered, conflict, peers }
  } finally {
    if (timer) clearTimeout(timer)
    if (redial) clearInterval(redial)
    if (swarm !== null) {
      try { swarm.leavePeer(seederKey) } catch {}
      try { await swarm.destroy() } catch {}
    }
    if (store !== null) {
      try { await store.close() } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

module.exports = { publish, DEFAULT_TIMEOUT_MS }
