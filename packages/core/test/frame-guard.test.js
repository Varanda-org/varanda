'use strict'

// FrameGuard in isolation, over a fake raw duplex: exact limits, one byte
// over, split headers, several frames per chunk, the responder (2 handshake
// frames) vs initiator (1) direction, early EOF, teardown, the frame
// budget (unlimited by default, or injected), the eviction rule of the
// seeder's budget, the frame deadline and local backpressure (time paused by
// the guard itself is not counted). The end-to-end
// behaviour through Seeder.acceptStream is covered by
// packages/core/test/seeder-stream.test.js.
const test = require('brittle')
const { EventEmitter } = require('node:events')
const b4a = require('b4a')
const {
  FrameGuard,
  frameDeadlineFor,
  frameVictims,
  HANDSHAKE_FRAMES,
  MAX_HANDSHAKE_FRAME,
  MAX_HANDSHAKE_BYTES,
  MAX_EXTERNAL_FRAME,
  MAX_FRAME_MEMORY,
  SMALL_FRAME_BYTES,
  FRAME_DEADLINE_BASE_MS,
  FRAME_DEADLINE_CAP_MS,
  FRAME_MIN_BYTES_PER_S,
  FRAME_EVICT_MIN_AGE_MS
} = require('../lib/frame-guard')

class FakeRaw extends EventEmitter {
  constructor () {
    super()
    this.destroyed = false
    this.ended = false
    this.written = []
    this.writeResult = true
    this.paused = false
    this.pauses = 0
  }

  write (data) {
    this.written.push(data)
    return this.writeResult
  }

  end () { this.ended = true }

  pause () {
    if (!this.paused) this.pauses++
    this.paused = true
  }

  resume () { this.paused = false }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  }
}

function header (len) {
  return b4a.from([len & 0xff, (len >>> 8) & 0xff, (len >>> 16) & 0xff])
}

function frame (len) {
  return b4a.concat([header(len), b4a.alloc(len)])
}

function setup (opts = {}) {
  const raw = new FakeRaw()
  const state = { limits: 0, reasons: [], bytes: 0, chunks: 0, ended: false, closed: false }
  const guard = new FrameGuard(raw, { onLimit: (reason) => { state.limits++; state.reasons.push(reason) }, ...opts })
  guard.on('error', () => {})
  guard.on('data', (c) => { state.chunks++; state.bytes += c.byteLength })
  guard.on('end', () => { state.ended = true })
  guard.on('close', () => { state.closed = true })
  const feed = async (...chunks) => {
    for (const c of chunks) raw.emit('data', c)
    await tick()
  }
  return { raw, guard, state, feed }
}

function tick () {
  return new Promise((resolve) => setImmediate(resolve))
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A fake clock for FrameGuard's `clock` option: time moves only on
// advance(ms), which runs the timers due on the way in time order.
function fakeClock () {
  let now = 0
  let seq = 0
  const timers = new Set()
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const timer = { at: now + ms, seq: seq++, fn }
      timers.add(timer)
      return timer
    },
    clearTimeout: (timer) => { timers.delete(timer) },
    pending: () => timers.size,
    advance (ms) {
      const end = now + ms
      for (;;) {
        let next = null
        for (const timer of timers) {
          if (timer.at <= end && (next === null || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq))) next = timer
        }
        if (next === null) break
        timers.delete(next)
        now = next.at
        next.fn()
      }
      now = end
    }
  }
}

// A budget that records every reservation and release.
function recordingBudget (allow = () => true) {
  const log = { reserved: [], released: [], held: 0 }
  return {
    log,
    reserve (n, guard) {
      if (!allow(n, guard)) return false
      log.reserved.push(n)
      log.held += n
      return true
    },
    release (n, guard) {
      log.released.push(n)
      log.held -= n
    }
  }
}

