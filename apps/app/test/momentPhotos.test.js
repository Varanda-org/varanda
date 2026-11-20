// Momento photo store (momentPhotos.js): ahead reads, sharing and release.
'use strict'

const test = require('brittle')
const load = () => import('../src/momentPhotos.js')

const A = 'aa'.repeat(32)
const start = Date.parse('2026-11-16T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

const photo = (seq, author = A, extra = {}) => ({ author, seq, expected: { mime: 'image/jpeg', ms: undefined }, until: start + DAY, ...extra })
const video = (seq, author = A) => ({ author, seq, expected: { mime: 'video/mp4', ms: 4000 }, until: start + DAY })
const webGot = (mime = 'image/jpeg', extra = {}) => ({ bytes: new Uint8Array([7, 7, 7]), mime, w: 10, h: 20, ...extra })
const nativeGot = (name, mime = 'image/jpeg', extra = {}) => ({ uri: 'file:///data/varanda/media-read/' + name, mime, w: 10, h: 20, ...extra })

async function setup (options = {}) {
  const mod = await load()
  let time = start
  let timerId = 0
  const timers = new Map()
  const calls = { read: [], url: [], revoke: [], forget: [], adopt: [] }
  const pending = []
  const media = {
    read: (params) => {
      calls.read.push(params)
      let resolve, reject
      const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
      pending.push({ params, resolve, reject })
      return promise
    },
    forgetReadFile: (name) => calls.forget.push(name)
  }
  const deps = {
    now: () => time,
    setTimer: (fn, ms) => {
      const id = ++timerId
      timers.set(id, { fn, at: time + ms })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    urlFromBytes: (bytes, mime) => {
      calls.url.push({ bytes: [...bytes], mime })
      return 'blob:' + calls.url.length
    },
    revokeUrl: (uri) => calls.revoke.push(uri),
    adoptVideoFile: (uri) => {
      calls.adopt.push(uri)
      return 'file:///cache/adopted-' + calls.adopt.length + '.mp4'
    },
    maxAgeMs: options.maxAgeMs,
    aheadStallMs: options.aheadStallMs
  }
  const store = mod.createMomentPhotos({ media, ...deps })
  // Answers the oldest unanswered read of author:seq.
  const answer = async (seq, got, author = A) => {
    const i = pending.findIndex((p) => p.params.seq === seq && p.params.author === author)
    if (i === -1) throw new Error('no pending read for ' + seq)
    const [p] = pending.splice(i, 1)
    if (got instanceof Error) p.reject(got)
    else p.resolve(got)
    await flush()
  }
  // Cleanup: answers every read still in flight with nothing.
  const drain = async () => {
    for (const p of pending.splice(0)) p.resolve(null)
    await flush()
  }
  return {
    mod,
    store,
    media,
    deps,
    calls,
    timers,
    pending,
    answer,
    drain,
    key: (seq, author = A) => mod.momentPhotoKey(author, seq),
    seqs: () => calls.read.map((p) => p.seq),
    advance: async (ms) => {
      const end = time + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        time = next[1].at
        timers.delete(next[0])
        next[1].fn()
        await flush()
      }
      time = end
      await flush()
    }
  }
}

test('momentPhotoKey and the default max age', async (t) => {
  const { momentPhotoKey, MOMENT_PHOTO_MAX_AGE_MS } = await load()
  t.is(momentPhotoKey(A, 3), A + ':3')
  t.is(MOMENT_PHOTO_MAX_AGE_MS, 5 * 60 * 1000)
})

test('one media.read per key across read and want of the same ref', async (t) => {
  const h = await setup()
  const first = h.store.read(photo(1))
  t.alike(h.calls.read, [{ kind: 'moment', author: A, seq: 1 }], 'read starts at once')
  h.store.want('viewer', [photo(1)])
  const second = h.store.read(photo(1))
  t.is(first, second, 'the same shared promise')
  t.is(h.calls.read.length, 1)
  await h.answer(1, webGot())
  t.alike(await first, { phase: 'ok', uri: 'blob:1', ms: undefined })
  h.store.want('viewer', [photo(1)])
  t.is(h.calls.read.length, 1, 'a settled entry is not read again')
})

test('ahead reads run one at a time in list order, the current read never waits', async (t) => {
  const h = await setup()
  h.store.want('viewer', [photo(1), photo(2), photo(3)])
  t.alike(h.seqs(), [1], 'only one ahead read in flight')
  const current = h.store.read(photo(9))
  t.alike(h.seqs(), [1, 9], 'the current item starts while an ahead read is pending')
  await h.answer(9, webGot())
  t.alike(h.seqs(), [1, 9], 'a read() answer does not start another ahead read')
  t.is((await current).phase, 'ok')
  await h.answer(1, webGot())
  t.alike(h.seqs(), [1, 9, 2])
  await h.answer(2, webGot())
  t.alike(h.seqs(), [1, 9, 2, 3])
  await h.answer(3, webGot())
  t.is(h.pending.length, 0)
})

test('a new want() while an ahead read is in flight does not start another', async (t) => {
  const h = await setup()
  h.store.want('viewer', [photo(1), photo(2)])
  h.store.want('prev', [photo(5)])
  h.store.want('viewer', [photo(2), photo(3)])
  t.alike(h.seqs(), [1], 'the released read still counts until the node answers')
  await h.answer(1, webGot())
  t.alike(h.seqs(), [1, 2], 'the newest list first')
  t.alike(h.calls.url, [], 'the released result is discarded')
  await h.answer(2, webGot())
  t.alike(h.seqs(), [1, 2, 3])
  await h.answer(3, webGot())
  t.alike(h.seqs(), [1, 2, 3, 5])
  await h.answer(5, webGot())
})

test('a newer owner\'s list is served before an older owner\'s', async (t) => {
  const h = await setup()
  h.store.want('ahead', [photo(1), photo(2)])
  h.store.want('prev', [photo(5)])
  await h.answer(1, webGot())
  t.alike(h.seqs(), [1, 5], 'the newer list runs before the rest of the older one')
  await h.answer(5, webGot())
  await h.answer(2, webGot())
  t.alike(h.seqs(), [1, 5, 2])
  h.store.want('ahead', [photo(1), photo(2), photo(3)])
  h.store.want('prev', [photo(5), photo(6)])
  h.store.want('ahead', [photo(1), photo(2), photo(3)])
  t.alike(h.seqs(), [1, 5, 2, 3], 're-set: served first again')
  await h.drain()
})

test('ahead reads wait while MOMENT_PHOTO_MAX_READS reads are in flight, current reads included', async (t) => {
  const h = await setup({ aheadStallMs: 30000 })
  t.is(h.mod.MOMENT_PHOTO_MAX_READS, 2)
  h.store.read(photo(8))
  h.store.read(photo(9))
  h.store.want('viewer', [photo(1), photo(2)])
  t.alike(h.seqs(), [8, 9], 'two current reads in flight: no ahead read')
  await h.answer(8, webGot())
  t.alike(h.seqs(), [8, 9, 1], 'an answer frees a place')
  await h.answer(9, webGot())
  await h.answer(1, webGot())
  await h.answer(2, webGot())
  t.alike(h.seqs(), [8, 9, 1, 2])

  h.store.read(photo(10))
  h.store.read(photo(11))
  h.store.want('viewer', [photo(10), photo(11), photo(12), photo(13)])
  t.alike(h.seqs(), [8, 9, 1, 2, 10, 11])
  await h.advance(29999)
  t.alike(h.seqs(), [8, 9, 1, 2, 10, 11], 'still counted before the watchdog')
  await h.advance(1)
  t.alike(h.seqs(), [8, 9, 1, 2, 10, 11, 12], 'the watchdog repeats no read; the first stale read frees a place for one ahead read')
  await h.answer(12, webGot())
  t.alike(h.seqs(), [8, 9, 1, 2, 10, 11, 12], 'two stale reads: no read-ahead, even with places free')
  const late = webGot()
  await h.answer(10, late)
  t.is(h.store.peek(h.key(10))?.phase, 'ok', 'the slow answer lands')
  t.alike([...late.bytes], [0, 0, 0], 'and its bytes are zeroed once turned into a URL')
  t.alike(h.seqs(), [8, 9, 1, 2, 10, 11, 12, 13], 'one read is stale: read-ahead goes on')
  await h.drain()
})

test('read-ahead pauses while MOMENT_PHOTO_MAX_STALLED hung reads have not answered', async (t) => {
  const h = await setup({ aheadStallMs: 30000 })
  t.is(h.mod.MOMENT_PHOTO_MAX_STALLED, 2)
  for (let step = 0; step < 10; step++) {
    h.store.want('viewer', [photo(step + 1), photo(step + 2), photo(step + 3)])
    await h.advance(30000)
  }
  t.alike(h.seqs(), [1, 2], 'a seeder that never answers gets no new ahead read per step')
  const shown = h.store.read(photo(40), 'viewer')
  t.alike(h.seqs(), [1, 2, 40], 'the item on screen is still read at once')
  h.store.clear()
  t.alike(await shown, { phase: 'off' })
  t.is(h.timers.size, 0)
  await h.drain()
})

test('read-ahead resumes once a stale read answers, and the slow answer lands', async (t) => {
  const h = await setup({ aheadStallMs: 30000 })
  h.store.want('viewer', [photo(1), photo(2), photo(3)])
  await h.advance(30000)
  t.alike(h.seqs(), [1, 2], 'one stale read: read-ahead goes on')
  await h.advance(30000)
  h.store.want('viewer', [photo(1), photo(2), photo(3)])
  t.alike(h.seqs(), [1, 2], 'two stale reads: read-ahead waits, even after a want(), and neither is read again')
  await h.answer(1, webGot())
  t.is(h.store.peek(h.key(1))?.phase, 'ok', 'the stale answer is kept: its entry is still listed')
  t.alike(h.seqs(), [1, 2, 3], 'and read-ahead resumes with the next key')
  await h.drain()
})

test('subscribe fires when an entry settles ok or off, never on release', async (t) => {
  const h = await setup()
  const seen = []
  const off = h.store.subscribe((key, result) => seen.push([key, result]))
  h.store.subscribe(() => { throw new Error('listener') })
  h.store.read(photo(1))
  await h.answer(1, webGot())
  t.alike(seen, [[h.key(1), { phase: 'ok', uri: 'blob:1', ms: undefined }]], 'ok, despite a throwing listener')
  h.store.read(photo(2))
  await h.answer(2, new Error('NOT_FOUND'))
  t.alike(seen[1], [h.key(2), { phase: 'off' }], 'a failed read')
  h.store.want('viewer', [photo(3)])
  h.store.want('viewer', [])
  await h.answer(3, webGot())
  h.store.want('viewer', [])
  t.alike(h.calls.revoke, ['blob:1'], 'a settled entry was released')
  t.is(seen.length, 2, 'neither release nor a late answer after release notifies')
  off()
  h.store.read(photo(4))
  await h.answer(4, webGot())
  t.is(seen.length, 2, 'unsubscribe stops it')
  const after = []
  h.store.subscribe((key) => after.push(key))
  h.store.read(photo(5))
  h.store.clear()
  await h.answer(5, webGot())
  t.alike(after, [], 'clear() drops listeners')
})

test('a single-ref owner [null, ref] pins nothing: its entry is released at max age', async (t) => {
  const h = await setup({ maxAgeMs: 60000 })
  h.store.read(photo(1), 'strip')
  h.store.want('strip', [null, photo(1)])
  await h.answer(1, webGot())
  await h.advance(59999)
  t.alike(h.calls.revoke, [])
  await h.advance(1)
  t.alike(h.calls.revoke, ['blob:1'], 'its read() hold ended with that want()')
  t.is(h.store.peek(h.key(1)), null)
})

test('the viewer\'s previous and next photos age out while its index 0 stays', async (t) => {
  const h = await setup({ maxAgeMs: 60000 })
  h.store.read(photo(2), 'viewer')
  h.store.read(photo(1), 'viewer')
  h.store.read(photo(3), 'viewer')
  await h.answer(2, webGot())
  await h.answer(1, webGot())
  await h.answer(3, webGot())
  h.store.want('viewer', [photo(2), photo(3), null, photo(1)])
  await h.advance(60000)
  t.alike(h.calls.revoke.slice().sort(), ['blob:2', 'blob:3'], 'previous and next released')
  t.is(h.store.peek(h.key(2))?.phase, 'ok', 'the photo on screen stays')
  t.is(h.store.peek(h.key(1)), null)
  t.is(h.store.peek(h.key(3)), null)
  h.store.want('viewer', [photo(2), photo(3), null, photo(1)])
  t.alike(h.seqs().slice(3), [3], 'read again on demand')
  await h.drain()
})

test('a video is read ahead only as the next item or an owner\'s only ref', async (t) => {
  const h = await setup()
  h.store.want('viewer', [photo(1), video(2), photo(3), video(4), photo(5)])
  await h.answer(1, webGot())
  await h.answer(2, webGot('video/mp4', { ms: 4000 }))
  await h.answer(3, webGot())
  t.alike(h.seqs(), [1, 2, 3, 5], 'the deeper video is skipped')
  await h.answer(5, webGot())
  h.store.want('prev', [video(8)])
  t.alike(h.seqs(), [1, 2, 3, 5, 8], 'an owner\'s only ref, even a video')
  await h.answer(8, webGot('video/mp4', { ms: 4000 }))
  h.store.want('other', [video(10), photo(11)])
  t.alike(h.seqs(), [1, 2, 3, 5, 8, 11], 'a video on screen is left to read()')
})

test('two owners keep a shared entry until both drop it', async (t) => {
  const h = await setup()
  h.store.want('a', [photo(1)])
  h.store.want('b', [photo(1)])
  await h.answer(1, webGot())
  t.is(h.calls.read.length, 1)
  h.store.want('a', [])
  t.alike(h.calls.revoke, [])
  t.alike(h.store.peek(h.key(1)), { phase: 'ok', uri: 'blob:1', ms: undefined })
  h.store.want('b', [])
  t.alike(h.calls.revoke, ['blob:1'], 'released once, when the last owner drops it')
  t.is(h.store.peek(h.key(1)), null)
  h.store.want('b', [])
  t.alike(h.calls.revoke, ['blob:1'])
  t.is(h.timers.size, 0)
})

test('native photo keeps its file and is forgotten once on release', async (t) => {
  const h = await setup()
  h.store.want('viewer', [photo(1)])
  await h.answer(1, nativeGot('abc.bin'))
  t.alike(h.store.peek(h.key(1)), { phase: 'ok', uri: 'file:///data/varanda/media-read/abc.bin', ms: undefined })
  t.alike(h.calls.forget, [], 'kept while shown')
  h.store.want('viewer', [])
  h.store.want('viewer', [])
  t.alike(h.calls.forget, ['abc.bin'])
  t.alike(h.calls.revoke, [])
})

test('native video is adopted, its read file forgotten, and revoked on release', async (t) => {
  const h = await setup()
  const got = h.store.read(video(2))
  await h.answer(2, nativeGot('vid.bin', 'video/mp4', { ms: 4000 }))
  t.alike(await got, { phase: 'ok', uri: 'file:///cache/adopted-1.mp4', ms: 4000 })
  t.alike(h.calls.adopt, ['file:///data/varanda/media-read/vid.bin'])
  t.alike(h.calls.forget, ['vid.bin'])
  h.store.want('viewer', [])
  t.alike(h.calls.revoke, ['file:///cache/adopted-1.mp4'])
  t.alike(h.calls.forget, ['vid.bin'])
})

test('read() holds its entry until a want() that does not list it', async (t) => {
  const h = await setup()
  h.store.read(photo(1))
  await h.answer(1, webGot())
  h.store.want('viewer', [photo(1), photo(2)])
  t.alike(h.calls.revoke, [], 'listed')
  h.store.want('prev', [])
  t.alike(h.calls.revoke, [], 'still listed by the viewer')
  h.store.want('viewer', [photo(2)])
  t.alike(h.calls.revoke, ['blob:1'], 'no longer held nor listed')

  h.store.read(photo(7))
  await h.answer(7, webGot())
  h.store.want('other', [photo(7)])
  h.store.want('viewer', [photo(2)])
  t.alike(h.calls.revoke, ['blob:1'], 'kept while another owner lists it')
  h.store.want('other', [])
  t.is(h.calls.revoke.length, 2)
})

test('a result landing after release is discarded and its bytes zeroed', async (t) => {
  const h = await setup()
  h.store.want('viewer', [photo(1)])
  h.store.want('viewer', [])
  const got = webGot()
  await h.answer(1, got)
  t.alike(h.calls.url, [], 'never turned into a URL')
  t.alike([...got.bytes], [0, 0, 0])
  t.is(h.store.peek(h.key(1)), null)

  const waiting = h.store.read(photo(2))
  h.store.want('viewer', [])
  t.alike(await waiting, { phase: 'off' }, 'the waiting caller is answered at once')
  await h.answer(2, nativeGot('late.bin'))
  t.alike(h.calls.forget, ['late.bin'])
  t.is(h.timers.size, 0)
})

test('a result landing after clear() is forgotten and zeroed; clear leaves no timer', async (t) => {
  const h = await setup()
  h.store.read(photo(1))
  h.store.want('viewer', [photo(1), photo(2), photo(3)])
  await h.answer(1, webGot())
  h.store.read(photo(4))
  t.ok(h.timers.size > 0)
  h.store.clear()
  t.alike(h.calls.revoke, ['blob:1'])
  t.is(h.timers.size, 0)
  const web = webGot()
  await h.answer(2, web)
  t.alike([...web.bytes], [0, 0, 0])
  await h.answer(4, nativeGot('gone.bin'))
  t.alike(h.calls.forget, ['gone.bin'])
  t.is(h.calls.url.length, 1)
  t.alike(h.seqs(), [1, 2, 4], 'nothing else is read')
  t.alike(await h.store.read(photo(5)), { phase: 'off' })
  h.store.want('viewer', [photo(6)])
  h.store.fail(h.key(6))
  t.alike(h.seqs(), [1, 2, 4])
  t.is(h.timers.size, 0)
})

test('wrong mime, wrong video ms and a rejected read give off and are not cached', async (t) => {
  const h = await setup()
  const wrong = h.store.read(photo(1))
  const got = nativeGot('png.bin', 'image/png')
  await h.answer(1, got)
  t.alike(await wrong, { phase: 'off' })
  t.alike(h.calls.forget, ['png.bin'])
  t.is(h.store.peek(h.key(1)), null, 'not cached')
  h.store.read(photo(1))
  t.is(h.seqs().filter((s) => s === 1).length, 2, 'the next read asks again')
  await h.answer(1, webGot())

  const longer = h.store.read(video(2))
  const bytes = webGot('video/mp4', { ms: 5000 })
  await h.answer(2, bytes)
  t.alike(await longer, { phase: 'off' })
  t.alike([...bytes.bytes], [0, 0, 0])
  t.is(h.calls.url.length, 1)

  const noSize = h.store.read(video(3))
  await h.answer(3, webGot('video/mp4', { ms: 4000, w: 0 }))
  t.alike(await noSize, { phase: 'off' })

  const notImage = h.store.read({ ...photo(4), expected: { mime: 'image/svg+xml' } })
  await h.answer(4, webGot('image/svg+xml'))
  t.alike(await notImage, { phase: 'off' })

  const rejected = h.store.read(photo(5))
  await h.answer(5, new Error('NOT_FOUND'))
  t.alike(await rejected, { phase: 'off' })
  t.is(h.store.peek(h.key(5)), null)
  h.store.read(photo(5))
  t.is(h.seqs().filter((s) => s === 5).length, 2)
})

test('a failed ahead read is silent and not retried until the next want()', async (t) => {
  const h = await setup()
  h.store.want('viewer', [photo(1), photo(2)])
  await h.answer(1, new Error('busy'))
  t.alike(h.seqs(), [1, 2], 'the queue moves on')
  await h.answer(2, webGot())
  t.alike(h.seqs(), [1, 2], 'no loop on the failed key')
  h.store.want('viewer', [photo(1), photo(2)])
  t.alike(h.seqs(), [1, 2, 1], 'the next want asks again')
  await h.answer(1, webGot())
})

test('the until timer releases the entry; an expired ref is never read', async (t) => {
  const h = await setup()
  h.store.want('viewer', [photo(1, A, { until: start + 1000 })])
  await h.answer(1, webGot())
  t.is(h.store.peek(h.key(1))?.phase, 'ok')
  await h.advance(1000)
  t.alike(h.calls.revoke, ['blob:1'])
  t.is(h.store.peek(h.key(1)), null)
  h.store.want('viewer', [photo(1, A, { until: start + 1000 })])
  t.is(h.calls.read.length, 1, 'expired: not read ahead again')
  t.alike(await h.store.read(photo(1, A, { until: start + 1000 })), { phase: 'off' })
  t.is(h.calls.read.length, 1, 'nor by read()')

  const pendingRead = h.store.read(photo(2, A, { until: start + 2000 }))
  await h.advance(1000)
  t.alike(await pendingRead, { phase: 'off' }, 'expiring while pending')
  await h.answer(2, webGot())
  t.is(h.calls.url.length, 1)
})

test('the max-age timer releases an ahead entry and a later want reads it again', async (t) => {
  const h = await setup({ maxAgeMs: 60000 })
  h.store.want('viewer', [photo(1), photo(2)])
  await h.answer(1, webGot())
  await h.answer(2, webGot())
  await h.advance(59999)
  t.alike(h.calls.revoke, [])
  await h.advance(1)
  t.alike(h.calls.revoke, ['blob:2'], 'the ahead entry is released, the one on screen kept')
  t.is(h.store.peek(h.key(2)), null)
  t.is(h.store.peek(h.key(1))?.phase, 'ok')
  h.store.want('viewer', [photo(1), photo(2)])
  t.alike(h.seqs(), [1, 2, 2], 'read again')
  await h.drain()
})

test('the photo on screen outlives the max age while first in a list or held by read()', async (t) => {
  const h = await setup({ maxAgeMs: 60000 })
  h.store.want('viewer', [photo(1)])
  await h.answer(1, webGot())
  await h.advance(3 * 60000)
  t.alike(h.calls.revoke, [], 'listed at index 0: the max age is re-armed')
  t.is(h.store.peek(h.key(1))?.phase, 'ok')
  h.store.want('viewer', [photo(2), photo(1)])
  await h.answer(2, webGot())
  await h.advance(60000)
  t.alike(h.calls.revoke, ['blob:1'], 'released once it is only read ahead')
  t.is(h.store.peek(h.key(2))?.phase, 'ok', 'the new first one is kept')

  const held = h.store.read(photo(5), 'viewer')
  await h.answer(5, webGot())
  t.alike(await held, { phase: 'ok', uri: 'blob:3', ms: undefined })
  await h.advance(2 * 60000)
  t.alike(h.calls.revoke, ['blob:1'], 'held by read(): kept')
  h.store.want('viewer', [photo(2)])
  t.alike(h.calls.revoke, ['blob:1', 'blob:3'], 'released when the hold ends')
})

test('the until timer releases the photo on screen', async (t) => {
  const h = await setup({ maxAgeMs: 60000 })
  const soon = photo(1, A, { until: start + 90000 })
  h.store.want('viewer', [soon])
  h.store.read(soon, 'viewer')
  await h.answer(1, webGot())
  await h.advance(60000)
  t.alike(h.calls.revoke, [], 'the max age is re-armed')
  await h.advance(30000)
  t.alike(h.calls.revoke, ['blob:1'], 'the momento expired')
  t.is(h.store.peek(h.key(1)), null)
  t.is(h.timers.size, 0)
})

test('read(ref, owner) holds until that owner\'s next want() without the key', async (t) => {
  const h = await setup()
  const shown = h.store.read(photo(1), 'viewer')
  h.store.want('strip', [photo(2)])
  await h.answer(1, webGot())
  t.alike(await shown, { phase: 'ok', uri: 'blob:1', ms: undefined }, 'another owner\'s want does not end the hold')
  await h.answer(2, webGot())
  h.store.want('strip', [])
  t.alike(h.calls.revoke, ['blob:2'])
  t.is(h.store.peek(h.key(1))?.phase, 'ok')
  h.store.want('viewer', [photo(1)])
  t.alike(h.calls.revoke, ['blob:2'], 'listed by the same owner: still held')
  h.store.want('viewer', [photo(3)])
  t.alike(h.calls.revoke, ['blob:2', 'blob:1'], 'that owner\'s want without it ends the hold')
  t.is(h.store.peek(h.key(1)), null)
  await h.drain()
})

test('a slow read of the item on screen passes the watchdog without a second media.read', async (t) => {
  const h = await setup({ aheadStallMs: 30000 })
  const shown = h.store.read(photo(1), 'viewer')
  h.store.want('viewer', [photo(1)])
  await h.advance(30000)
  t.alike(h.seqs(), [1], 'no duplicate download at the watchdog')
  await h.advance(10000)
  t.alike(h.seqs(), [1])
  t.is(h.store.peek(h.key(1)), null, 'still pending')
  t.alike(await Promise.race([shown, Promise.resolve('waiting')]), 'waiting', 'the caller still waits for the answer')
  await h.answer(1, webGot())
  t.is(h.store.peek(h.key(1))?.phase, 'ok', 'the answer at 40 s lands')
  t.alike(await shown, { phase: 'ok', uri: 'blob:1', ms: undefined })
  h.store.want('viewer', [])
  t.alike(h.calls.revoke, ['blob:1'], 'released once when nothing wants it')
  h.store.clear()
  t.is(h.timers.size, 0, 'clear() leaves no watchdog')
})

test('a slow ahead read past the watchdog is joined by read(), not read again', async (t) => {
  const h = await setup({ aheadStallMs: 30000 })
  h.store.want('viewer', [photo(2), photo(1)])
  t.alike(h.seqs(), [2])
  await h.answer(2, webGot())
  t.alike(h.seqs(), [2, 1], 'the next item is read ahead')
  await h.advance(30000)
  t.is(h.store.peek(h.key(1)), null, 'still pending past the watchdog')
  const joined = h.store.read(photo(1), 'viewer')
  h.store.want('viewer', [photo(1), photo(3)])
  t.alike(h.seqs().filter((s) => s === 1), [1], 'stepping onto it joins the read in flight')
  await h.advance(30000)
  t.alike(h.seqs().filter((s) => s === 1), [1], 'and no watchdog repeats it')
  await h.answer(1, webGot())
  t.alike(await joined, { phase: 'ok', uri: 'blob:2', ms: undefined }, 'read() resolves with the late answer')
  t.is(h.store.peek(h.key(1))?.phase, 'ok')
  await h.drain()
})

test('a stale ahead read released by a want() that drops it: its late answer is zeroed, nothing cached', async (t) => {
  const h = await setup({ aheadStallMs: 30000 })
  h.store.want('viewer', [photo(1), photo(2)])
  await h.advance(30000)
  t.alike(h.seqs(), [1, 2], 'the stale read 1 frees its slot')
  h.store.want('viewer', [photo(2), photo(1)])
  await h.answer(2, webGot())
  t.alike(h.seqs(), [1, 2], 'still listed and pending: read 1 is not started again')
  h.store.want('viewer', [photo(3)])
  t.alike(h.seqs(), [1, 2, 3], 'one stale read: read-ahead goes on')
  const late = webGot()
  await h.answer(1, late)
  t.alike([...late.bytes], [0, 0, 0], 'the late answer of the released entry is zeroed')
  t.is(h.calls.url.length, 1, 'never turned into a URL')
  t.is(h.store.peek(h.key(1)), null, 'nothing cached')
  t.alike(h.seqs(), [1, 2, 3], 'a stale answer frees nothing in flight')

  h.store.want('viewer', [photo(3), photo(4)])
  await h.answer(3, webGot())
  t.alike(h.seqs(), [1, 2, 3, 4])
  await h.advance(30000)
  h.store.want('viewer', [photo(5)])
  await h.answer(4, nativeGot('late.bin'))
  t.alike(h.calls.forget, ['late.bin'], 'a native late answer is forgotten')
  t.is(h.store.peek(h.key(4)), null)
  t.is(h.calls.revoke.length, 2, 'only the settled 2 and 3 were revoked')
  await h.drain()
  h.store.clear()
  t.is(h.timers.size, 0)
})

test('peek returns the settled value synchronously, null while pending', async (t) => {
  const h = await setup()
  t.is(h.store.peek(h.key(1)), null)
  h.store.read(photo(1))
  t.is(h.store.peek(h.key(1)), null)
  await h.answer(1, webGot('image/jpeg'))
  t.alike(h.store.peek(h.key(1)), { phase: 'ok', uri: 'blob:1', ms: undefined })
})

test('fail(key) releases the entry and caches off until want or timers release it', async (t) => {
  const h = await setup({ maxAgeMs: 60000 })
  h.store.want('viewer', [photo(1)])
  await h.answer(1, webGot())
  h.store.fail(h.key(1))
  t.alike(h.calls.revoke, ['blob:1'])
  t.alike(h.store.peek(h.key(1)), { phase: 'off' })
  t.alike(await h.store.read(photo(1)), { phase: 'off' })
  h.store.want('viewer', [photo(1)])
  t.is(h.calls.read.length, 1, 'no loop')
  h.store.want('viewer', [])
  t.is(h.store.peek(h.key(1)), null)
  h.store.want('viewer', [photo(1)])
  t.is(h.calls.read.length, 2, 'read again once released')
  await h.answer(1, webGot())
  h.store.fail(h.key(1))
  await h.advance(60000)
  t.is(h.store.peek(h.key(1)), null, 'the max-age timer releases the cached off')
})

// The current store of momentPhotosFor is module state: each case resets it.
async function forSetup () {
  const mod = await load()
  mod.resetMomentPhotosForTests()
  let timerId = 0
  let urls = 0
  const timers = new Map()
  const calls = { read: [], revoke: [], forget: [] }
  const deps = {
    now: () => start,
    setTimer: (fn) => { timers.set(++timerId, fn); return timerId },
    clearTimer: (id) => timers.delete(id),
    urlFromBytes: () => 'blob:' + (++urls),
    revokeUrl: (uri) => calls.revoke.push(uri),
    adoptVideoFile: () => null
  }
  const newMedia = (answer = () => webGot()) => ({
    read: (params) => { calls.read.push(params); return Promise.resolve(answer(params)) },
    forgetReadFile: (name) => calls.forget.push(name)
  })
  // Settles photo(seq) in the store, as the item on screen.
  const show = async (store, seq) => {
    store.want('viewer', [photo(seq)])
    await flush()
    return store.peek(mod.momentPhotoKey(A, seq))
  }
  return { ...mod, timers, calls, deps, newMedia, show }
}

test('momentPhotosFor: one store per media and epoch; a new one clears the old', async (t) => {
  const h = await forSetup()
  const media = h.newMedia()
  const one = h.momentPhotosFor(media, 1, h.deps)
  t.ok(one)
  t.is(h.momentPhotosFor(media, 1, h.deps), one)
  t.is((await h.show(one, 1))?.phase, 'ok')

  const two = h.momentPhotosFor(media, 2, h.deps)
  t.not(two, one, 'a new epoch on the same media')
  t.alike(h.calls.revoke, ['blob:1'], 'the old store is cleared')
  t.is(one.peek(h.momentPhotoKey(A, 1)), null)
  t.is(h.timers.size, 0)
  t.alike(await one.read(photo(3)), { phase: 'off' })
  t.is(h.calls.read.length, 1)

  t.is((await h.show(two, 1))?.phase, 'ok')
  t.ok(h.timers.size > 0)
  const other = h.momentPhotosFor(h.newMedia(), 2, h.deps)
  t.ok(other)
  t.not(other, two, 'another media object')
  t.alike(h.calls.revoke, ['blob:1', 'blob:2'], 'the replaced store is cleared')
  t.is(two.peek(h.momentPhotoKey(A, 1)), null)
  t.is(h.timers.size, 0)
  t.is(h.momentPhotosFor(media, 3, h.deps), null, 'a replaced media never comes back')
})

test('momentPhotosFor: a lock (null or invalid media) clears the store at once', async (t) => {
  const h = await forSetup()
  const media = h.newMedia(() => nativeGot('abc.bin'))
  const store = h.momentPhotosFor(media, 1, h.deps)
  t.is((await h.show(store, 1))?.phase, 'ok')
  t.alike(h.calls.forget, [], 'kept while shown')
  t.is(h.momentPhotosFor(null, 2, h.deps), null)
  t.alike(h.calls.forget, ['abc.bin'], 'released by the lock')
  t.is(store.peek(h.momentPhotoKey(A, 1)), null)
  t.is(h.timers.size, 0)

  const after = h.momentPhotosFor(h.newMedia(), 3, h.deps)
  t.ok(after)
  t.not(after, store, 'unlock gets a new store')
  t.is(store.peek(h.momentPhotoKey(A, 1)), null)
  t.is(h.momentPhotosFor(media, 1, h.deps), null, 'the locked media gets nothing')
  t.is((await h.show(after, 2))?.phase, 'ok')
  t.is(h.momentPhotosFor({}, 3, h.deps), null)
  t.alike(h.calls.revoke, ['blob:1'], 'a media without read clears too')
  t.is(h.timers.size, 0)
})

test('momentPhotosFor: an older epoch of the same media gets null and keeps the current store', async (t) => {
  const h = await forSetup()
  const media = h.newMedia()
  const store = h.momentPhotosFor(media, 3, h.deps)
  t.is((await h.show(store, 1))?.phase, 'ok')
  t.is(h.momentPhotosFor(media, 2, h.deps), null)
  t.alike(h.calls.revoke, [])
  t.is(store.peek(h.momentPhotoKey(A, 1))?.phase, 'ok')
  t.is(h.momentPhotosFor(media, 3, h.deps), store)

  const named = h.momentPhotosFor(media, 'b', h.deps)
  t.ok(named, 'an epoch that is not a number is new when different')
  t.not(named, store)
  t.alike(h.calls.revoke, ['blob:1'])
})
