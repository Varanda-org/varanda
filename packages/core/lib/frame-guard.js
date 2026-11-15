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
// built so that the attacker, not the other members, pays for it (all frame
// times below are ACTIVE times, see "Local backpressure"):
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
//   + ceil(len / FRAME_MIN_BYTES_PER_S) x 1000 ms) of its header, a deadline
//   that body bytes never refresh (a one-byte drip does not extend it; the
//   socket idle timeout alone would). FRAME_DEADLINE_CAP_MS is derived, not
//   chosen: FRAME_DEADLINE_BASE_MS + ceil(MAX_EXTERNAL_FRAME /
//   FRAME_MIN_BYTES_PER_S) x 1000 = 10 s + 129 s = 139 s, so a maximum frame
//   sent at exactly the minimum rate (129 s) completes with one base window
//   of margin, and the cap stays bounded by the frame limit. A charged frame
//   is also checked every FRAME_DEADLINE_BASE_MS: at the k-th check its body
//   bytes received since the header must be at least (k - 1) x
//   FRAME_DEADLINE_BASE_MS x FRAME_MIN_BYTES_PER_S / 1000, i.e. 64 KiB/s on
//   average after one base window of grace, so a drip is dropped at the
//   second check (20 s) instead of at the cap. Both drops are
//   'frame-deadline';
// - frame memory budget: the Seeder keeps one counter of the bytes reserved
//   by charged frames across all external guards (maxFrameMemory, default
//   MAX_FRAME_MEMORY), held until that frame completes or the guard is
//   destroyed (never per body byte). When a reservation does not fit, the
//   newcomer loses (frameVictims): only a charged guard that is evictable
//   (FrameGuard#evictable: its reservation is at least
//   FRAME_EVICT_MIN_AGE_MS old AND it is stalled, no byte for
//   FRAME_DEADLINE_BASE_MS, or too slow, fewer body bytes than
//   FRAME_MIN_BYTES_PER_S over its age minus FRAME_EVICT_MIN_AGE_MS) may be
//   evicted, lowest progress (received / declared) first and only as many
//   as the requester needs ('frame-budget'). If evicting every evictable
//   guard would still not make room, nobody is evicted and only the
//   requester is dropped ('frame-budget'). A frame keeping up with the
//   minimum rate is never evicted for a newer declaration, so a burst of
//   new maximum declarations (immune in their first second) cannot displace
//   a member's large frame; an old stalled declaration cannot keep a member
//   out either, because uncharged frames never touch the budget and a
//   stalled reservation past the minimum eviction age gives way to a
//   newcomer that needs its room.
//   Accepted cost of this rule (maintainers' decision, 2026-11-15): while
//   older reservations keep up with the minimum rate, or are still in their
//   first FRAME_EVICT_MIN_AGE_MS, the budget stays full and a newer charged
//   frame that does not fit is refused, an honest one included. A peer that
//   sends only whole frames, as members over WebSocket do, is never charged,
//   so never refused. That is bounded per frame by the cap and MAX_EXTERNAL_FRAME,
//   per socket by one charged frame at a time and in total by the budget,
//   and the refused frame is never corrupted (nothing of it is forwarded).
// Local backpressure: when our consumer lags, push() returns false and the
// guard pauses raw. While raw is paused by the guard, the frame deadline,
// the throughput checks and the eviction age stop (they run on active time,
// clock time minus that paused time) and resume when the consumer reads
// again (_read): bytes we did not read are not the peer's fault, and a
// paused consumer must not drop an honest peer as slow. This cannot be used
// to hold memory for free: (1) the pause is ours, the peer cannot cause it
// with the frame itself, because secret-stream forwards nothing of an
// incomplete frame, and while that frame is incomplete every byte the peer
// sends is part of it, so our consumer can only lag on data received BEFORE
// the frame's header, a finite backlog; (2) what a paused frame holds is
// its reservation, already bounded per frame by MAX_EXTERNAL_FRAME and in
// total by the budget; (3) on the seeder, secret-stream's idle timeout
// (EXTERNAL_IDLE_MS) is refreshed only by bytes the guard forwards, so a
// socket that stays paused drops after 30 s anyway; (4) once reading
// resumes, the peer owes the minimum rate again from where it stood.
// The budget covers declared-but-incomplete frames, the amplified vector. It
// does not cover the bytes the `ws` library buffers for a partial WebSocket
// message before FrameGuard (apps/cli/lib/seed-ws.js): those are bytes the
// client actually sent (not amplified), at most MAX_PAYLOAD per socket, and
// the 30 s idle deadline drops a socket that stops sending them. Sizing rule:
// worst-case receive memory is about maxExternal x MAX_PAYLOAD +
// maxFrameMemory (plus at most SMALL_FRAME_BYTES of uncharged frame per
// socket, negligible next to MAX_PAYLOAD).
// The budget and the deadlines are options: the seeder injects its
// seeder-wide budget (lib/seeder.js _frameBudget); a guard without one
// charges an unlimited budget. The browser client (a single link to bound)
// also passes deadlines: false, so only the size bounds apply there.
const { Duplex } = require('streamx')