test('production limits are unchanged and the seeder re-exports them', (t) => {
  t.is(HANDSHAKE_FRAMES, 2)
  t.is(MAX_HANDSHAKE_FRAME, 1024)
  t.is(MAX_HANDSHAKE_BYTES, 2054)
  t.is(MAX_EXTERNAL_FRAME, 8 * 1024 * 1024 + 64 * 1024)
  const seeder = require('../lib/seeder')
  t.is(seeder.MAX_HANDSHAKE_FRAME, MAX_HANDSHAKE_FRAME)
  t.is(seeder.MAX_HANDSHAKE_BYTES, MAX_HANDSHAKE_BYTES)
  t.is(seeder.MAX_EXTERNAL_FRAME, MAX_EXTERNAL_FRAME)
  t.is(MAX_FRAME_MEMORY, 64 * 1024 * 1024)
  t.is(SMALL_FRAME_BYTES, 64 * 1024)
  t.is(FRAME_DEADLINE_BASE_MS, 10000)
  t.is(FRAME_DEADLINE_CAP_MS, 139000, 'derived: 129 s for MAX_EXTERNAL_FRAME at the minimum rate plus 10 s')
  t.is(FRAME_MIN_BYTES_PER_S, 65536)
  t.is(seeder.MAX_FRAME_MEMORY, MAX_FRAME_MEMORY)
  t.is(seeder.SMALL_FRAME_BYTES, SMALL_FRAME_BYTES)
  t.is(seeder.FRAME_DEADLINE_BASE_MS, FRAME_DEADLINE_BASE_MS)
  t.is(seeder.FRAME_DEADLINE_CAP_MS, FRAME_DEADLINE_CAP_MS)
  t.is(seeder.FRAME_MIN_BYTES_PER_S, FRAME_MIN_BYTES_PER_S)
  t.is(seeder.frameDeadlineFor, frameDeadlineFor)
})

test('responder: frames at exactly each limit are forwarded', async (t) => {
  const { raw, guard, state, feed } = setup()
  const chunks = [frame(MAX_HANDSHAKE_FRAME), frame(MAX_HANDSHAKE_FRAME), frame(MAX_EXTERNAL_FRAME)]
  await feed(...chunks)
  t.is(state.limits, 0)
  t.absent(guard.destroyed)
  t.absent(raw.destroyed)
  t.is(state.bytes, chunks.reduce((n, c) => n + c.byteLength, 0))
})

test('responder: a first handshake frame one byte over is destroyed, nothing forwarded', async (t) => {
  const { raw, guard, state, feed } = setup()
  await feed(frame(MAX_HANDSHAKE_FRAME + 1))
  t.is(state.limits, 1)
  t.ok(guard.destroyed)
  t.ok(raw.destroyed)
  t.is(state.bytes, 0)
})

test('responder: a post-handshake frame one byte over is destroyed', async (t) => {
  const { raw, state, feed } = setup()
  await feed(frame(32), frame(64))
  t.is(state.bytes, 32 + 3 + 64 + 3)
  await feed(header(MAX_EXTERNAL_FRAME + 1))
  t.is(state.limits, 1)
  t.alike(state.reasons, ['frame-limit'])
  t.ok(raw.destroyed)
  t.is(state.bytes, 32 + 3 + 64 + 3, 'the offending header was not forwarded')
})

test('a throwing onLimit still destroys, and a split header cannot resume past the limit', async (t) => {
  const { raw, guard, state, feed } = setup({ onLimit: () => { throw new Error('logger down') } })
  // Two header bytes go through (the secret stream now holds them), the third
  // declares 0xffffff: the guard must close even though onLimit throws.
  await feed(b4a.from([0xff, 0xff]))
  const forwarded = state.bytes
  await feed(b4a.from([0xff]))
  t.ok(guard.destroyed, 'guard destroyed')
  t.ok(raw.destroyed, 'raw socket destroyed')
  await feed(b4a.from([0xff, 0x00, 0x00, 0x01]))
  t.is(state.bytes, forwarded, 'nothing after the limit is forwarded')
})

test('a header split across chunks is assembled before judging', async (t) => {
  const ok = setup()
  const okHeader = header(MAX_HANDSHAKE_FRAME)
  await ok.feed(okHeader.subarray(0, 1), okHeader.subarray(1, 2), okHeader.subarray(2), b4a.alloc(MAX_HANDSHAKE_FRAME))
  t.is(ok.state.limits, 0)
  t.is(ok.state.bytes, 3 + MAX_HANDSHAKE_FRAME)

  const over = setup()
  const overHeader = header(MAX_HANDSHAKE_FRAME + 1)
  await over.feed(overHeader.subarray(0, 1), overHeader.subarray(1, 2))
  t.is(over.state.limits, 0, 'not judged before the third header byte')
  t.is(over.state.bytes, 2)
  await over.feed(overHeader.subarray(2))
  t.is(over.state.limits, 1)
  t.ok(over.raw.destroyed)
  t.is(over.state.bytes, 2, 'the chunk completing the bad header was not forwarded')
})

test('a body split across chunks counts as one frame', async (t) => {
  const { state, feed, guard } = setup()
  const f = frame(MAX_HANDSHAKE_FRAME)
  await feed(f.subarray(0, 10), f.subarray(10, 500), f.subarray(500))
  // Still one handshake frame left: a second 1024-byte frame is fine, then a
  // large post-handshake one.
  await feed(frame(MAX_HANDSHAKE_FRAME), frame(40000))
  t.is(state.limits, 0)
  t.absent(guard.destroyed)
})

