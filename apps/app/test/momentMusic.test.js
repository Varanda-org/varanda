'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { displayText } = require('@varanda/rpc')
const source = fs.readFileSync(path.join(__dirname, '../src/ui/MomentMusic.js'), 'utf8')
const flush = () => new Promise((resolve) => setImmediate(resolve))
const track = { id: 'abc', title: 'Faixa\u202e', artist: 'Artista\u0007', duration: 90, url: 'https://audius.co/artist/abc' }
const ticket = { url: '/account/audius/audio/' + 'a'.repeat(43), base: 'https://installation.test', expiresAt: '2099-01-01T00:00:00Z' }

test('cover tile and equalizer stay local and themed', (t) => {
  const cover = fs.readFileSync(path.join(__dirname, '../src/ui/MusicCover.js'), 'utf8')
  const equalizer = fs.readFileSync(path.join(__dirname, '../src/ui/MusicEqualizer.js'), 'utf8')
  for (const src of [cover, equalizer]) {
    t.absent(/\bfetch\s*\(|https?:\/\/|Platform\.OS|\u2014/.test(src))
    t.ok(src.includes('useStyles(makeStyles)'))
    t.ok(src.includes('useTheme()'))
    t.ok(src.includes('accessibilityElementsHidden'))
    t.ok(src.includes("importantForAccessibility='no-hide-descendants'"))
    t.ok(src.includes('aria-hidden'))
  }
  t.ok(cover.includes("name='musica'"))
  t.ok(cover.includes('colors.skeleton'))
  // The Image branch draws only a cover the session cache holds.
  t.ok(cover.includes('/^data:image\\/(jpeg|png|webp);base64,/'))
  t.ok(cover.includes('source={{ uri }}'))
  t.ok(cover.includes("accessibilityRole='image'"))
  t.ok(cover.includes('accessibilityIgnoresInvertColors'))
  t.ok(cover.includes('onError={'))
  t.absent(/urlFromBytes|AsyncStorage|indexedDB/.test(cover))
  t.ok(equalizer.includes('loopTiming('))
  t.ok(equalizer.includes('isReduceMotionEnabled'))
})

// The real MusicCover, with React Native replaced by plain element objects.
function musicCover (src) {
  const { transformSync } = require('@babel/core')
  const deps = {
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) },
    useState: (initial) => [initial, () => {}],
    Image: 'Image',
    View: 'View',
    StyleSheet: { create: (styles) => styles },
    displayText,
    Icon: 'Icon',
    useStyles: () => ({}),
    useTheme: () => ({ colors: { soft: '#4a554e' } }),
    radius: {}
  }
  const input = src.replace(/^import .+\n/gm, '').replace(/\bexport /g, '')
  const { code } = transformSync(input, { configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-react-jsx'] })
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), code + '\nreturn MusicCover')(...Object.values(deps))
}

test('only a base64 JPEG, PNG or WebP cover is drawn, never an SVG', (t) => {
  const MusicCover = musicCover(fs.readFileSync(path.join(__dirname, '../src/ui/MusicCover.js'), 'utf8'))
  const drawn = (uri) => nodes(MusicCover({ uri })).some((n) => n.type === 'Image')
  const tile = (uri) => nodes(MusicCover({ uri })).some((n) => n.type === 'Icon' && n.props.name === 'musica')
  for (const mime of ['jpeg', 'png', 'webp']) {
    const uri = 'data:image/' + mime + ';base64,AAAA'
    t.ok(drawn(uri), mime + ' is drawn')
    t.is(nodes(MusicCover({ uri })).find((n) => n.type === 'Image').props.source.uri, uri)
  }
  for (const [uri, why] of [
    ['data:image/svg+xml;base64,PHN2Zy8+', 'an SVG'],
    ['data:image/svg+xml,<svg onload="x()"/>', 'a plain SVG'],
    ['data:image/gif;base64,R0lGODlh', 'a GIF'],
    ['data:image/png,AAAA', 'a PNG without ;base64,'],
    ['data:image/PNG;base64,AAAA', 'another spelling'],
    ['https://evil.example/a.png', 'a URL'],
    [null, 'no uri']
  ]) {
    t.absent(drawn(uri), why + ' is not drawn')
    t.ok(tile(uri), why + ' shows the tile')
  }
})

function deferred () {
  let resolve, reject
  const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  return { promise, resolve, reject }
}

async function dependencies () {
  return { ...await import('../src/music.js'), ...await import('../src/moments.js'), ...await import('../src/media/chatMedia.js') }
}

