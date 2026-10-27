'use strict'

// Frame guard for streams from untrusted peers. @hyperswarm/secret-stream
// 6.9.2 frames the raw bytes as a 3-byte little-endian length followed by the
// body and allocates every declared length (up to 16 MiB) as soon as the
// first body byte arrives, BEFORE the Noise handshake completes: an anonymous
// client sending `ff ff ff 00` costs the receiver ~16 MiB per connection.
// FrameGuard sits between the raw stream and the secret stream and parses
// the framing of the incoming bytes before forwarding them.
//
// This module depends on streamx only (no fs, net, hyperswarm or hypercore),
// so a browser bundle can reuse it in front of its own secret stream
// (test/browser-safe.test.js keeps it that way).
//
// Limits, measured on the installed libraries (secret-stream 6.9.2, Noise XX,
// hypercore 11.39.0, corestore 7.15.0, protomux 3) with a member diary of
// near-16 KiB blocks (16 265 bytes) and a hello carrying the maximum
// inventory (4096 keys) replicating through the seeder's acceptStream over
// loopback TCP:
// - the responder receives exactly HANDSHAKE_FRAMES handshake frames, msg1
//   (`e`) of 32 bytes and msg3 (`s, se`) of 64 bytes, 102 bytes with their
//   headers. Each must declare at most MAX_HANDSHAKE_FRAME = 1024 bytes
//   (16 x msg3), so everything up to and including the second frame is at
//   most MAX_HANDSHAKE_BYTES = HANDSHAKE_FRAMES x (3 + MAX_HANDSHAKE_FRAME)
//   = 2054 bytes, a derived bound (no separate budget is kept). The Noise XX
//   INITIATOR receives a single handshake frame (msg2, `e, ee, s, es`), so
//   a guard on the initiator's side passes `handshakeFrames: 1`: with the
//   responder default its first post-handshake frame would be judged by the
//   handshake limit and a valid peer refused.
// - every frame after the handshake frames is a post-handshake frame and must
//   declare at most MAX_EXTERNAL_FRAME, whether or not the secret stream has
//   confirmed the handshake yet. Anyone completes a Noise XX handshake with
//   an arbitrary key pair for free, so the bytes after the last handshake
//   frame are exposed to the post-handshake bound in any case; judging them
//   by a stricter pre-'connect' rule buys no security and refuses valid
//   members: a coalescing transport delivers a member's first post-handshake
//   writes (its stream-id header and the channel opens of every core it
//   replicates, 500 opens are ~43 KiB) in the same chunk as msg3.
//   The largest frame seen after 'connect' was 16 477 bytes (one block and
//   its proof; 40 blocks, 61 frames), but the code allows far more: hypercore
//   corks the muxer while it answers its queue of block requests
//   (replicator.js _handleRequests) and protomux flushes a corked batch only
//   once it reaches MAX_BATCH = 8 MiB, so a member answering up to 512
//   in-flight requests for near-16 KiB blocks may legitimately send a frame
//   of up to MAX_BATCH plus one message. MAX_EXTERNAL_FRAME is therefore
//   MAX_BATCH plus a 64 KiB margin for that last message and its encoding;
//   it is a code bound, not a measured one, because a tighter value would
//   break legitimate replication. Residual risk: a peer that completed the
//   handshake (not necessarily admitted) can still make the receiver allocate
//   up to MAX_EXTERNAL_FRAME per frame.
const { Duplex } = require('streamx')

const HANDSHAKE_FRAMES = 2 // Noise XX responder: receives e, then s+se
const MAX_HANDSHAKE_FRAME = 1024
const MAX_HANDSHAKE_BYTES = HANDSHAKE_FRAMES * (3 + MAX_HANDSHAKE_FRAME)
const MAX_EXTERNAL_FRAME = 8 * 1024 * 1024 + 64 * 1024
const HEADER_MUL = [1, 256, 65536]
// The 3-byte header cannot declare more than this; a larger option would be
// a silent no-op bound, so it is refused.
const MAX_DECLARABLE = 0xffffff

function checkLimit (name, value, min) {
  if (!Number.isInteger(value) || value < min || value > MAX_DECLARABLE) {
    throw new TypeError('FrameGuard: ' + name + ' must be an integer in [' + min + ', ' + MAX_DECLARABLE + ']')
  }
}