test('msg1, msg3 and application frames coalesced in one chunk are forwarded', async (t) => {
  const { state, feed, guard } = setup()
  const chunk = b4a.concat([frame(32), frame(64), frame(44000), frame(0), frame(16477)])
  await feed(chunk)
  t.is(state.limits, 0)
  t.absent(guard.destroyed)
  t.is(state.bytes, chunk.byteLength)
})

test('a chunk with valid frames before an offending one is not forwarded at all', async (t) => {
  const { raw, state, feed } = setup()
  await feed(b4a.concat([frame(32), frame(64), frame(100), header(MAX_EXTERNAL_FRAME + 1)]))
  t.is(state.limits, 1)
  t.ok(raw.destroyed)
  t.is(state.bytes, 0)
})

test('zero-length frames count toward the handshake frames', async (t) => {
  const { state, feed, guard } = setup()
  await feed(frame(0), frame(0), frame(MAX_HANDSHAKE_FRAME + 1))
  t.is(state.limits, 0, 'third frame is post-handshake')
  t.absent(guard.destroyed)
})

test('handshakeFrames 2 (responder) destroys a second frame of 1025 bytes', async (t) => {
  const { raw, state, feed } = setup({ handshakeFrames: 2 })
  await feed(frame(32))
  await feed(frame(MAX_HANDSHAKE_FRAME + 1))
  t.is(state.limits, 1)
  t.ok(raw.destroyed)
  t.is(state.bytes, 35)
})

test('handshakeFrames 1 (initiator) forwards a second frame under maxFrame', async (t) => {
  const { raw, guard, state, feed } = setup({ handshakeFrames: 1 })
  await feed(frame(32))
  await feed(frame(MAX_HANDSHAKE_FRAME + 1))
  t.is(state.limits, 0)
  t.absent(guard.destroyed)
  t.absent(raw.destroyed)
  t.is(state.bytes, 35 + 3 + MAX_HANDSHAKE_FRAME + 1)
  await feed(header(MAX_EXTERNAL_FRAME + 1))
  t.is(state.limits, 1, 'maxFrame still applies')
  t.ok(raw.destroyed)
})

test('handshakeFrames 1 still bounds its single handshake frame', async (t) => {
  const { state, feed } = setup({ handshakeFrames: 1 })
  await feed(frame(MAX_HANDSHAKE_FRAME + 1))
  t.is(state.limits, 1)
  t.is(state.bytes, 0)
})

test('custom maxHandshakeFrame and maxFrame are honoured exactly', async (t) => {
  const a = setup({ maxHandshakeFrame: 10, maxFrame: 100 })
  await a.feed(frame(10), frame(10), frame(100))
  t.is(a.state.limits, 0)
  await a.feed(frame(101))
  t.is(a.state.limits, 1)

  const b = setup({ maxHandshakeFrame: 10 })
  await b.feed(frame(11))
  t.is(b.state.limits, 1)
})

test('the default clock is monotonic, not the wall clock', (t) => {
  const guard = new FrameGuard(new FakeRaw())
  guard.on('error', () => {})
  t.ok(Math.abs(guard._clock.now() - performance.now()) < 1000, 'performance.now()')
  t.ok(Math.abs(guard._clock.now() - Date.now()) > 1000, 'not Date.now()')
  guard.destroy()
})

test('invalid options are refused', async (t) => {
  const raw = new FakeRaw()
  await t.exception.all(() => new FrameGuard(raw, { handshakeFrames: 0 }), /handshakeFrames/)
  await t.exception.all(() => new FrameGuard(raw, { handshakeFrames: 1.5 }), /handshakeFrames/)
  await t.exception.all(() => new FrameGuard(raw, { maxHandshakeFrame: -1 }), /maxHandshakeFrame/)
  await t.exception.all(() => new FrameGuard(raw, { maxFrame: 0x1000000 }), /maxFrame/)
  await t.exception.all(() => new FrameGuard(raw, { deadlineBaseMs: 0 }), /deadlineBaseMs/)
  await t.exception.all(() => new FrameGuard(raw, { deadlineBaseMs: 1.5 }), /deadlineBaseMs/)
  await t.exception.all(() => new FrameGuard(raw, { deadlineCapMs: -1 }), /deadlineCapMs/)
  await t.exception.all(() => new FrameGuard(raw, { smallBytes: Infinity }), /smallBytes/)
  await t.exception.all(() => new FrameGuard(raw, { budget: {} }), /budget/)
  await t.exception.all(() => new FrameGuard(raw, { budget: null }), /budget/)
  await t.exception.all(() => new FrameGuard(raw, { clock: {} }), /clock/)
  await t.exception.all(() => new FrameGuard(raw, { clock: null }), /clock/)
  t.is(raw.listenerCount('data'), 0, 'a refused guard attaches no listener')
})