// Execute the real controller with local account and stream doubles.
async function fixture (t, options = {}) {
  const calls = []
  const states = []
  const players = []
  const timers = new Map()
  const unavailable = []
  let starts = 0
  let serial = 0
  const deps = {
    ...await dependencies(),
    ...options.dependencies,
    audiusItem: async (kind, id, opts) => { calls.push(['item', kind, id, opts]); return options.item ? options.item() : track },
    audiusPlay: async (id, opts) => { calls.push(['ticket', id, opts]); return options.ticket ? options.ticket() : ticket },
    createStreamPlayer: (url, opts) => {
      calls.push(['create', url, opts])
      const progress = new Set()
      const errors = new Set()
      const player = {
        play: async () => { calls.push(['play']); if (options.play) await options.play(player) },
        pause: () => calls.push(['pause']),
        seek: async (ms) => { calls.push(['seek', ms]); if (options.seek) await options.seek(player) },
        release: () => calls.push(['release']),
        onProgress: (fn) => { progress.add(fn); return () => progress.delete(fn) },
        onError: (fn) => { errors.add(fn); return () => errors.delete(fn) },
        progress: (value) => { for (const fn of [...progress]) fn(value) },
        error: (err) => { for (const fn of [...errors]) fn(err) },
        progressListeners: progress,
        errorListeners: errors
      }
      players.push(player)
      return player
    },
    setTimeout: (fn, ms) => { timers.set(++serial, { fn, ms }); return serial },
    clearTimeout: (id) => timers.delete(id)
  }
  const body = source.slice(source.indexOf('export const momentMusicIdle'), source.indexOf('export function MomentMusic')).replace(/\bexport /g, '')
  // eslint-disable-next-line no-new-func
  const create = new Function(...Object.keys(deps), body + '\nreturn createMomentPlayback')(...Object.values(deps))
  const session = { member: 'b'.repeat(64), origin: 'node-origin', request: () => {}, ...options.session }
  const playback = create(session, options.music || { id: 'abc', start: 30 }, (state) => states.push(state), {
    onStart: () => { starts++ },
    onUnavailable: (error) => unavailable.push(error)
  })
  t.teardown(() => playback.release())
  return { playback, calls, states, players, timers, unavailable, session, starts: () => starts }
}

const count = (f, name) => f.calls.filter((c) => c[0] === name).length
const progress = (player, ms, extra) => player.progress({ ms, playing: true, buffering: false, ended: false, ...extra })

test('mount starts a single snippet using the ticket base, confirmed seek and real playing progress', async (t) => {
  const f = await fixture(t, { seek: async (player) => progress(player, 0, { playing: false }) })
  t.alike(f.calls, [], 'constructing the controller makes no requests')
  await f.playback.start()
  t.alike(f.calls.map((c) => c[0]), ['item', 'ticket', 'create', 'seek', 'play'])
  t.alike(f.calls[2], ['create', ticket.url, { origin: ticket.base }])
  t.alike(f.calls[3], ['seek', 30000])
  t.alike(f.calls[0].slice(1, 3), ['track', 'abc'])
  for (const opts of [f.calls[0][3], f.calls[1][2]]) {
    t.is(opts.origin, f.session.origin)
    t.is(opts.member, f.session.member)
    t.is(opts.request, f.session.request)
    t.absent(opts.signal.aborted)
  }
  t.is(f.starts(), 0, 'play resolving does not yet mean audible audio')
  progress(f.players[0], 30000, { buffering: true })
  t.is(f.starts(), 0)
  progress(f.players[0], 30000)
  progress(f.players[0], 31000)
  t.is(f.starts(), 1)
  t.is([...f.timers.values()][0].ms, 14000)
  progress(f.players[0], 45000)
  t.is(f.states.at(-1).phase, 'ended')
  t.is(count(f, 'release'), 1)
  t.is(f.timers.size, 0)
  await f.playback.start()
  await f.playback.press()
  t.is(count(f, 'play'), 1, 'a finished snippet never loops')
})

test('snippet timers stop at fifteen seconds or the shorter track end', async (t) => {
  for (const [duration, start, length] of [[90, 30, 15000], [7, 0, 7000]]) {
    const f = await fixture(t, { music: { id: 'abc', start }, item: async () => ({ ...track, duration }) })
    await f.playback.start()
    progress(f.players[0], start * 1000)
    const timer = [...f.timers.values()][0]
    t.is(timer.ms, length)
    timer.fn()
    t.is(count(f, 'release'), 1)
    t.is(f.states.at(-1).phase, 'ended')
    await f.playback.press()
    t.is(count(f, 'play'), 1, 'the timer end cannot be restarted')
  }
})

test('the stream end stays ended and a tap does not restart it', async (t) => {
  const f = await fixture(t)
  await f.playback.start()
  progress(f.players[0], 31000, { ended: true, playing: false })
  t.is(f.states.at(-1).phase, 'ended')
  await f.playback.press()
  t.is(count(f, 'play'), 1)
  t.is(count(f, 'release'), 1)
})

test('forged starts and rejected seeks never play from zero', async (t) => {
  const { MUSIC_SEEK_TEXT } = await dependencies()
  const f = await fixture(t, { music: { id: 'abc', start: 89 } })
  await f.playback.start()
  t.is(count(f, 'ticket'), 0)
  t.alike(f.unavailable, [MUSIC_SEEK_TEXT])
  for (const code of ['seek-range', 'seek', 'seek-timeout']) {
    const f = await fixture(t, { seek: async () => { throw Object.assign(new Error('seek failed'), { code }) } })
    await f.playback.start()
    t.is(count(f, 'play'), 0)
    t.is(count(f, 'release'), 1)
    t.alike(f.unavailable, [MUSIC_SEEK_TEXT])
  }
})