const HANDSHAKE_FRAMES = 2 // Noise XX responder: receives e, then s+se
const MAX_HANDSHAKE_FRAME = 1024
const MAX_HANDSHAKE_BYTES = HANDSHAKE_FRAMES * (3 + MAX_HANDSHAKE_FRAME)
const MAX_EXTERNAL_FRAME = 8 * 1024 * 1024 + 64 * 1024
const HEADER_MUL = [1, 256, 65536]
const FRAME_DEADLINE_BASE_MS = 10000
const FRAME_MIN_BYTES_PER_S = 65536
// The time a MAX_EXTERNAL_FRAME takes at exactly FRAME_MIN_BYTES_PER_S (129
// s) plus one base window of margin: 139 s. A maximum frame that keeps the
// minimum rate always completes before the cap.
const FRAME_DEADLINE_CAP_MS = FRAME_DEADLINE_BASE_MS + Math.ceil(MAX_EXTERNAL_FRAME / FRAME_MIN_BYTES_PER_S) * 1000
const MAX_FRAME_MEMORY = 64 * 1024 * 1024
const SMALL_FRAME_BYTES = 64 * 1024
const FRAME_EVICT_MIN_AGE_MS = 1000
// The 3-byte header cannot declare more than this; a larger option would be
// a silent no-op bound, so it is refused.
const MAX_DECLARABLE = 0xffffff
// Default budget of a guard without one: never refuses a reservation.
const UNLIMITED_BUDGET = Object.freeze({ reserve: () => true, release: noop })
// Monotonic time and real timers. Frame times must never jump with a
// wall-clock step (a forward step would cut honest frames, a backward one
// extend deadlines), so `now` is performance.now() where the runtime has it
// (Node, browsers); Bare defines no `performance`, and the seeder injects
// its own monotonic clock (lib/clock.js) anyway. Wrapped so a browser never
// calls them with a foreign `this`. Tests inject a fake clock with the same
// three functions.
const HAS_PERFORMANCE = typeof performance === 'object' && performance !== null && typeof performance.now === 'function'
const REAL_CLOCK = Object.freeze({
  now: HAS_PERFORMANCE ? () => performance.now() : () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer)
})

// Time a frame declaring len bytes has to complete once its header did.
function frameDeadlineFor (len, baseMs = FRAME_DEADLINE_BASE_MS, capMs = FRAME_DEADLINE_CAP_MS) {
  return Math.min(capMs, baseMs + Math.ceil(len / FRAME_MIN_BYTES_PER_S) * 1000)
}

