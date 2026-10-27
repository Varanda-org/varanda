'use strict'

// Frame guard for streams from untrusted peers. @hyperswarm/secret-stream
// 6.9.2 frames the raw bytes as a 3-byte little-endian length followed by the
// body and allocates every declared length (up to 16 MiB) as soon as the
// first body byte arrives, BEFORE the Noise handshake completes: an anonymous
// client sending `ff ff ff 00` costs the receiver ~16 MiB per connection.
// FrameGuard sits between the raw stream and the secret stream and parses
// the framing of the incoming bytes before forwarding them. The seeder puts
// it in front of every external stream (lib/seeder.js acceptStream); the
// browser client puts it in front of its own secret stream
// (@varanda/web-member lib/ws-stream.js guardedWsStream).
//
// This module depends on streamx only (no fs, net, hyperswarm or hypercore),
// so a browser bundle can reuse it (test/browser-safe.test.js keeps it that
// way).
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
//   break legitimate replication.
// Size alone does not bound memory: a peer that completed the handshake (not
// necessarily admitted) may declare up to MAX_EXTERNAL_FRAME and then send
// the body one byte at a time, and secret-stream keeps the whole declared
// length allocated from the first body byte on. Three more bounds close that,
// built so that the attacker, not the other members, pays for it:
// - charged frames: only a frame that can amplify memory is charged to the
//   budget below, i.e. one that declares more than SMALL_FRAME_BYTES (64 KiB)
//   AND is still incomplete at the end of the chunk being parsed. A frame
//   whose body arrives within the chunk is never charged, nor is a small
//   frame split across chunks (at most 64 KiB per socket, the same order as
//   the bytes a client actually sends; handshake frames and keep-alives are
//   always small). A charged frame reserves its whole declared length, since
//   that is what secret-stream allocates;
// - frame deadline: every incomplete frame must complete within
//   frameDeadlineFor(len) = min(FRAME_DEADLINE_CAP_MS, FRAME_DEADLINE_BASE_MS
//   + ceil(len / FRAME_MIN_BYTES_PER_S) x 1000 ms) of its header, one timer
//   per frame that body bytes never refresh (a one-byte drip does not extend
//   it; the socket idle timeout alone would). A charged frame is also checked
//   every FRAME_DEADLINE_BASE_MS: at the k-th check its body bytes received
//   since the header must be at least (k - 1) x FRAME_DEADLINE_BASE_MS x
//   FRAME_MIN_BYTES_PER_S / 1000, i.e. 64 KiB/s on average after one base
//   window of grace, so a drip is dropped at the second check (20 s) instead
//   of the 120 s cap. Both drops are 'frame-deadline';
// - frame memory budget: the Seeder keeps one counter of the bytes reserved
//   by charged frames across all external guards (maxFrameMemory, default
//   MAX_FRAME_MEMORY), held until that frame completes or the guard is
//   destroyed (never per body byte). When a reservation does not fit, the
//   Seeder evicts the charged guard with the lowest progress (received /
//   declared) among those whose reservation is older than
//   FRAME_EVICT_MIN_AGE_MS ('frame-budget') and retries once; only if it
//   still does not fit is the requester dropped ('frame-budget'). Stalled
//   declarations therefore cannot keep a member out: uncharged frames never
//   touch the budget, and a member's large frame that is making progress
//   displaces them.
// The budget covers declared-but-incomplete frames, the amplified vector. It
// does not cover the bytes the `ws` library buffers for a partial WebSocket
// message before FrameGuard (apps/cli/lib/seed-ws.js): those are bytes the
// client actually sent (not amplified), at most MAX_PAYLOAD per socket, and
// the 30 s idle deadline drops a socket that stops sending them. Sizing rule:
// worst-case receive memory is about maxExternal x MAX_PAYLOAD +
// maxFrameMemory (plus at most SMALL_FRAME_BYTES of uncharged frame per
// socket, negligible next to MAX_PAYLOAD).
// The budget and the deadlines are options: the seeder injects its
// seeder-wide budget (lib/seeder.js _frameBudget); a guard without one (the
// browser client, which has a single link to bound) charges an unlimited
// budget and keeps the deadlines, harmless for an honest peer and a bound on
// a dripping one.
const { Duplex } = require('streamx')

const HANDSHAKE_FRAMES = 2 // Noise XX responder: receives e, then s+se
const MAX_HANDSHAKE_FRAME = 1024
const MAX_HANDSHAKE_BYTES = HANDSHAKE_FRAMES * (3 + MAX_HANDSHAKE_FRAME)
const MAX_EXTERNAL_FRAME = 8 * 1024 * 1024 + 64 * 1024
const HEADER_MUL = [1, 256, 65536]
const FRAME_DEADLINE_CAP_MS = 120000
const FRAME_DEADLINE_BASE_MS = 10000
const FRAME_MIN_BYTES_PER_S = 65536
const MAX_FRAME_MEMORY = 64 * 1024 * 1024
const SMALL_FRAME_BYTES = 64 * 1024
const FRAME_EVICT_MIN_AGE_MS = 1000
// The 3-byte header cannot declare more than this; a larger option would be
// a silent no-op bound, so it is refused.
const MAX_DECLARABLE = 0xffffff
// Default budget of a guard without one: never refuses a reservation.
const UNLIMITED_BUDGET = Object.freeze({ reserve: () => true, release: noop })