test('progress before the requested start fails without announcing playback', async (t) => {
  const { MUSIC_SEEK_TEXT } = await dependencies()
  const f = await fixture(t)
  await f.playback.start()
  progress(f.players[0], 0)
  t.alike(f.unavailable, [MUSIC_SEEK_TEXT])
  t.is(f.starts(), 0)
  t.is(count(f, 'release'), 1)
})

test('pause and mute suspend the snippet and its timer without another seek or ticket', async (t) => {
  const f = await fixture(t)
  f.playback.setPaused(true)
  await f.playback.start()
  t.is(count(f, 'seek'), 1)
  t.is(count(f, 'play'), 0)
  await f.playback.setPaused(false)
  progress(f.players[0], 30000)
  t.is(f.timers.size, 1)
  await f.playback.setPaused(true)
  t.is(f.timers.size, 0)
  progress(f.players[0], 31000)
  t.is(f.timers.size, 0, 'late progress while paused cannot arm a timer')
  await f.playback.setPaused(false)
  progress(f.players[0], 31000)
  t.is([...f.timers.values()][0].ms, 14000)
  t.is(count(f, 'play'), 2)
  t.is(count(f, 'seek'), 1)
  t.is(count(f, 'ticket'), 1)
  t.is(f.starts(), 1)
  progress(f.players[0], 31000, { buffering: true })
  t.is(f.timers.size, 0, 'buffering suspends the timer too')
})

test('a refused autoplay offers a direct gesture retry on the prepared player', async (t) => {
  let attempts = 0
  const f = await fixture(t, {
    play: async (player) => {
      if (++attempts === 1) player.error({ code: 'play', cause: { name: 'NotAllowedError' } })
    }
  })
  await f.playback.start()
  t.is(f.states.at(-1).phase, 'gesture')
  t.is(f.unavailable.length, 1)
  t.is(count(f, 'release'), 0, 'the already sought player remains ready for the gesture')
  await f.playback.setPaused(true)
  await f.playback.press()
  t.is(count(f, 'play'), 1, 'a gesture cannot play while the viewer is paused')
  await f.playback.setPaused(false)
  t.is(count(f, 'play'), 1, 'resuming the viewer cannot consume the gesture')
  const retry = f.playback.press()
  t.is(count(f, 'play'), 2, 'play is called synchronously at the tap')
  await retry
  progress(f.players[0], 30000)
  t.is(f.starts(), 1)
  t.is(count(f, 'ticket'), 1)
  t.is(count(f, 'seek'), 1)
})

test('rejected autoplay promises also offer the gesture chip', async (t) => {
  const f = await fixture(t, { play: async () => { throw Object.assign(new Error('gesture'), { name: 'NotAllowedError' }) } })
  await f.playback.start()
  t.is(f.states.at(-1).phase, 'gesture')
  t.is(f.unavailable.length, 1)
})

test('a refused restart after interruption keeps the first start and never reports unavailable', async (t) => {
  const { stopBoundPlayback } = await dependencies()
  for (const report of ['event', 'promise']) {
    let attempts = 0
    const f = await fixture(t, {
      play: async (player) => {
        if (++attempts !== 2) return
        const error = Object.assign(new Error('gesture'), { name: 'NotAllowedError' })
        if (report === 'promise') throw error
        player.error({ code: 'play', cause: error })
      }
    })
    await f.playback.start()
    progress(f.players[0], 30000)
    t.is(f.starts(), 1)
    stopBoundPlayback()
    t.is(f.states.at(-1).phase, 'gesture')
    const next = f.calls.length
    await f.playback.press()
    t.alike(f.calls.slice(next).map((c) => c[0]), ['item', 'ticket', 'create', 'seek', 'play', 'pause'])
    t.is(f.states.at(-1).phase, 'gesture', report + ': refused restart offers another tap')
    t.alike(f.unavailable, [], report + ': refusal after the first start preserves the viewer hold')
    t.is(f.timers.size, 0)
    t.is(f.starts(), 1)
    await f.playback.press()
    progress(f.players[1], 30000)
    t.is(f.states.at(-1).phase, 'playing')
    t.is(f.starts(), 1, 'the next tap does not reset the viewer hold')
    t.is(count(f, 'ticket'), 2, 'the next tap reuses the prepared player')
    t.alike(f.unavailable, [])
    f.playback.release()
  }
})

test('account, ticket and player failures report unavailable and release resources', async (t) => {
  const { MUSIC_UNAVAILABLE_TEXT, MUSIC_SEEK_TEXT } = await dependencies()
  for (const key of ['item', 'ticket', 'play']) {
    const f = await fixture(t, { [key]: async () => { throw new Error('failure') } })
    await f.playback.start()
    t.alike(f.unavailable, [MUSIC_UNAVAILABLE_TEXT], key)
    t.is(count(f, 'release'), key === 'play' ? 1 : 0)
  }
  for (const code of ['load-timeout', 'stall', 'seek', 'seek-timeout']) {
    const f = await fixture(t, { seek: async (player) => player.error({ code }) })
    await f.playback.start()
    t.alike(f.unavailable, [code.startsWith('seek') ? MUSIC_SEEK_TEXT : MUSIC_UNAVAILABLE_TEXT])
    t.is(count(f, 'play'), 0)
    t.is(count(f, 'release'), 1)
  }
  const f = await fixture(t)
  await f.playback.start()
  f.players[0].error({ code: 'seek' })
  t.alike(f.unavailable, [MUSIC_UNAVAILABLE_TEXT], 'seek codes outside seeking are unavailable')
})

