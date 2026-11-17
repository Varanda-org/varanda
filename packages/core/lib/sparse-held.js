'use strict'

// A seeder keeps a cut writer sparse (#350, docs/protocol.md "Sparse
// copies"): its blocks below the cut, then only its leaves and key blocks.
// A reader holding such a copy is as caught up as its peers let it be once
// every block a connected peer advertises below the signed length is held.
// Hypercore (10 and 11) keeps what a peer advertises per replicator Peer
// (core.peers, as deletion.js advertisedBy reads it): its contiguous range,
// then its bitfield. Past that range the bitfield only arrives as the answer
// to the want a download range sends: one want per bitfield segment, which
// the peer answers with one message from the segment's first block up to
// the last page it has in it. Until that answer is here a block the peer
// holds there reads as not advertised: such a peer has not answered yet,
// and a goal that trusted it would end before the block came.
// Browser-safe: no Node built-ins.

// RemoteBitfield's segment size, the same in Hypercore 10 and 11: a want
// asks for one segment.
const BITFIELD_SEGMENT = 2097152

// Whether `peer` has told this core what it holds of [from, end) past its
// contiguous range: it has synced, and either holds nothing past that range
// below end or the answer for each bitfield segment of it arrived. That
// answer always carries the segment's first page; a later page the peer
// holds nothing in is never sent, so its absence once the first page is
// here means nothing held there, not a missing answer.
function peerAnswered (peer, end, from = 0) {
  if (peer.remoteSynced !== true) return false
  const start = Math.max(from, peer.remoteContiguousLength)
  const to = Math.min(end, peer.remoteLength || 0)
  if (start >= to) return true
  for (let s = Math.floor(start / BITFIELD_SEGMENT); s * BITFIELD_SEGMENT < to; s++) {
    if (peer.remoteBitfield.getBitfield(s * BITFIELD_SEGMENT) === null) return false
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
// has answered for the blocks of [from, end) (peerAnswered) and every block
// of it one of them advertises is held. A peer that has not synced yet is
// not waited for. Never throws (false on any error).
async function advertisedHeld (core, end, from = 0) {
  try {
    const peers = [...core.peers].filter((p) => p.remoteSynced === true)
    if (peers.length === 0) return false
    for (const peer of peers) if (!peerAnswered(peer, end, from)) return false
    const start = Math.max(from, core.contiguousLength)
    for (const peer of peers) {
      let i = nextAdvertised(peer, start, end)
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

// What `core` holds, as Hypercore 10 and 11 keep it: core.core.bitfield, the
// structure has() itself reads for an open default session. null for any
// other session (a snapshot, a batch), which then asks has() per block.
function heldBits (core) {
  try {
    if (core.opened !== true) return null
    if (core.state && typeof core.state.isDefault === 'function' && !core.state.isDefault()) return null
    const bits = core.core && core.core.bitfield
    return bits && typeof bits.firstSet === 'function' ? bits : null
  } catch {
    return null
  }
}

// The first block of [from, end) `core` holds, or -1: a sparse copy past
// its hole is mostly empty, and a scan of has() per block would cost its
// signed length.
async function nextHeld (core, from, end) {
  const bits = heldBits(core)
  if (bits !== null) {
    const i = bits.firstSet(from)
    return i >= 0 && i < end ? i : -1
  }
  for (let i = from; i < end; i++) if (await core.has(i)) return i
  return -1
}

module.exports = { advertisedHeld, peerAnswered, nextHeld, BITFIELD_SEGMENT }