test('early EOF before every handshake frame destroys without ending', async (t) => {
  const { raw, guard, state, feed } = setup()
  await feed(frame(32))
  raw.emit('end')
  await tick()
  t.ok(guard.destroyed)
  t.ok(raw.destroyed)
  t.absent(state.ended)
})

test('early EOF inside a partial handshake frame destroys', async (t) => {
  const { guard, raw, feed } = setup({ handshakeFrames: 1 })
  await feed(frame(32).subarray(0, 10))
  raw.emit('end')
  await tick()
  t.ok(guard.destroyed)
})

test('EOF after the handshake frames ends the readable side', async (t) => {
  const two = setup()
  await two.feed(frame(32), frame(64))
  two.raw.emit('end')
  await tick()
  t.ok(two.state.ended)
  t.absent(two.raw.destroyed)

  const one = setup({ handshakeFrames: 1 })
  await one.feed(frame(80))
  one.raw.emit('end')
  await tick()
  t.ok(one.state.ended)
})

// streamx write() takes no callback: a held _write callback shows as the next
// write not reaching the raw stream until the hold is released.
test('teardown: drain releases a pending write', async (t) => {
  const { raw, guard } = setup()
  raw.writeResult = false
  guard.write(b4a.from('a'))
  guard.write(b4a.from('b'))
  await tick()
  t.is(raw.written.length, 1, 'waits for drain')
  raw.writeResult = true
  raw.emit('drain')
  await tick()
  t.is(raw.written.length, 2, 'released on drain')
})

test('teardown: raw close destroys the guard and releases a pending write', async (t) => {
  const { raw, guard, state } = setup()
  raw.writeResult = false
  guard.write(b4a.from('a'))
  guard.write(b4a.from('b'))
  await tick()
  t.is(raw.written.length, 1)
  t.ok(guard._drainCb !== null, 'a write callback is held')
  raw.destroy()
  await tick()
  t.ok(guard.destroyed)
  t.ok(state.closed)
  t.is(raw.written.length, 1, 'nothing written to a destroyed raw stream')
  t.is(guard._drainCb, null, 'the held callback was released on close')
})

test('teardown: after a limit further data is ignored and onLimit fires once', async (t) => {
  const { state, feed, guard } = setup()
  await feed(frame(MAX_HANDSHAKE_FRAME + 1))
  await feed(frame(MAX_HANDSHAKE_FRAME + 1), frame(10))
  t.is(state.limits, 1)
  t.is(state.bytes, 0)
  t.ok(guard.destroyed)
})

test('teardown: destroying the guard destroys the raw stream; end ends it', async (t) => {
  const a = setup()
  a.guard.destroy()
  await tick()
  t.ok(a.raw.destroyed)
  t.is(a.state.limits, 0)

  const b = setup()
  b.guard.end()
  await tick()
  t.ok(b.raw.ended)
})

test('a raw error destroys the guard with that error', async (t) => {
  const { raw, guard } = setup()
  let seen = null
  guard.on('error', (err) => { seen = err })
  const err = new Error('boom')
  raw.emit('error', err)
  await tick()
  t.is(seen, err)
  t.ok(guard.destroyed)
})

test('without a budget a large incomplete frame is never refused', async (t) => {
  const { guard, state, feed } = setup()
  await feed(frame(32), frame(64))
  // Several large frames, each left incomplete across chunks: the default
  // budget is unlimited.
  for (let i = 0; i < 4; i++) {
    const f = frame(MAX_EXTERNAL_FRAME)
    await feed(f.subarray(0, 1000))
    t.is(guard._reserved, MAX_EXTERNAL_FRAME, 'charged to the default budget')
    await feed(f.subarray(1000))
    t.is(guard._reserved, 0, 'released on completion')
  }
  t.is(state.limits, 0)
  t.absent(guard.destroyed)
})