test('a ticket answered after stopBoundPlayback never creates or plays audio', async (t) => {
  const { stopBoundPlayback } = await dependencies()
  const pending = deferred()
  const f = await fixture(t, { ticket: () => pending.promise })
  const loading = f.playback.start()
  await flush()
  t.is(count(f, 'ticket'), 1)
  stopBoundPlayback()
  t.is(f.states.at(-1).phase, 'gesture')
  t.is(f.states.at(-1).error, '')
  pending.resolve(ticket)
  await loading
  t.is(f.states.at(-1).phase, 'gesture', 'the late ticket cannot hide the gesture')
  t.is(count(f, 'create'), 0)
  t.is(count(f, 'play'), 0)
  t.ok(f.calls[1][2].signal.aborted)
  t.is(f.starts(), 0)
  t.alike(f.unavailable, [], 'screen changes are not failures on the next screen')
})

test('screen changes cancel item, seek and play waits and stale gesture taps', async (t) => {
  const { stopBoundPlayback, playbackEpoch } = await dependencies()
  for (const key of ['item', 'seek', 'play']) {
    const pending = deferred()
    const f = await fixture(t, { [key]: () => pending.promise })
    const epoch = playbackEpoch()
    const loading = f.playback.start(epoch)
    await flush()
    stopBoundPlayback()
    t.is(f.states.at(-1).phase, 'gesture', key + ': interruption offers a new attempt')
    t.is(f.states.at(-1).error, '')
    pending.resolve(track)
    await loading
    await f.playback.press(epoch)
    t.is(f.states.at(-1).phase, 'gesture', key + ': late completion and stale taps keep the gesture')
    t.is(count(f, 'play'), key === 'play' ? 1 : 0)
    t.is(count(f, 'release'), key === 'item' ? 0 : 1)
    t.is(f.starts(), 0)
    t.alike(f.unavailable, [])
  }
})

test('interrupted playback restarts with a fresh ticket and seek, but announces the start only once', async (t) => {
  const { stopBoundPlayback, playbackEpoch } = await dependencies()
  const f = await fixture(t)
  await f.playback.start()
  progress(f.players[0], 30000)
  const epoch = playbackEpoch()
  stopBoundPlayback()
  t.is(f.states.at(-1).phase, 'gesture')
  t.is(f.states.at(-1).error, '')
  t.is(count(f, 'release'), 1)
  t.is(f.timers.size, 0)
  t.alike(f.unavailable, [])
  t.is(f.starts(), 1)
  await f.playback.start()
  await f.playback.press(epoch)
  f.playback.setPaused(true)
  await f.playback.press()
  await f.playback.setPaused(false)
  t.is(count(f, 'item'), 1, 'only an unpaused tap in the current epoch can restart')
  const next = f.calls.length
  const restart = f.playback.press(playbackEpoch())
  await f.playback.press()
  await restart
  t.alike(f.calls.slice(next).map((c) => c[0]), ['item', 'ticket', 'create', 'seek', 'play'])
  t.alike(f.calls[next + 3], ['seek', 30000])
  t.is(count(f, 'ticket'), 2)
  t.is(f.players.length, 2)
  t.is(f.calls[next]?.[3].signal.aborted, false)
  if (f.players[1]) progress(f.players[1], 30000)
  t.is(f.states.at(-1).phase, 'playing')
  t.is(f.starts(), 1, 'the viewer keeps the first start time')
  t.alike(f.unavailable, [])
})

test('a new attempt owns playback while an interrupted item, ticket or seek is still pending', async (t) => {
  const { stopBoundPlayback } = await dependencies()
  for (const key of ['item', 'ticket', 'seek']) {
    const pending = deferred()
    let attempts = 0
    const result = key === 'ticket' ? ticket : track
    const f = await fixture(t, { [key]: () => ++attempts === 1 ? pending.promise : result })
    const loading = f.playback.start()
    await flush()
    stopBoundPlayback()
    t.is(f.states.at(-1).phase, 'gesture', key)
    const restart = f.playback.press()
    await f.playback.press()
    await restart
    t.is(count(f, 'item'), 2, key + ': only one new job')
    t.is(count(f, 'play'), 1, key + ': only the new job plays')
    const player = f.players.at(-1)
    if (player) progress(player, 30000)
    pending.resolve(result)
    await loading
    t.is(count(f, 'play'), 1, key + ': late completion never plays')
    t.is(count(f, 'release'), key === 'seek' ? 1 : 0)
    t.is(f.states.at(-1).phase, 'playing')
    t.is(f.starts(), 1)
    t.alike(f.unavailable, [])
    f.playback.release()
  }
})

test('an epoch change observed by progress offers a gesture without reporting a failure', async (t) => {
  const { playbackEpoch } = await dependencies()
  let epoch = playbackEpoch()
  const f = await fixture(t, { dependencies: { playbackEpoch: () => epoch } })
  await f.playback.start()
  progress(f.players[0], 30000)
  epoch++
  progress(f.players[0], 31000)
  t.is(f.states.at(-1).phase, 'gesture')
  t.is(f.states.at(-1).error, '')
  t.is(count(f, 'release'), 1)
  t.is(f.timers.size, 0)
  t.alike(f.unavailable, [])
})

