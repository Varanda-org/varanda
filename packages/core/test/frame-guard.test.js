'use strict'

// FrameGuard in isolation, over a fake raw duplex: exact limits, one byte
// over, split headers, several frames per chunk, the responder (2 handshake
// frames) vs initiator (1) direction, early EOF and teardown. The end-to-end
// behaviour through Seeder.acceptStream is covered by
// apps/cli/test/seeder-stream.test.js.
const test = require('brittle')
const { EventEmitter } = require('node:events')
const b4a = require('b4a')
const { FrameGuard, HANDSHAKE_FRAMES, MAX_HANDSHAKE_FRAME, MAX_HANDSHAKE_BYTES, MAX_EXTERNAL_FRAME } = require('../lib/frame-guard')

class FakeRaw extends EventEmitter {
  constructor () {
    super()
    this.destroyed = false
    this.ended = false
    this.written = []
    this.writeResult = true
  }

  write (data) {
    this.written.push(data)
    return this.writeResult
  }

  end () { this.ended = true }
  pause () {}
  resume () {}

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
  const state = { limits: 0, bytes: 0, chunks: 0, ended: false, closed: false }
  const guard = new FrameGuard(raw, { onLimit: () => { state.limits++ }, ...opts })
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

test('production limits are unchanged and the seeder re-exports them', (t) => {
  t.is(HANDSHAKE_FRAMES, 2)
  t.is(MAX_HANDSHAKE_FRAME, 1024)
  t.is(MAX_HANDSHAKE_BYTES, 2054)
  t.is(MAX_EXTERNAL_FRAME, 8 * 1024 * 1024 + 64 * 1024)
  const seeder = require('../lib/seeder')
  t.is(seeder.MAX_HANDSHAKE_FRAME, MAX_HANDSHAKE_FRAME)
  t.is(seeder.MAX_HANDSHAKE_BYTES, MAX_HANDSHAKE_BYTES)
  t.is(seeder.MAX_EXTERNAL_FRAME, MAX_EXTERNAL_FRAME)
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

test('invalid options are refused', async (t) => {
  const raw = new FakeRaw()
  await t.exception.all(() => new FrameGuard(raw, { handshakeFrames: 0 }), /handshakeFrames/)
  await t.exception.all(() => new FrameGuard(raw, { handshakeFrames: 1.5 }), /handshakeFrames/)
  await t.exception.all(() => new FrameGuard(raw, { maxHandshakeFrame: -1 }), /maxHandshakeFrame/)
  await t.exception.all(() => new FrameGuard(raw, { maxFrame: 0x1000000 }), /maxFrame/)
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