// Time a frame declaring len bytes has to complete once its header did.
function frameDeadlineFor (len, baseMs = FRAME_DEADLINE_BASE_MS, capMs = FRAME_DEADLINE_CAP_MS) {
  return Math.min(capMs, baseMs + Math.ceil(len / FRAME_MIN_BYTES_PER_S) * 1000)
}

function checkLimit (name, value, min) {
  if (!Number.isInteger(value) || value < min || value > MAX_DECLARABLE) {
    throw new TypeError('FrameGuard: ' + name + ' must be an integer in [' + min + ', ' + MAX_DECLARABLE + ']')
  }
}

function checkPositive (name, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('FrameGuard: ' + name + ' must be a positive safe integer')
  }
}

// A streamx Duplex proxy over a raw duplex: writes pass through unchanged,
// incoming bytes are parsed with the secret-stream framing before they are
// pushed, and close/destroy/error propagate both ways. The first
// `handshakeFrames` frames (2 for the Noise XX responder, 1 for the
// initiator) may declare at most `maxHandshakeFrame` bytes each, every later
// frame at most `maxFrame`; nothing is held back (the secret stream parses
// the same framing and handles post-handshake bytes that arrive in the chunk
// of the last handshake frame exactly as it does over TCP). A frame
// declaring more than smallBytes that is still incomplete at the end of a
// chunk is charged: its declared length is reserved from budget
// ({ reserve(n, guard) -> boolean, release(n, guard) }, which may evict
// another guard to make room; unlimited by default) until it completes, and
// it is checked every deadlineBaseMs for the minimum throughput. Every
// incomplete frame must complete within frameDeadlineFor(len,
// deadlineBaseMs, deadlineCapMs). Over a limit the guard calls
// onLimit(reason) ('frame-limit', 'frame-budget' or 'frame-deadline'),
// destroys itself and the raw stream, and the offending chunk is never
// forwarded, not even its frames before the offending one.
class FrameGuard extends Duplex {
  constructor (raw, {
    onLimit,
    budget = UNLIMITED_BUDGET,
    handshakeFrames = HANDSHAKE_FRAMES,
    maxHandshakeFrame = MAX_HANDSHAKE_FRAME,
    maxFrame = MAX_EXTERNAL_FRAME,
    deadlineBaseMs = FRAME_DEADLINE_BASE_MS,
    deadlineCapMs = FRAME_DEADLINE_CAP_MS,
    smallBytes = SMALL_FRAME_BYTES,
    // false: no completion deadline and no throughput check. For a client
    // (the browser's links to the seeder), whose only threat here is a
    // declared size, and whose own backpressure (a paused consumer) must
    // never read as a dripping peer and cut an honest link.
    deadlines = true
  } = {}) {
    // Validated before any listener is attached to raw.
    if (typeof deadlines !== 'boolean') throw new TypeError('FrameGuard: deadlines must be a boolean')
    checkLimit('handshakeFrames', handshakeFrames, 1)
    checkLimit('maxHandshakeFrame', maxHandshakeFrame, 0)
    checkLimit('maxFrame', maxFrame, 0)
    checkPositive('deadlineBaseMs', deadlineBaseMs)
    checkPositive('deadlineCapMs', deadlineCapMs)
    checkPositive('smallBytes', smallBytes)
    if (budget === null || typeof budget !== 'object' || typeof budget.reserve !== 'function' || typeof budget.release !== 'function') {
      throw new TypeError('FrameGuard: budget must have reserve and release functions')
    }
    super()
    this._raw = raw
    this._onLimit = typeof onLimit === 'function' ? onLimit : noop
    this._budget = budget
    this._handshakeFrames = handshakeFrames
    this._maxHandshakeFrame = maxHandshakeFrame
    this._maxFrame = maxFrame
    this._deadlineBaseMs = deadlineBaseMs
    this._deadlineCapMs = deadlineCapMs
    this._smallBytes = smallBytes
    this._deadlines = deadlines
    this._frames = 0 // complete incoming frames parsed so far
    this._header = 0 // header bytes of the current frame read so far (0..2)
    this._len = 0 // declared length being assembled from the header
    this._frameLen = 0 // declared length of the current incomplete frame
    this._remaining = 0 // body bytes of the current frame still to come
    this._received = 0 // body bytes of the current frame received so far
    this._reserved = 0 // budget bytes held for the current incomplete frame
    this.reservedAt = 0 // when the current reservation was made (Date.now())
    this._timer = null // completion deadline of the current incomplete frame
    this._progress = null // throughput check of the current charged frame
    this._checks = 0 // throughput checks run on the current charged frame
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
    const reason = this._parse(chunk)
    if (reason !== null) return this._limit(reason)
    if (this.push(chunk) === false) this._raw.pause()
  }