test('a newer playback claim aborts a pending momento ticket', async (t) => {
  const { claimPlayback } = await dependencies()
  const pending = deferred()
  const f = await fixture(t, { ticket: () => pending.promise })
  const loading = f.playback.start()
  await flush()
  let pauses = 0
  const unclaim = claimPlayback({ pause: () => { pauses++ } })
  pending.resolve(ticket)
  await loading
  t.is(count(f, 'play'), 0)
  t.is(f.states.at(-1).phase, 'gesture', 'a newer claim also allows a later tap')
  t.alike(f.unavailable, [])
  t.is(pauses, 0, 'the old ticket never takes the newer claim')
  unclaim()
})

test('unmount aborts requests, removes listeners and releases the player once', async (t) => {
  const f = await fixture(t)
  await f.playback.start()
  progress(f.players[0], 30000)
  const updates = f.states.length
  f.playback.release()
  f.playback.release()
  t.is(count(f, 'release'), 1)
  t.is(f.timers.size, 0)
  t.is(f.players[0].progressListeners.size, 0)
  t.is(f.players[0].errorListeners.size, 0)
  t.ok(f.calls[0][3].signal.aborted)
  await f.playback.press()
  progress(f.players[0], 31000)
  t.is(f.states.length, updates)
})

test('invalid music and disabled origin make no account requests', async (t) => {
  for (const options of [{ music: { id: '../bad', start: 0 } }, { session: { origin: null } }]) {
    const f = await fixture(t, options)
    await f.playback.start()
    t.is(count(f, 'item'), 0)
    t.is(f.unavailable.length, 1)
  }
})

