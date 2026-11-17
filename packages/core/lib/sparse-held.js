'use strict'

// A seeder keeps a cut writer sparse (#350, docs/protocol.md "Sparse
// copies"): its blocks below the cut, then only its leaves and key blocks.
// A reader holding such a copy is as caught up as its peers let it be once
// every block a connected peer advertises below the signed length is held.
// Hypercore (10 and 11) keeps what a peer advertises per replicator Peer
// (core.peers, as deletion.js advertisedBy reads it): its contiguous range,
// then its bitfield. Past that range the bitfield only arrives as the answer
// to the want a download range sends, so until a page of it is here a block
// the peer holds there reads as not advertised: such a peer has not
// answered yet, and a goal that trusted it would end before the block came.
// Browser-safe: no Node built-ins.

// RemoteBitfield's page size, the same in Hypercore 10 and 11.
const BITFIELD_PAGE = 32768

// Whether `peer` has told this core what it holds of [its contiguous
// length, end): it has synced, and either holds nothing past its contiguous
// range below end or a page of its bitfield covering that range arrived.
function peerAnswered (peer, end) {
  if (peer.remoteSynced !== true) return false
  const from = peer.remoteContiguousLength
  const to = Math.min(end, peer.remoteLength || 0)
  if (from >= to) return true
  for (let p = Math.floor(from / BITFIELD_PAGE); p * BITFIELD_PAGE < to; p++) {
    if (peer.remoteBitfield.getBitfield(p * BITFIELD_PAGE) === null) return false
  }
  return true
}

// The first block of [from, end) `peer` advertises, or -1.
function nextAdvertised (peer, from, end) {
  if (from < peer.remoteContiguousLength) return from < end ? from : -1
  const bits = peer.remoteBitfield
  if (typeof bits.firstSet === 'function') {
    const i = bits.firstSet(from)
    return i >= 0 && i < end ? i : -1
  }
  for (let i = from; i < end; i++) if (bits.get(i) === true) return i
  return -1
}

// -> true once some connected peer of `core` has synced, every synced peer
// has answered for the blocks below `end` (peerAnswered) and every block
// below `end` one of them advertises is held. A peer that has not synced
// yet is not waited for. Never throws (false on any error).
async function advertisedHeld (core, end) {
  try {
    const peers = [...core.peers].filter((p) => p.remoteSynced === true)
    if (peers.length === 0) return false
    for (const peer of peers) if (!peerAnswered(peer, end)) return false
    const from = core.contiguousLength
    for (const peer of peers) {
      let i = nextAdvertised(peer, from, end)
      while (i !== -1) {
        if (!(await core.has(i))) return false
        i = nextAdvertised(peer, i + 1, end)
      }
    }
    return true
  } catch {
    return false
  }
}

module.exports = { advertisedHeld, peerAnswered, BITFIELD_PAGE }