// The guards a budget evicts so that `need` more bytes fit: only evictable
// ones (FrameGuard#evictable: stalled or below the minimum throughput, never
// in their first minAgeMs), lowest progress first, and no more than needed.
// null when evicting all of them would still not free `need` bytes: then
// nobody is evicted and the requester alone is refused (the newcomer loses).
function frameVictims (guards, need, minAgeMs = FRAME_EVICT_MIN_AGE_MS) {
  const eligible = []
  for (const guard of guards) {
    if (guard.evictable(minAgeMs)) eligible.push(guard)
  }
  eligible.sort((a, b) => a.progress() - b.progress())
  const victims = []
  let freed = 0
  for (const guard of eligible) {
    if (freed >= need) break
    victims.push(guard)
    freed += guard.reserved
  }
  return freed >= need ? victims : null
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
// another, evictable guard to make room; unlimited by default) until it
// completes, and it is checked every deadlineBaseMs for the minimum
// throughput. Every incomplete frame must complete within
// frameDeadlineFor(len, deadlineBaseMs, deadlineCapMs). Time spent with raw
// paused by the guard's own backpressure counts for neither. Over a limit
// the guard calls onLimit(reason) ('frame-limit', 'frame-budget' or 'frame-deadline'),
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
    deadlines = true,
    // { now, setTimeout, clearTimeout }; now must be monotonic milliseconds
    // (the seeder passes lib/clock.js, tests a fake clock).
    clock = REAL_CLOCK
  } = {}) {
    // Validated before any listener is attached to raw.
    if (typeof deadlines !== 'boolean') throw new TypeError('FrameGuard: deadlines must be a boolean')
    if (clock === null || typeof clock !== 'object' || typeof clock.now !== 'function' || typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function') {
      throw new TypeError('FrameGuard: clock must have now, setTimeout and clearTimeout functions')
    }
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
    this._clock = clock
    this._frames = 0 // complete incoming frames parsed so far
    this._header = 0 // header bytes of the current frame read so far (0..2)
    this._len = 0 // declared length being assembled from the header
    this._frameLen = 0 // declared length of the current incomplete frame
    this._remaining = 0 // body bytes of the current frame still to come
    this._received = 0 // body bytes of the current frame received so far
    this._reserved = 0 // budget bytes held for the current incomplete frame
    // Frame times are ACTIVE times (_activeNow): time spent with raw paused
    // by this guard's own backpressure does not count against the peer.
    this._frameStart = null // when the current incomplete frame's deadline started
    this._reservedAt = 0 // when the current reservation was made
    this._lastByteAt = 0 // when the current incomplete frame last received bytes
    this._pausedAt = null // clock time raw was paused by backpressure, or null
    this._pausedMs = 0 // clock time spent paused by backpressure, before _pausedAt
    this._timer = null // completion deadline of the current incomplete frame
    this._progress = null // next throughput check of the current charged frame
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
    if (this.push(chunk) === false) this._pauseRaw()
  }

  // Local backpressure: our consumer lags, so raw stops being read and the
  // current frame's clock stops with it (resumed in _read).
  _pauseRaw () {
    if (this._pausedAt === null) {
      this._pausedAt = this._clock.now()
      this._disarmTimers()
    }
    this._raw.pause()
  }

  // Clock time minus the time raw spent paused by this guard's backpressure.
  _activeNow () {
    const now = this._clock.now()
    return now - this._pausedMs - (this._pausedAt === null ? 0 : now - this._pausedAt)
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
    const now = this._activeNow()
    if (this._frameLen > this._smallBytes && this._reserved === 0) {
      if (!this._budget.reserve(this._frameLen, this)) return 'frame-budget'
      this._reserved = this._frameLen
      this._reservedAt = now
      this._checks = 0
    }
    // The chunk's last byte belongs to this frame (its header or its body).
    this._lastByteAt = now
    // One deadline per incomplete frame, started when its header completed
    // and never refreshed by its body bytes (the outer bound of a charged
    // frame too).
    if (this._frameStart === null) this._frameStart = now
    this._armTimers()
    return null
  }

  // (Re)arms the deadline and the next throughput check of the current
  // incomplete frame for the active time each has left. Nothing is armed
  // while raw is paused by backpressure: _read re-arms on resume.
  _armTimers () {
    if (!this._deadlines || this._frameStart === null || this._pausedAt !== null || this.destroying) return
    const now = this._activeNow()
    if (this._timer === null) {
      const left = frameDeadlineFor(this._frameLen, this._deadlineBaseMs, this._deadlineCapMs) - (now - this._frameStart)
      this._timer = this._setTimer(() => {
        this._timer = null
        this._limit('frame-deadline')
      }, left)
    }
    if (this._reserved > 0 && this._progress === null) {
      const left = (this._checks + 1) * this._deadlineBaseMs - (now - this._reservedAt)
      this._progress = this._setTimer(() => {
        this._progress = null
        this._checkProgress()
      }, left)
    }
  }

  _setTimer (fn, ms) {
    const timer = this._clock.setTimeout(fn, Math.max(0, ms))
    if (timer && timer.unref) timer.unref()
    return timer
  }

  _disarmTimers () {
    if (this._timer !== null) {
      this._clock.clearTimeout(this._timer)
      this._timer = null
    }
    if (this._progress !== null) {
      this._clock.clearTimeout(this._progress)
      this._progress = null
    }
  }

  // The k-th check of a charged frame, k base windows of active time after
  // its reservation, requires (k - 1) base windows' worth of
  // FRAME_MIN_BYTES_PER_S: the first window is grace.
  _checkProgress () {
    this._checks++
    const owed = (this._checks - 1) * this._deadlineBaseMs * FRAME_MIN_BYTES_PER_S / 1000
    if (this._received < owed) return this._limit('frame-deadline')
    this._armTimers()
  }

  // Share of the current charged frame received so far (eviction order).
  progress () {
    return this._frameLen > 0 ? this._received / this._frameLen : 1
  }

  // Budget bytes held for the current incomplete frame.
  get reserved () {
    return this._reserved
  }

  // Whether a budget may evict this guard to make room for another one.
  // Only a charged frame older than minAgeMs of active time that is stalled
  // (no byte for a base window) or too slow (below FRAME_MIN_BYTES_PER_S on
  // average once minAgeMs of grace is over) qualifies; a frame keeping up
  // with the minimum rate never does. Paused time is not active time, so
  // our own backpressure never makes a frame evictable.
  evictable (minAgeMs) {
    if (this._reserved === 0 || this.destroying) return false
    const now = this._activeNow()
    const age = now - this._reservedAt
    if (age < minAgeMs) return false
    if (now - this._lastByteAt >= this._deadlineBaseMs) return true
    return this._received < (age - minAgeMs) * FRAME_MIN_BYTES_PER_S / 1000
  }

  // Dropped by the budget to make room for another guard: releases the
  // reservation at once (so the requester's reservation fits), then drops.
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
    this._disarmTimers()
    this._frameStart = null
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
    if (this._pausedAt !== null) {
      this._pausedMs += this._clock.now() - this._pausedAt
      this._pausedAt = null
      this._armTimers()
    }
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
  frameVictims,
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