test('shared source escapes provider text, uses a bound claim and releases on unmount', (t) => {
  t.ok(source.includes('displayText(item.title)'))
  t.ok(source.includes('displayText(item.artist)'))
  t.ok(source.includes('claimPlayback(player, { bound: true, epoch })'))
  t.ok(source.includes('const player = { pause: interrupt }'))
  t.ok(source.includes('createStreamPlayer(url, { origin: base })'))
  t.ok(source.includes('return () => { controller.release(); playback.current = null }'))
  t.ok(source.includes('job.player.pause(); job.player.release()'))
  t.ok(source.includes('press(playbackEpoch())'))
  t.absent(/\bfetch\s*\(|https?:\/\/|Platform\.OS|globalThis\.|\bdocument\.|\bwindow\.|WebView|iframe/.test(source))
  t.absent(source.includes('\u2014'))
})

// Render the real component with hook storage and local host elements.
async function ui (stubs) {
  const { transformSync } = require('@babel/core')
  const slots = []
  const pending = []
  let cursor = 0
  const deps = {
    ...await dependencies(),
    useState: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = initial
      return [slots[at], (value) => { slots[at] = value }]
    },
    useRef: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = { current: initial }
      return slots[at]
    },
    useEffect: (fn, deps) => {
      const at = cursor++
      const old = slots[at]
      if (!old || deps.some((value, i) => value !== old.deps[i])) {
        pending.push(() => {
          old?.cleanup?.()
          slots[at] = { deps, cleanup: fn() }
        })
      }
    },
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    StyleSheet: { create: (styles) => styles },
    useStyles: () => ({}),
    useTheme: () => ({ colors: { ink: '#111111', card: '#ffffff', soft: '#4a554e' } }),
    MusicCover: 'MusicCover',
    useMusicCover: () => null,
    MusicEqualizer: 'MusicEqualizer',
    Icon: 'Icon',
    layout: { hit: 44 },
    radius: {},
    space: {},
    displayText,
    ...stubs
  }
  const input = source.replace(/^import .+\n/gm, '').replace(/\bexport /g, '')
  const { code } = transformSync(input, { configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-react-jsx'] })
  // eslint-disable-next-line no-new-func
  const Component = new Function(...Object.keys(deps), code + '\nreturn MomentMusic')(...Object.values(deps))
  return {
    render: (props) => { cursor = 0; return Component(props) },
    mount: () => { for (const fn of pending.splice(0)) fn() },
    unmount: () => { for (const slot of slots) slot?.cleanup?.() }
  }
}

function nodes (tree) {
  return tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : []
}

function textOf (tree) {
  if (typeof tree === 'string') return tree
  return tree && typeof tree === 'object' ? tree.children.map(textOf).join(' ') : ''
}

test('the momento sticker asks no cover before playback starts', async (t) => {
  const item = { ...track, cover: true }
  const loading = deferred()
  const seeking = deferred()
  const covers = []
  const uri = 'data:image/jpeg;base64,Y292ZXI='
  let emit
  let refuse = true
  const h = await ui({
    audiusItem: () => loading.promise,
    audiusPlay: async () => ticket,
    createStreamPlayer: () => ({
      seek: () => seeking.promise,
      play: async () => { if (refuse) throw Object.assign(new Error('gesture'), { name: 'NotAllowedError' }) },
      pause () {},
      release () {},
      onProgress: (fn) => { emit = fn; return () => {} },
      onError: () => () => {}
    }),
    useMusicCover: (...args) => { covers.push(args); return args[3] ? uri : null },
    setTimeout: () => 1,
    clearTimeout () {}
  })
  t.teardown(() => h.unmount())
  const session = { member: 'b'.repeat(64), origin: 'node-origin', request () {} }
  const props = { ...session, music: { id: 'abc', start: 30 }, paused: true }
  h.render(props)
  t.alike(covers.at(-1), ['track', null, session, false], 'mounting cannot request a cover')
  h.mount()
  h.render(props)
  t.is(covers.at(-1)[3], false, 'loading is disabled')
  loading.resolve(item)
  await flush()
  h.render(props)
  t.alike(covers.at(-1), ['track', item, session, false], 'seeking is disabled even with cover metadata')
  seeking.resolve()
  await flush()
  h.render(props)
  t.is(covers.at(-1)[3], false, 'paused before the first start is disabled')
  props.paused = false
  h.render(props)
  h.mount()
  await flush()
  const gesture = nodes(h.render(props)).find((n) => n.type === 'Pressable' && textOf(n).includes('Tocar música'))
  t.ok(gesture)
  t.is(covers.at(-1)[3], false, 'an autoplay refusal keeps covers disabled')
  refuse = false
  await gesture.props.onPress()
  h.render(props)
  t.is(covers.at(-1)[3], false, 'play resolving is not playback progress')
  for (const update of [{ playing: true, buffering: true }, { playing: false, buffering: false }]) {
    emit({ ms: 30000, ...update })
    h.render(props)
    t.is(covers.at(-1)[3], false, 'buffering and stopped progress cannot enable a cover')
  }
  emit({ ms: 30000, playing: true, buffering: false })
  const playing = h.render(props)
  t.alike(covers.at(-1), ['track', item, session, true], 'audible playback enables the cover')
  t.alike(nodes(playing).find((n) => n.type === 'MusicCover').props, { size: 36, uri })
  props.paused = true
  h.render(props)
  h.mount()
  h.render(props)
  t.is(covers.at(-1)[3], true, 'the latch survives a later pause')
  const { stopBoundPlayback } = await dependencies()
  stopBoundPlayback()
  h.render(props)
  t.is(covers.at(-1)[3], true, 'the latch survives a later gesture')
  h.render({ ...props, music: { id: 'def', start: 0 } })
  h.mount()
  h.render({ ...props, music: { id: 'def', start: 0 } })
  t.is(covers.at(-1)[3], false, 'a different momento needs its own playback')
})

test('an account change resets the cover latch', async (t) => {
  const item = { ...track, cover: true }
  const covers = []
  let emit
  const request = () => {}
  const h = await ui({
    audiusItem: async () => item,
    audiusPlay: async () => ticket,
    createStreamPlayer: () => ({
      seek: async () => {},
      play: async () => {},
      pause () {},
      release () {},
      onProgress: (fn) => { emit = fn; return () => {} },
      onError: () => () => {}
    }),
    useMusicCover: (...args) => { covers.push(args); return null },
    setTimeout: () => 1,
    clearTimeout () {}
  })
  t.teardown(() => h.unmount())
  const memberA = 'a'.repeat(64)
  const memberB = 'b'.repeat(64)
  const music = { id: 'abc', start: 30 }
  const propsA = { member: memberA, origin: 'node-origin', request, music }
  h.render(propsA)
  h.mount()
  await flush()
  emit({ ms: 30000, playing: true, buffering: false })
  const sessionA = { member: memberA, origin: 'node-origin', request }
  h.render(propsA)
  t.alike(covers.at(-1), ['track', item, sessionA, true], 'playback as A enables the cover')
  const propsB = { member: memberB, origin: 'node-origin', request, music }
  const sessionB = { member: memberB, origin: 'node-origin', request }
  h.render(propsB)
  t.alike(covers.at(-1), ['track', null, sessionB, false], 'switching to B asks no cover before B plays')
  h.mount()
  await flush()
  h.render(propsB)
  t.alike(covers.at(-1), ['track', item, sessionB, false], 'B stays dark until its own playback is playing')
  emit({ ms: 30000, playing: true, buffering: false })
  h.render(propsB)
  t.alike(covers.at(-1), ['track', item, sessionB, true], 'playing as B may ask')
})

test('a failed cover leaves the tile and reports nothing', async (t) => {
  const timers = new Map()
  const unavailable = []
  const covers = []
  let emit
  let starts = 0
  let serial = 0
  let timerChanges = 0
  const h = await ui({
    audiusItem: async () => ({ ...track, cover: true }),
    audiusPlay: async () => ticket,
    createStreamPlayer: () => ({
      seek: async () => {},
      play: async () => {},
      pause () {},
      release () {},
      onProgress: (fn) => { emit = fn; return () => {} },
      onError: () => () => {}
    }),
    useMusicCover: (...args) => { covers.push(args); return null },
    setTimeout: (fn, ms) => { timerChanges++; timers.set(++serial, { fn, ms }); return serial },
    clearTimeout: (id) => { timerChanges++; timers.delete(id) }
  })
  t.teardown(() => h.unmount())
  const props = { music: { id: 'abc', start: 30 }, onStart: () => { starts++ }, onUnavailable: (error) => unavailable.push(error) }
  h.render(props)
  h.mount()
  await flush()
  emit({ ms: 30000, playing: true, buffering: false })
  const before = [...timers]
  const changes = timerChanges
  for (let i = 0; i < 2; i++) {
    const tree = h.render(props)
    h.mount()
    t.is(covers.at(-1)[3], true)
    t.alike(nodes(tree).find((n) => n.type === 'MusicCover').props, { size: 36, uri: null }, 'a failed hook result keeps the generated tile')
  }
  t.is(starts, 1, 'the viewer start is unchanged')
  t.alike(unavailable, [], 'cover failure never reports unavailable')
  t.is(before.length, 1)
  t.is(before[0][1].ms, 15000)
  t.alike([...timers], before, 'cover failure preserves the playback timer')
  t.is(timerChanges, changes, 'cover rendering never resets a timer')
  t.absent(/\bfetch\b|\bURL\b|https?:\/\/|\bImage\b|\baudiusArt\b/.test(source))
})

test('mounted UI offers another gesture after a second refusal and releases on a later media failure', async (t) => {
  const { createStreamPlayer } = await import('../src/media/stream.web.js')
  const { MUSIC_UNAVAILABLE_TEXT } = await dependencies()
  const originalAudio = globalThis.Audio
  let attempts = 0
  let releases = 0
  let element
  // Keep the real stream error reporting around a local element so this also
  // catches a failure latch that survives the next gesture.
  globalThis.Audio = class {
    constructor () {
      element = this
      this.handlers = new Map()
      this.currentTime = 30
      this.readyState = 4
    }

    addEventListener (type, fn) {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set())
      this.handlers.get(type).add(fn)
    }

    removeEventListener (type, fn) { this.handlers.get(type)?.delete(fn) }
    async play () {
      if (++attempts <= 2) throw Object.assign(new Error('gesture'), { name: 'NotAllowedError' })
      for (const fn of [...this.handlers.get('error')]) fn()
    }

    pause () {}
    removeAttribute () { releases++ }
    load () {}
  }
  t.teardown(() => { globalThis.Audio = originalAudio })
  const calls = []
  const unavailable = []
  const h = await ui({
    audiusItem: async () => { calls.push('item'); return track },
    audiusPlay: async () => { calls.push('ticket'); return { ...ticket, url: ticket.base + ticket.url } },
    createStreamPlayer
  })
  t.teardown(() => h.unmount())
  const props = { music: { id: 'abc', start: 30 }, onUnavailable: (error) => unavailable.push(error) }
  const gesture = () => nodes(h.render(props)).find((n) => n.type === 'Pressable' && textOf(n).includes('Tocar música'))
  h.render(props)
  h.mount()
  await flush()
  t.ok(gesture(), 'the first refusal offers the gesture chip')
  await gesture()?.props.onPress()
  t.is(attempts, 2)
  t.ok(gesture(), 'the second refusal offers the gesture chip again')
  t.is(unavailable.length, 2, 'each refusal is reported')
  t.is(releases, 0)
  await gesture()?.props.onPress()
  t.is(attempts, 3)
  t.absent(gesture(), 'a media failure leaves the gesture phase')
  t.ok(textOf(h.render(props)).includes(MUSIC_UNAVAILABLE_TEXT), 'the unavailable error is visible')
  t.is(releases, 1)
  t.is(unavailable.length, 3)
  t.is(unavailable.at(-1), MUSIC_UNAVAILABLE_TEXT)
  t.ok([...element.handlers.values()].every((handlers) => handlers.size === 0))
  t.alike(calls, ['item', 'ticket'], 'refusals reuse the already sought player')
})