test('a large incomplete frame is charged to an injected budget and released on completion', async (t) => {
  const budget = recordingBudget()
  const { guard, state, feed } = setup({ budget, smallBytes: 1000 })
  await feed(frame(32), frame(64))
  const f = frame(5000)
  await feed(f.subarray(0, 100), f.subarray(100, 200))
  t.alike(budget.log.reserved, [5000], 'reserved once, the whole declared length')
  t.is(budget.log.held, 5000)
  t.is(guard.reserved, 5000)
  t.ok(guard.progress() > 0 && guard.progress() < 1)
  await feed(f.subarray(200))
  t.is(guard.reserved, 0)
  t.alike(budget.log.released, [5000])
  t.is(budget.log.held, 0)
  t.is(state.limits, 0)
  t.is(state.bytes, 35 + 67 + f.byteLength)
})

test('frames that are small or complete within the chunk are never charged', async (t) => {
  const budget = recordingBudget()
  const { state, feed } = setup({ budget, smallBytes: 1000 })
  await feed(frame(32), frame(64), frame(5000))
  const small = frame(1000)
  await feed(small.subarray(0, 10), small.subarray(10))
  t.is(budget.log.reserved.length, 0)
  t.is(state.limits, 0)
})

test('a refused reservation drops the guard with frame-budget, chunk not forwarded', async (t) => {
  const budget = recordingBudget(() => false)
  const { raw, state, feed } = setup({ budget, smallBytes: 1000 })
  await feed(frame(32), frame(64))
  const before = state.bytes
  await feed(frame(5000).subarray(0, 100))
  t.alike(state.reasons, ['frame-budget'])
  t.ok(raw.destroyed)
  t.is(state.bytes, before)
})

test('destroying or evicting a charged guard releases its reservation once', async (t) => {
  const budget = recordingBudget()
  const a = setup({ budget, smallBytes: 1000 })
  await a.feed(frame(32), frame(64), frame(5000).subarray(0, 100))
  a.guard.destroy()
  await tick()
  t.alike(budget.log.released, [5000])

  const b = setup({ budget, smallBytes: 1000 })
  await b.feed(frame(32), frame(64), frame(5000).subarray(0, 100))
  b.guard.evict()
  await tick()
  t.alike(b.state.reasons, ['frame-budget'])
  t.ok(b.raw.destroyed)
  t.alike(budget.log.released, [5000, 5000])
  t.is(budget.log.held, 0)
})

test('a dripping frame is dropped at its frame deadline', async (t) => {
  const base = 40
  const cap = 120
  const { raw, state, feed } = setup({ deadlineBaseMs: base, deadlineCapMs: cap })
  await feed(frame(32), frame(64))
  const f = frame(500) // small: uncharged, only the completion deadline
  await feed(f.subarray(0, 10))
  t.is(frameDeadlineFor(500, base, cap), cap, 'capped')
  const started = Date.now()
  // Drip a byte at a time: body bytes never refresh the deadline.
  while (!raw.destroyed && Date.now() - started < 2000) {
    await feed(f.subarray(10, 11))
    await sleep(10)
  }
  t.alike(state.reasons, ['frame-deadline'])
  t.ok(raw.destroyed)
  t.ok(Date.now() - started < 1000, 'dropped near the cap')
})

test('deadlines false (client): no completion deadline and no progress check', async (t) => {
  const base = 30
  const { raw, guard, state, feed } = setup({ deadlines: false, smallBytes: 1000, deadlineBaseMs: base, deadlineCapMs: 60 })
  await feed(frame(32), frame(64), frame(500).subarray(0, 10))
  await sleep(base * 6)
  t.alike(state.reasons, [], 'a stalled small frame is not cut')
  t.absent(raw.destroyed)
  await feed(frame(500).subarray(10), frame(MAX_EXTERNAL_FRAME).subarray(0, 100))
  await sleep(base * 6)
  t.alike(state.reasons, [], 'a stalled large frame is not cut either')
  t.absent(guard.destroyed)
  await t.exception.all(() => new FrameGuard(new FakeRaw(), { deadlines: 'no' }), /deadlines/)
})

test('a charged frame below the minimum throughput fails its progress check', async (t) => {
  const base = 30
  const budget = recordingBudget()
  const { raw, state, feed } = setup({ budget, smallBytes: 1000, deadlineBaseMs: base, deadlineCapMs: 600000 })
  await feed(frame(32), frame(64), frame(MAX_EXTERNAL_FRAME).subarray(0, 100))
  await sleep(base * 4)
  t.alike(state.reasons, ['frame-deadline'])
  t.ok(raw.destroyed)
  t.is(budget.log.held, 0, 'reservation released')
})

test('a frame completed before its deadline clears the timer', async (t) => {
  const { guard, state, feed } = setup({ deadlineBaseMs: 20, deadlineCapMs: 40 })
  await feed(frame(32), frame(64))
  const f = frame(500)
  await feed(f.subarray(0, 10))
  t.ok(guard._timer !== null)
  await feed(f.subarray(10))
  t.is(guard._timer, null)
  await sleep(80)
  t.is(state.limits, 0)
  t.absent(guard.destroyed)
})