  // Parses the framing of the whole chunk (parser state carries over between
  // chunks), then charges the frame left incomplete at its end when that
  // frame declares more than smallBytes. Returns null, or the drop reason
  // when a frame declares more than its limit ('frame-limit') or a charged
  // frame does not fit in the budget, even after an eviction
  // ('frame-budget').
  _parse (chunk) {
    let offset = 0
    while (offset < chunk.byteLength) {
      if (this._remaining > 0) {
        const n = Math.min(this._remaining, chunk.byteLength - offset)
        this._remaining -= n
        this._received += n
        offset += n
        if (this._remaining === 0) this._completeFrame()
        continue
      }
      this._len += chunk[offset++] * HEADER_MUL[this._header]
      if (++this._header < 3) continue
      const len = this._len
      this._header = 0
      this._len = 0
      const limit = this._frames < this._handshakeFrames ? this._maxHandshakeFrame : this._maxFrame
      if (len > limit) return 'frame-limit'
      if (len === 0) {
        this._frames++
        continue
      }
      this._frameLen = len
      this._received = 0
      this._remaining = len
    }
    if (this._remaining === 0) return null
    // The current frame outlives this chunk. Charge it once, when it can
    // amplify memory (secret-stream allocates the whole declared length).
    if (this._frameLen > this._smallBytes && this._reserved === 0) {
      if (!this._budget.reserve(this._frameLen, this)) return 'frame-budget'
      this._reserved = this._frameLen
      this.reservedAt = Date.now()
      this._checks = 0
      if (this._deadlines) {
        this._progress = setInterval(() => this._checkProgress(), this._deadlineBaseMs)
        if (this._progress.unref) this._progress.unref()
      }
    }
    // One deadline per incomplete frame, armed when its header completed
    // and never refreshed by its body bytes (the outer bound of a charged
    // frame too).
    if (this._deadlines && this._timer === null) {
      this._timer = setTimeout(() => {
        this._timer = null
        this._limit('frame-deadline')
      }, frameDeadlineFor(this._frameLen, this._deadlineBaseMs, this._deadlineCapMs))
      if (this._timer.unref) this._timer.unref()
    }
    return null
  }

  // The k-th check of a charged frame requires (k - 1) base windows' worth
  // of FRAME_MIN_BYTES_PER_S: the first window is grace.
  _checkProgress () {
    this._checks++
    const owed = (this._checks - 1) * this._deadlineBaseMs * FRAME_MIN_BYTES_PER_S / 1000
    if (this._received < owed) this._limit('frame-deadline')
  }

  // Share of the current charged frame received so far (eviction order).
  progress () {
    return this._frameLen > 0 ? this._received / this._frameLen : 1
  }

  // Dropped by the budget to make room for another guard: releases the
  // reservation at once (the caller retries right after), then drops.
  evict () {
    this._clearFrame()
    this._limit('frame-budget')
  }

  _completeFrame () {
    this._frames++
    this._frameLen = 0
    this._clearFrame()
  }

  // Releases the reservation and the timers of the current frame
  // (idempotent).
  _clearFrame () {
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
    if (this._progress !== null) {
      clearInterval(this._progress)
      this._progress = null
    }
    if (this._reserved > 0) {
      this._budget.release(this._reserved, this)
      this._reserved = 0
    }
  }

  _limit (reason) {
    if (this.destroying) return
    // A throwing onLimit (a failing logger) must never skip the destroy: the
    // over-limit header is already consumed here, so a socket left open would
    // let the next bytes complete a length the secret stream already holds
    // part of, and force the very allocation this guard exists to stop.
    try { this._onLimit(reason) } catch {}
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
    this._clearFrame()
    this._raw.destroy()
    this._releaseDrain()
  }

  _destroy (cb) {
    this._clearFrame()
    cb(null)
  }
}

function noop () {}

module.exports = {
  FrameGuard,
  frameDeadlineFor,
  HANDSHAKE_FRAMES,
  MAX_HANDSHAKE_FRAME,
  MAX_HANDSHAKE_BYTES,
  MAX_EXTERNAL_FRAME,
  FRAME_DEADLINE_CAP_MS,
  FRAME_DEADLINE_BASE_MS,
  FRAME_MIN_BYTES_PER_S,
  MAX_FRAME_MEMORY,
  SMALL_FRAME_BYTES,
  FRAME_EVICT_MIN_AGE_MS
}