test('mounted UI sanitizes attribution, opens its URL, exposes the gesture and mutes via pause', async (t) => {
  const calls = []
  let emit, report
  let attempts = 0
  const h = await ui({
    audiusItem: async () => { calls.push('item'); return track },
    audiusPlay: async () => { calls.push('ticket'); return ticket },
    createStreamPlayer: () => ({
      seek: async () => calls.push('seek'),
      play: async () => { calls.push('play'); if (++attempts === 1) report({ code: 'play', cause: { name: 'NotAllowedError' } }) },
      pause: () => calls.push('pause'),
      release: () => calls.push('release'),
      onProgress: (fn) => { emit = fn; return () => {} },
      onError: (fn) => { report = fn; return () => {} }
    })
  })
  t.teardown(() => h.unmount())
  let starts = 0
  const opened = []
  const props = { music: { id: 'abc', start: 30 }, member: 'a'.repeat(64), onStart: () => { starts++ }, onOpenExternal: (url) => opened.push(url) }
  h.render(props)
  t.alike(calls, [], 'rendering makes no request before mount')
  h.mount()
  await flush()
  const tree = h.render(props)
  t.ok(textOf(tree).includes(displayText(track.title)))
  t.ok(textOf(tree).includes(displayText(track.artist)))
  t.ok(textOf(tree).includes('Audius'))
  t.absent(textOf(tree).includes('\u202e') || textOf(tree).includes('\u0007'))
  nodes(tree).find((n) => n.props.accessibilityRole === 'link').props.onPress()
  t.alike(opened, [track.url])
  const button = nodes(tree).find((n) => n.type === 'Pressable' && textOf(n).includes('Tocar música'))
  t.ok(button)
  const playing = button.props.onPress()
  t.is(attempts, 2, 'the tap calls play before yielding')
  await playing
  emit({ ms: 30000, playing: true, buffering: false })
  t.is(starts, 1)
  nodes(h.render(props)).find((n) => n.props.accessibilityLabel === 'Silenciar música').props.onPress()
  h.render(props)
  h.mount()
  t.is(calls.at(-1), 'pause')
  nodes(h.render(props)).find((n) => n.props.accessibilityLabel === 'Ativar música').props.onPress()
  h.render(props)
  h.mount()
  t.is(calls.at(-1), 'play')
  h.render({ ...props, paused: true })
  h.mount()
  t.is(calls.at(-1), 'pause')
  h.render({ ...props, paused: false })
  h.mount()
  t.is(calls.at(-1), 'play')
  t.is(calls.filter((c) => c === 'item').length, 1, 'pause and rerenders do not reload')
  h.unmount()
  t.is(calls.filter((c) => c === 'release').length, 1)
})