// A streamx Duplex proxy over a raw duplex: writes pass through unchanged,
// incoming bytes are parsed with the secret-stream framing before they are
// pushed, and close/destroy/error propagate both ways. The first
// `handshakeFrames` frames (2 for the Noise XX responder, 1 for the
// initiator) may declare at most `maxHandshakeFrame` bytes each, every later
// frame at most `maxFrame`; nothing is held back (the secret stream parses
// the same framing and handles post-handshake bytes that arrive in the chunk
// of the last handshake frame exactly as it does over TCP). Over a limit the
// guard calls onLimit, destroys itself and the raw stream, and the offending
// chunk is never forwarded, not even its frames before the offending one.
class FrameGuard extends Duplex {
  constructor (raw, { onLimit, handshakeFrames = HANDSHAKE_FRAMES, maxHandshakeFrame = MAX_HANDSHAKE_FRAME, maxFrame = MAX_EXTERNAL_FRAME } = {}) {
    checkLimit('handshakeFrames', handshakeFrames, 1)
    checkLimit('maxHandshakeFrame', maxHandshakeFrame, 0)
    checkLimit('maxFrame', maxFrame, 0)
    super()
    this._raw = raw
    this._onLimit = typeof onLimit === 'function' ? onLimit : noop
    this._handshakeFrames = handshakeFrames
    this._maxHandshakeFrame = maxHandshakeFrame
    this._maxFrame = maxFrame
    this._frames = 0 // complete incoming frames parsed so far
    this._header = 0 // header bytes of the current frame read so far (0..2)
    this._len = 0 // declared length being assembled from the header
    this._remaining = 0 // body bytes of the current frame still to come
    this._drainCb = null
    raw.on('data', (chunk) => this._onRawData(chunk))
    // A peer that ends its side before every handshake frame arrived can
    // never complete the handshake: drop it now instead of holding a
    // connection slot until the handshake deadline.
    raw.on('end', () => {
      if (this._frames < this._handshakeFrames) return this.destroy()
      this.push(null)
    })
    raw.on('error', (err) => this.destroy(err))
    raw.on('close', () => {
      this._releaseDrain()
      this.destroy()
    })
    raw.on('drain', () => this._releaseDrain())
  }

  _onRawData (chunk) {
    if (this.destroying) return
    if (!this._parse(chunk)) return this._limit()
    if (this.push(chunk) === false) this._raw.pause()
  }

  // Parses the framing of the whole chunk (parser state carries over between
  // chunks). Returns false when a frame declares more than its limit.
  _parse (chunk) {
    let offset = 0
    while (offset < chunk.byteLength) {
      if (this._remaining > 0) {
        const n = Math.min(this._remaining, chunk.byteLength - offset)
        this._remaining -= n
        offset += n
        if (this._remaining === 0) this._frames++
        continue
      }
      this._len += chunk[offset++] * HEADER_MUL[this._header]
      if (++this._header < 3) continue
      const len = this._len
      this._header = 0
      this._len = 0
      const limit = this._frames < this._handshakeFrames ? this._maxHandshakeFrame : this._maxFrame
      if (len > limit) return false
      this._remaining = len
      if (len === 0) this._frames++
    }
    return true
  }

  _limit () {
    if (this.destroying) return
    // A throwing onLimit (a failing logger) must never skip the destroy: the
    // over-limit header is already consumed here, so a socket left open would
    // let the next bytes complete a length the secret stream already holds
    // part of, and force the very allocation this guard exists to stop.
    try { this._onLimit() } catch {}
    this.destroy(new Error('frame over the limit'))
  }

  _read (cb) {
    this._raw.resume()
    cb(null)
  }

  _write (data, cb) {
    if (this._raw.destroyed) return cb(null)
    if (this._raw.write(data) === false) this._drainCb = cb
    else cb(null)
  }

  _releaseDrain () {
    const cb = this._drainCb
    if (cb === null) return
    this._drainCb = null
    cb(null)
  }

  _final (cb) {
    this._raw.end()
    cb(null)
  }

  _predestroy () {
    this._raw.destroy()
    this._releaseDrain()
  }

  _destroy (cb) {
    cb(null)
  }
}

function noop () {}

module.exports = { FrameGuard, HANDSHAKE_FRAMES, MAX_HANDSHAKE_FRAME, MAX_HANDSHAKE_BYTES, MAX_EXTERNAL_FRAME }