test('frameDeadlineFor: a maximum frame at exactly the minimum rate fits under the deadline cap', (t) => {
  const transfer = Math.ceil(MAX_EXTERNAL_FRAME / FRAME_MIN_BYTES_PER_S) * 1000
  t.is(transfer, 129000, 'MAX_EXTERNAL_FRAME takes 129 s at 64 KiB/s')
  t.is(FRAME_DEADLINE_CAP_MS, transfer + FRAME_DEADLINE_BASE_MS, 'the cap is that time plus one base window')
  t.is(frameDeadlineFor(MAX_EXTERNAL_FRAME), FRAME_DEADLINE_CAP_MS)
  t.ok(frameDeadlineFor(MAX_EXTERNAL_FRAME) > transfer)
})

test('a maximum frame sent exactly at the minimum rate completes within the deadline', async (t) => {
  const clock = fakeClock()
  const { raw, guard, state, feed } = setup({ clock })
  await feed(frame(32), frame(64))
  // The header alone at t = 0, then 64 KiB of body per second, in chunks
  // under the readable high-water mark so no backpressure pause occurs.
  await feed(header(MAX_EXTERNAL_FRAME))
  t.is(guard.reserved, MAX_EXTERNAL_FRAME, 'charged')
  const piece = b4a.alloc(8192)
  const seconds = MAX_EXTERNAL_FRAME / FRAME_MIN_BYTES_PER_S
  const evictableAt = []
  for (let s = 1; s <= seconds; s++) {
    clock.advance(1000)
    if (state.limits > 0) break
    for (let i = 0; i < FRAME_MIN_BYTES_PER_S / piece.byteLength; i++) await feed(piece)
    // Body bytes keep it fresh: never stalled, never below the rate.
    if (s < seconds && guard.evictable(FRAME_EVICT_MIN_AGE_MS)) evictableAt.push(s)
  }
  t.alike(evictableAt, [], 'never evictable while it keeps the minimum rate')
  t.is(clock.now(), 129000, 'the last body byte arrived at 129 s')
  t.alike(state.reasons, [], 'never dropped')
  t.absent(guard.destroyed)
  t.is(raw.pauses, 0, 'no paused time was excluded')
  t.is(guard.reserved, 0, 'completed and released')
  t.is(clock.pending(), 0, 'no timer left')
  t.is(state.bytes, 35 + 67 + 3 + MAX_EXTERNAL_FRAME)
})

// Starts a guard on the seeder's budget that declares `len` bytes and sends
// `first` body bytes at the fake clock's current time.
async function chargedOn (budget, clock, len, first) {
  const g = setup({ budget, clock })
  await g.feed(frame(32), frame(64), b4a.concat([header(len), b4a.alloc(first)]))
  return g
}

function seederBudget (maxFrameMemory) {
  const { Seeder } = require('../lib/seeder')
  return new Seeder({ dataDir: '/nonexistent', maxFrameMemory })
}

test('budget: new declarations do not evict an older frame that is making progress (the newcomer loses)', async (t) => {
  const MiB = 1024 * 1024
  const seeder = seederBudget(2 * MAX_EXTERNAL_FRAME)
  const budget = seeder._frameBudget
  const clock = fakeClock()
  // A member's maximum frame, well above the minimum rate, for 2 s.
  const member = await chargedOn(budget, clock, MAX_EXTERNAL_FRAME, MiB)
  clock.advance(1000)
  await member.feed(b4a.alloc(MiB))
  clock.advance(1000)
  await member.feed(b4a.alloc(MiB))
  t.absent(member.guard.evictable(FRAME_EVICT_MIN_AGE_MS), 'the member keeps the minimum rate')
  // New maximum declarations, too young to be evicted themselves.
  const first = await chargedOn(budget, clock, MAX_EXTERNAL_FRAME, 1)
  t.alike(first.state.reasons, [], 'the first newcomer still fits')
  const second = await chargedOn(budget, clock, MAX_EXTERNAL_FRAME, 1)
  t.alike(second.state.reasons, ['frame-budget'], 'the newcomer that does not fit is refused')
  t.ok(second.raw.destroyed)
  t.alike(member.state.reasons, [], 'the member is not evicted')
  t.absent(member.guard.destroyed)
  t.is(seeder._frameMemory, 2 * MAX_EXTERNAL_FRAME)
  t.ok(seeder._frameGuards.has(member.guard) && seeder._frameGuards.has(first.guard))

  // Once the first newcomer is old and stalled it is evictable, and a new
  // declaration evicts it, never the member.
  clock.advance(1500)
  await member.feed(b4a.alloc(MiB))
  t.ok(first.guard.evictable(FRAME_EVICT_MIN_AGE_MS), 'a stalled declaration past its first second is evictable')
  const third = await chargedOn(budget, clock, MAX_EXTERNAL_FRAME, 1)
  t.alike(third.state.reasons, [], 'admitted after the eviction')
  t.alike(first.state.reasons, ['frame-budget'], 'the stalled declaration was evicted')
  t.alike(member.state.reasons, [], 'the member survives')
  t.is(seeder._frameMemory, 2 * MAX_EXTERNAL_FRAME)
})