test('the sticker toggles mute and the attribution opens the page', async (t) => {
  t.is(source.split('accessibilityLabel={muteLabel}').length - 1, 1, 'one mute control stays mounted while the item loads')
  let emit
  const h = await ui({
    audiusItem: async () => track,
    audiusPlay: async () => ticket,
    createStreamPlayer: () => ({
      seek: async () => {},
      play: async () => {},
      pause: () => {},
      release: () => {},
      onProgress: (fn) => { emit = fn; return () => {} },
      onError: () => () => {}
    })
  })
  t.teardown(() => h.unmount())
  const opened = []
  const props = { music: { id: 'abc', start: 30 }, onOpenExternal: (url) => opened.push(url) }
  const waiting = h.render(props)
  const pending = nodes(waiting).find((n) => n.props.accessibilityLabel === 'Silenciar música')
  t.is(waiting.children[0], pending, 'the mute control is the first child before loading')
  t.is(pending.type, 'Pressable')
  t.is(pending.props.accessibilityHint, undefined)
  t.is(pending.props.accessibilityRole, 'button')
  t.is(pending.props.accessibilityState.selected, false)
  t.ok(nodes(pending).some((n) => n.type === 'Icon' && n.props.name === 'som'))
  t.absent(nodes(waiting).some((n) => n.props.accessibilityRole === 'link'))
  h.mount()
  await flush()
  emit({ ms: 30000, playing: true, buffering: false, ended: false })
  const tree = h.render(props)
  const sticker = nodes(tree).find((n) => n.props.accessibilityLabel === 'Silenciar música')
  t.is(tree.children[0], sticker, 'the mute control is the first child after loading')
  t.is(sticker.type, 'Pressable')
  t.is(sticker.props.accessibilityRole, 'button')
  t.is(sticker.props.accessibilityHint, displayText(track.title) + ', ' + displayText(track.artist), 'the hint carries the sanitized title and artist')
  t.is(sticker.props.accessibilityState.selected, false)
  t.ok(nodes(sticker).some((n) => n.type === 'MusicCover' && n.props.size === 36))
  t.ok(textOf(sticker).includes(displayText(track.title)))
  t.ok(textOf(sticker).includes(displayText(track.artist)))
  t.absent(textOf(sticker).includes('\u202e') || textOf(sticker).includes('\u0007'))
  const lines = nodes(sticker).filter((n) => n.type === 'Text')
  t.is(lines.length, 2)
  t.ok(lines.every((n) => n.props.numberOfLines === 1))
  t.ok(nodes(sticker).some((n) => n.type === 'MusicEqualizer' && n.props.playing === true))
  sticker.props.onPress()
  const mutedTree = h.render(props)
  const mutedSticker = nodes(mutedTree).find((n) => n.props.accessibilityLabel === 'Ativar música')
  t.ok(mutedSticker, 'pressing the sticker flips the label')
  t.is(mutedSticker.props.accessibilityState.selected, true)
  t.ok(nodes(mutedSticker).some((n) => n.type === 'Icon' && n.props.name === 'mudo' && n.props.size === 16))
  t.absent(nodes(mutedSticker).some((n) => n.type === 'MusicEqualizer'))
  const link = nodes(mutedTree).find((n) => n.props.accessibilityRole === 'link')
  t.is(link.props.accessibilityLabel, 'Abrir no Audius')
  t.ok(textOf(link).includes('Audius'))
  t.ok(nodes(link).some((n) => n.type === 'Icon' && n.props.name === 'externo'))
  t.absent(nodes(mutedSticker).includes(link))
  t.absent(nodes(link).includes(mutedSticker))
  link.props.onPress()
  t.alike(opened, [track.url])
  const after = h.render(props)
  const still = nodes(after).find((n) => n.props.accessibilityLabel === 'Ativar música')
  t.ok(still, 'opening the page does not change mute')
  t.is(still.props.accessibilityState.selected, true)
  t.absent(nodes(after).find((n) => n.props.accessibilityLabel === 'Silenciar música'))
})