test('budget: an eviction that would not make room evicts nobody', async (t) => {
  const MiB = 1024 * 1024
  const seeder = seederBudget(MAX_EXTERNAL_FRAME + MiB)
  const budget = seeder._frameBudget
  const clock = fakeClock()
  const stalled = await chargedOn(budget, clock, 512 * 1024, 1)
  const member = await chargedOn(budget, clock, MAX_EXTERNAL_FRAME, MiB)
  clock.advance(1000)
  await member.feed(b4a.alloc(MiB))
  clock.advance(1000)
  await member.feed(b4a.alloc(MiB))
  t.ok(stalled.guard.evictable(FRAME_EVICT_MIN_AGE_MS), 'the stalled frame is evictable')
  t.absent(member.guard.evictable(FRAME_EVICT_MIN_AGE_MS))
  // Evicting the stalled 512 KiB would not make room for this declaration.
  const newcomer = await chargedOn(budget, clock, MAX_EXTERNAL_FRAME, 1)
  t.alike(newcomer.state.reasons, ['frame-budget'], 'the requester alone is refused')
  t.alike(stalled.state.reasons, [], 'the stalled peer, which did not need to fall, stays')
  t.absent(stalled.guard.destroyed)
  t.alike(member.state.reasons, [])
  t.is(seeder._frameMemory, MAX_EXTERNAL_FRAME + 512 * 1024)
})

test('budget: only as many evictable frames as needed are evicted, lowest progress first', async (t) => {
  const KiB = 1024
  const seeder = seederBudget(3 * 512 * KiB)
  const budget = seeder._frameBudget
  const clock = fakeClock()
  const slowest = await chargedOn(budget, clock, 512 * KiB, 1)
  const slow = await chargedOn(budget, clock, 512 * KiB, 1000)
  const member = await chargedOn(budget, clock, 512 * KiB, 100 * KiB)
  clock.advance(1000)
  await member.feed(b4a.alloc(100 * KiB))
  clock.advance(1000)
  await member.feed(b4a.alloc(100 * KiB))
  const newcomer = await chargedOn(budget, clock, 512 * KiB, 1)
  t.alike(newcomer.state.reasons, [], 'admitted')
  t.alike(slowest.state.reasons, ['frame-budget'], 'the lowest progress is evicted')
  t.alike(slow.state.reasons, [], 'one eviction was enough')
  t.alike(member.state.reasons, [])
  t.is(seeder._frameMemory, 3 * 512 * KiB)
})

test('budget: an eviction that needs two victims evicts both and admits the newcomer', async (t) => {
  const KiB = 1024
  const seeder = seederBudget(3 * 512 * KiB)
  const budget = seeder._frameBudget
  const clock = fakeClock()
  const stalledA = await chargedOn(budget, clock, 512 * KiB, 1)
  const stalledB = await chargedOn(budget, clock, 512 * KiB, 1000)
  const member = await chargedOn(budget, clock, 512 * KiB, 100 * KiB)
  clock.advance(1000)
  await member.feed(b4a.alloc(100 * KiB))
  clock.advance(1000)
  await member.feed(b4a.alloc(100 * KiB))
  t.is(seeder._frameMemory, 3 * 512 * KiB, 'the budget is full')
  // 1 MiB needs both stalled reservations.
  const newcomer = await chargedOn(budget, clock, 1024 * KiB, 1)
  t.alike(newcomer.state.reasons, [], 'admitted')
  t.is(newcomer.guard.reserved, 1024 * KiB)
  t.alike(stalledA.state.reasons, ['frame-budget'], 'first victim dropped')
  t.alike(stalledB.state.reasons, ['frame-budget'], 'second victim dropped')
  t.ok(stalledA.raw.destroyed && stalledB.raw.destroyed)
  t.is(stalledA.guard.reserved + stalledB.guard.reserved, 0, 'victims released')
  t.alike(member.state.reasons, [], 'the member stays')
  t.is(seeder._frameMemory, 512 * KiB + 1024 * KiB, 'exactly the member and the newcomer are held')
  t.is(seeder._frameGuards.size, 2)
  t.ok(seeder._frameGuards.has(member.guard) && seeder._frameGuards.has(newcomer.guard))
})

test('evictable: young, stalled and too-slow frames', async (t) => {
  const MiB = 1024 * 1024
  const clock = fakeClock()
  const fast = await chargedOn(recordingBudget(), clock, MAX_EXTERNAL_FRAME, 4 * MiB)
  const drip = await chargedOn(recordingBudget(), clock, MAX_EXTERNAL_FRAME, 1)
  const small = setup({ clock })
  await small.feed(frame(32), frame(64), frame(500).subarray(0, 10))
  clock.advance(FRAME_EVICT_MIN_AGE_MS - 1)
  t.absent(drip.guard.evictable(FRAME_EVICT_MIN_AGE_MS), 'never in its first second')
  clock.advance(100)
  t.ok(drip.guard.evictable(FRAME_EVICT_MIN_AGE_MS), 'below the minimum rate after the first second')
  t.absent(small.guard.evictable(FRAME_EVICT_MIN_AGE_MS), 'an uncharged frame holds nothing to evict')
  // A frame that sent fast and then stopped: its average still beats the
  // minimum rate, but a base window without a byte makes it stalled.
  clock.advance(FRAME_DEADLINE_BASE_MS - FRAME_EVICT_MIN_AGE_MS - 100)
  t.is(clock.now(), FRAME_DEADLINE_BASE_MS - 1)
  t.absent(fast.guard.evictable(FRAME_EVICT_MIN_AGE_MS), 'still within a base window of its last byte')
  clock.advance(1)
  t.ok(fast.guard.evictable(FRAME_EVICT_MIN_AGE_MS), 'stalled for a base window')
  t.alike(frameVictims([fast.guard, drip.guard], 1), [drip.guard], 'lowest progress first, only what is needed')
  t.is(frameVictims([fast.guard, drip.guard], 2 * MAX_EXTERNAL_FRAME + 1), null, 'not enough: nobody')
})

test('backpressure: time paused by a lagging consumer does not count for the throughput check', async (t) => {
  const clock = fakeClock()
  const budget = recordingBudget()
  const { raw, guard, state, feed } = setup({ clock, budget })
  await feed(frame(32), frame(64))
  // The consumer stops reading: a chunk over the high-water mark makes the
  // guard pause raw.
  guard.pause()
  await feed(b4a.concat([header(MAX_EXTERNAL_FRAME), b4a.alloc(20000)]))
  t.ok(raw.paused, 'raw paused by the guard')
  t.is(budget.log.held, MAX_EXTERNAL_FRAME)
  clock.advance(10 * 60 * 1000)
  t.alike(state.reasons, [], 'ten paused minutes: not dropped as slow')
  t.absent(guard.destroyed)
  t.absent(guard.evictable(FRAME_EVICT_MIN_AGE_MS), 'nor evictable for the paused time')
  // The consumer reads again: from here the peer owes the minimum rate.
  guard.resume()
  await tick()
  t.absent(raw.paused, 'raw resumed')
  clock.advance(2 * FRAME_DEADLINE_BASE_MS - 1)
  t.alike(state.reasons, [], 'the first check after the resume is grace')
  clock.advance(1)
  t.alike(state.reasons, ['frame-deadline'], 'a peer that then stalls is dropped at the second check')
  t.is(budget.log.held, 0, 'reservation released')
})

test('backpressure: time paused by a lagging consumer does not count for the frame deadline', async (t) => {
  const clock = fakeClock()
  const { raw, guard, state, feed } = setup({ clock })
  await feed(frame(32), frame(64))
  guard.pause()
  // A whole frame over the high-water mark, then a small frame left
  // incomplete (uncharged: only its completion deadline).
  await feed(b4a.concat([frame(20000), header(500), b4a.alloc(10)]))
  t.ok(raw.paused)
  const deadline = frameDeadlineFor(500)
  clock.advance(deadline * 10)
  t.alike(state.reasons, [], 'paused far past its deadline: not dropped')
  guard.resume()
  await tick()
  clock.advance(deadline - 1)
  t.alike(state.reasons, [], 'the deadline counts active time only')
  clock.advance(1)
  t.alike(state.reasons, ['frame-deadline'])
  t.ok(raw.destroyed)
})
