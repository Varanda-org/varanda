'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { displayText } = require('@varanda/rpc')
const source = fs.readFileSync(path.join(__dirname, '../src/ui/MusicPlayerCard.js'), 'utf8')

// Like musicPicker.test, execute the controller with account and stream
// doubles. Native media modules and the public network never load in Node.
async function helpers (stubs = {}) {
  const music = await import('../src/music.js')
  const playback = await import('../src/media/chatMedia.js')
  const deps = { ...music, ...playback, ...stubs }
  const body = source.slice(source.indexOf('export const musicPlayerIdle'), source.indexOf('export function useMusicAvailable')).replace(/\bexport /g, '')
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), body + '\nreturn { musicPlayerIdle, musicPlayerTime, createMusicPlayback }')(...Object.values(deps))
}

const track = (id = 'abc', duration = 90) => ({ id, title: 'Faixa ' + id, artist: 'Artista', duration, url: 'https://audius.co/artist/' + id })
const playlist = (tracks = [track('a'), track('b')], count = tracks.length) => ({ id: 'list', title: 'Lista', artist: 'Curador', url: 'https://audius.co/artist/playlist/list', count, tracks })
const answer = { url: '/account/audius/audio/' + 'a'.repeat(43), base: null, expiresAt: '2099-01-01T00:00:00Z' }
const flush = () => new Promise((resolve) => setImmediate(resolve))

function deferred () {
  let resolve, reject
  const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  return { promise, resolve, reject }
}

async function fixture (t, options = {}) {
  const calls = []
  const states = []
  const players = []
  const items = []
  const tickets = []
  const readyCalls = []
  const timers = new Map()
  const session = { member: 'a'.repeat(64), origin: 'node-origin', request: () => {}, enabled: true }
  const music = options.music || { kind: 'snippet', id: 'abc', start: 30 }
  let serial = 0
  const h = await helpers({
    audiusReady: async (opts) => { readyCalls.push(opts); return options.ready ? options.ready(opts) : true },
    audiusItem: async (kind, id, opts) => {
      items.push({ kind, id, opts })
      return options.item ? options.item(kind, id, opts) : (kind === 'playlist' ? playlist() : track(id))
    },
    audiusPlay: async (id, opts) => {
      tickets.push({ id, opts })
      return options.ticket ? options.ticket(id, opts) : answer
    },
    createStreamPlayer: (url, opts) => {
      calls.push(['create', url, opts])
      const listeners = new Set()
      const errors = new Set()
      const player = {
        seek: async (ms) => { calls.push(['seek', ms]); if (options.seek) await options.seek(ms, player) },
        play: async () => { calls.push(['play']); if (options.play) await options.play(player) },
        pause: () => calls.push(['pause']),
        release: () => calls.push(['release']),
        onProgress: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
        onError: (fn) => { errors.add(fn); return () => errors.delete(fn) },
        progress: (update) => { for (const fn of [...listeners]) fn(update) },
        error: (error) => { for (const fn of [...errors]) fn(error) },
        listeners,
        errors
      }
      players.push(player)
      return player
    },
    setTimeout: (fn, ms) => { timers.set(++serial, { fn, ms }); return serial },
    clearTimeout: (id) => timers.delete(id)
  })
  const playback = h.createMusicPlayback({ ...session, ...options.session }, music, (state) => states.push(state))
  t.teardown(() => playback.release())
  return { playback, calls, states, players, items, tickets, readyCalls, timers, session }
}

// Render the real JSX with lightweight host elements and hook storage; imports
// are stubbed, including stream, rather than importing expo-audio in Node.
async function ui (stubs = {}) {
  const { transformSync } = require('@babel/core')
  const music = await import('../src/music.js')
  const media = await import('../src/media/chatMedia.js')
  const slots = []
  const effects = []
  let cursor = 0
  const hooks = {
    useState: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = initial
      return [slots[at], (next) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next }]
    },
    useRef: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = { current: initial }
      return slots[at]
    },
    useEffect: (fn) => effects.push(fn),
    useMemo: (fn) => fn()
  }
  const deps = {
    ...music,
    ...media,
    ...hooks,
    displayText,
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) },
    Platform: { OS: 'web' },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    LinkCard: 'LinkCard',
    MusicCover: 'MusicCover',
    Icon: 'Icon',
    ActivityIndicator: 'ActivityIndicator',
    useTheme: () => ({ colors: { accent: 'accent', accentInk: 'accentInk', bg: 'bg', soft: 'soft' } }),
    tap: () => {},
    StyleSheet: { create: (value) => value, hairlineWidth: 1 },
    useStyles: (makeStyles) => makeStyles({ accent: 'accent', accentInk: 'accentInk', bg: 'bg', soft: 'soft' }),
    layout: { hit: 44 },
    radius: { sm: 8 },
    space: {},
    ...stubs
  }
  const input = source.replace(/^import .+\n/gm, '').replace(/\bexport /g, '')
  const { code } = transformSync(input, { configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-react-jsx'] })
  // eslint-disable-next-line no-new-func
  const components = new Function(...Object.keys(deps), code + '\nreturn { MusicPlayerCard, MusicPlayerEntry, ActiveMusicPlayer, MusicCardView, MusicProgress, MusicButton, useMusicAvailable }')(...Object.values(deps))
  return { ...components, effects, reset: () => { cursor = 0 }, clear: () => { cursor = 0; slots.length = 0; effects.length = 0 } }
}

function flatten (node) {
  if (!node || typeof node !== 'object') return []
  return [node, ...node.children.flatMap(flatten)]
}

function textOf (node) {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return node.children.map(textOf).join(' ')
}

test('idle cards use stored safe text, make no requests and mount the node reader only on tap', async (t) => {
  const calls = []
  const unexpected = () => { calls.push('request'); throw new Error('idle request') }
  const opened = []
  const h = await ui({ useHosted: () => true, useNode: unexpected, audiusReady: unexpected, audiusItem: unexpected, audiusPlay: unexpected, createStreamPlayer: unexpected, openExternal: (url) => opened.push(url) })
  const card = { title: 'Título\u202e', desc: 'Artista\u0007', url: track().url + '#varanda-musica=s:abc:30' }
  const music = { kind: 'snippet', id: 'abc', start: 30 }
  const props = { card, music }
  const entry = h.MusicPlayerCard(props)
  t.is(entry.type, h.MusicPlayerEntry)
  t.is(entry.props.key, card.url, 'a changed card discards the old tap')
  const idle = h.MusicPlayerEntry(entry.props)
  t.is(idle.type, h.MusicCardView)
  const view = h.MusicCardView(idle.props)
  t.ok(textOf(view).includes(displayText(card.title)))
  t.ok(textOf(view).includes(displayText(card.desc)))
  t.absent(textOf(view).includes('\u202e'))
  t.ok(textOf(view).includes('Audius'))
  t.ok(flatten(view).some((n) => n.props.label === 'Ouvir trecho'))
  t.alike(calls, [])
  t.alike(h.effects, [], 'no idle policy effect')
  flatten(view).find((n) => n.props.accessibilityRole === 'link').props.onPress()
  t.alike(opened, [card.url])
  idle.props.onPress()
  h.reset()
  const active = h.MusicPlayerEntry(entry.props)
  t.is(active.type, h.ActiveMusicPlayer)
  t.is(active.props.epoch, (await import('../src/media/chatMedia.js')).playbackEpoch())
  t.alike(calls, [], 'the tap mounts the reader before any node access')
})

test('a snippet card shows the 15 s badge and a track card does not', async (t) => {
  const { SNIPPET_BADGE } = await import('../src/music.js')
  const h = await ui()
  for (const kind of ['snippet', 'track', 'playlist']) {
    h.clear()
    const tree = h.MusicCardView({ card: { title: 'Faixa', desc: 'Artista' }, music: { kind, start: 0 } })
    const badge = flatten(tree).find((n) => n.type === 'Text' && textOf(n) === SNIPPET_BADGE)
    t.is(!!badge, kind === 'snippet', kind)
    if (badge) {
      t.is(badge.props.style.borderRadius, 8)
      t.is(badge.props.style.backgroundColor, 'bg')
      t.is(badge.props.style.color, 'soft')
    }
  }
})

test('the badge shows the real window on a short track', async (t) => {
  const { musicPlayerIdle } = await helpers()
  const { SNIPPET_BADGE } = await import('../src/music.js')
  const h = await ui()
  const idle = h.MusicCardView({ card: { title: 'Faixa', desc: 'Artista' }, music: { kind: 'snippet', start: 30 } })
  t.is(textOf(flatten(idle).find((n) => n.type === 'Text' && n.props.style && n.props.style.backgroundColor === 'bg')), SNIPPET_BADGE)
  h.clear()
  const tree = h.MusicCardView({ card: {}, music: { kind: 'snippet', start: 0 }, state: { ...musicPlayerIdle, item: track('abc', 7) } })
  const badge = flatten(tree).find((n) => n.type === 'Text' && n.props.style && n.props.style.backgroundColor === 'bg')
  t.is(textOf(badge), '7 s')
})

test('the round button keeps every accessible name', async (t) => {
  const { musicPlayerIdle } = await helpers()
  const calls = []
  const h = await ui({ tap: (kind) => calls.push(kind) })
  for (const [kind, phase, error, label, icon] of [
    ['track', 'loading', '', 'Cancelar', null],
    ['snippet', 'playing', '', 'Parar trecho', 'parar'],
    ['track', 'playing', '', 'Pausar', 'pausar'],
    ['playlist', 'playing', '', 'Pausar', 'pausar'],
    ['track', 'idle', 'Falhou', 'Tentar de novo', 'tocar'],
    ['snippet', 'idle', '', 'Ouvir trecho', 'tocar'],
    ['playlist', 'idle', '', 'Ouvir playlist', 'tocar'],
    ['track', 'idle', '', 'Ouvir', 'tocar'],
    ['track', 'paused', '', 'Ouvir', 'tocar']
  ]) {
    h.clear()
    const tree = h.MusicCardView({ card: {}, music: { kind, start: 0 }, state: { ...musicPlayerIdle, phase, error }, onPress: () => calls.push('press') })
    const main = flatten(tree).find((n) => n.type === h.MusicButton && n.props.round)
    t.is(main.props.label, label)
    const button = h.MusicButton(main.props)
    t.is(button.props.accessibilityLabel, label)
    t.is(button.props.accessibilityRole, 'button')
    const circle = button.props.style.find((style) => style?.width === 44)
    t.is(circle.height, 44)
    t.is(circle.borderRadius, 22)
    t.is(circle.backgroundColor, 'accent')
    const glyph = button.children[0]
    t.is(glyph.type, phase === 'loading' ? 'ActivityIndicator' : 'Icon')
    if (icon) t.is(glyph.props.name, icon)
    t.is(glyph.props.color, 'accentInk')
    calls.length = 0
    button.props.onPress()
    t.alike(calls, ['select', 'press'])
    if (error) t.is(flatten(tree).find((n) => textOf(n) === error).props.accessibilityLiveRegion, 'polite')
  }
  h.clear()
  const playlistTree = h.MusicCardView({ card: {}, music: { kind: 'playlist' }, state: { ...musicPlayerIdle, item: playlist() } })
  for (const label of ['Anterior', 'Próxima']) {
    const control = flatten(playlistTree).find((n) => n.type === h.MusicButton && n.props.label === label)
    const button = h.MusicButton(control.props)
    t.is(button.props.style.find((style) => style && style.minWidth === 44).minWidth, 44, label)
  }
  const show = h.MusicButton(flatten(playlistTree).find((n) => n.props.label === 'Mostrar faixas').props)
  t.absent(show.props.style.some((style) => style && style.minWidth === 44))
})

test('the idle card still names Audius and draws no cover request', async (t) => {
  const calls = []
  const unexpected = () => { calls.push('request'); throw new Error('idle request') }
  const h = await ui({ useNode: unexpected, audiusReady: unexpected, audiusItem: unexpected, audiusPlay: unexpected, createStreamPlayer: unexpected })
  const card = { title: 'Título\u202e', desc: 'Artista\u0007' }
  const tree = h.MusicCardView({ card, music: { kind: 'track' } })
  const row = tree.children[0]
  t.is(row.props.style.flexDirection, 'row')
  t.is(row.children[0].type, 'MusicCover')
  t.alike(row.children[0].props, { size: 56 })
  const title = row.children[1]
  t.is(title.children[0].props.numberOfLines, 1)
  t.is(title.children[0].props.style.fontWeight, '700')
  t.is(title.children[1].props.numberOfLines, 1)
  t.is(textOf(title.children[0]), displayText(card.title))
  t.is(textOf(title.children[1]), displayText(card.desc))
  t.ok(textOf(title).includes('Audius'))
  t.absent(flatten(tree).some((n) => n.type === h.MusicProgress))
  const link = flatten(tree).find((n) => n.props.accessibilityRole === 'link')
  t.is(link.props.style.minHeight, 44)
  t.is(link.children[0].props.name, 'externo')
  t.is(link.children[0].props.size, 14)
  t.is(link.children[1].props.style.fontSize, 13)
  t.alike(calls, [])
  t.alike(h.effects, [])
})

test('unhosted cards fall back unchanged and pending availability is scoped to the member', async (t) => {
  const ready = deferred()
  const calls = []
  const h = await ui({ useHosted: () => false, audiusReady: (opts) => { calls.push(opts); return ready.promise } })
  const card = { title: 'Faixa', url: track().url }
  const rendered = h.MusicPlayerCard({ card, music: { kind: 'track' } })
  t.is(rendered.type, 'LinkCard')
  t.is(rendered.props.card, card)
  t.alike(calls, [])
  h.clear()
  t.is(h.useMusicAvailable({ hosted: true, accountOrigin: 'account-origin' }, 'member'), null)
  const cleanup = h.effects[0]()
  ready.resolve(true)
  await flush()
  h.reset()
  t.is(h.useMusicAvailable({ hosted: true, accountOrigin: 'account-origin' }, 'member'), true)
  h.reset()
  t.is(h.useMusicAvailable({ hosted: true, accountOrigin: 'account-origin' }, 'another'), null)
  h.reset()
  t.is(h.useMusicAvailable({ hosted: false }, 'member'), false)
  t.alike(calls, [{ member: 'member', origin: 'account-origin' }])
  cleanup()
})

async function availability () {
  const calls = []
  let previousDeps
  let cleanup
  let effect
  const h = await ui({
    audiusReady: (opts) => {
      const answer = deferred()
      calls.push({ opts, ...answer })
      return answer.promise
    },
    useEffect: (fn, deps) => {
      if (previousDeps && deps.every((value, i) => Object.is(value, previousDeps[i]))) return
      previousDeps = deps
      effect = fn
    }
  })
  return {
    calls,
    render: (refreshKey, member = 'member', origin = 'account-origin') => {
      h.reset()
      const value = h.useMusicAvailable({ hosted: true, accountOrigin: origin }, member, refreshKey)
      if (effect) {
        if (cleanup) cleanup()
        cleanup = effect()
        effect = null
      }
      return value
    },
    close: () => { if (cleanup) cleanup() }
  }
}

test('availability without an installation origin is false and never probes', async (t) => {
  const calls = []
  const h = await ui({ audiusReady: async (opts) => { calls.push(opts); return true } })
  t.is(h.useMusicAvailable({ hosted: false }, 'member'), false)
  const cleanup = h.effects[0]()
  await flush()
  h.reset()
  t.is(h.useMusicAvailable({ hosted: false }, 'member'), false)
  t.alike(calls, [])
  cleanup()
})

test('a rejected availability probe settles unknown to false', async (t) => {
  const h = await availability()
  t.is(h.render(false), null)
  h.calls[0].reject(new Error('offline'))
  await flush()
  t.is(h.render(false), false, 'a failed probe allows ordinary Audius links')
  h.close()
})

test('availability refresh recovers from false or a transient failure', async (t) => {
  for (const failed of [false, true]) {
    const h = await availability()
    t.is(h.render(false), null, 'the first probe has no answer yet')
    t.is(h.render(false), null, 'a pending probe stays unknown')
    if (failed) h.calls[0].reject(new Error('offline'))
    else h.calls[0].resolve(false)
    await flush()
    t.is(h.render(false), false)
    t.is(h.calls.length, 1, 'the same refresh key does not probe again')
    t.is(h.render(true), false)
    t.is(h.render(true), false, 'the last false survives the refresh effect')
    t.is(h.calls.length, 2, 'opening probes again')
    if (h.calls[1]) h.calls[1].resolve(true)
    await flush()
    t.is(h.render(true), true)
    h.close()
  }
})

test('availability keeps true during refresh and resets for a different member or origin', async (t) => {
  const h = await availability()
  h.render(false)
  h.calls[0].resolve(true)
  await flush()
  t.is(h.render(false), true)
  t.is(h.render(true), true)
  t.is(h.render(true), true, 'the previous true survives the refresh effect')
  t.is(h.calls.length, 2)
  if (h.calls[1]) h.calls[1].resolve(false)
  await flush()
  t.is(h.render(true), false, 'the new answer replaces the previous answer')
  h.render(false)
  if (h.calls[2]) h.calls[2].resolve(true)
  await flush()
  t.is(h.render(false), true)
  t.is(h.render(false, 'another'), null)
  t.is(h.render(false, 'member'), null, 'changing back cannot revive the old result')
  h.calls.at(-1).resolve(true)
  await flush()
  t.is(h.render(false), true)
  t.is(h.render(false, 'member', 'another-origin'), null)
  t.is(h.render(false), null, 'changing origin back cannot revive the old result')
  h.close()
})

test('availability without a refresh key still probes once per member and origin', async (t) => {
  const h = await availability()
  h.render()
  h.calls[0].resolve(true)
  await flush()
  t.is(h.render(), true)
  t.is(h.render(), true)
  t.is(h.calls.length, 1)
  t.is(h.render(undefined, 'another'), null)
  t.is(h.calls.length, 2)
  h.calls[1].resolve(true)
  await flush()
  t.is(h.render(undefined, 'another'), true)
  h.close()
})

test('the tap reads the own lowercase key and unmount aborts the active request', async (t) => {
  const item = deferred()
  const calls = []
  let options
  const h = await ui({
    useNode: () => ({ hosted: true, accountOrigin: 'account-origin', request: 'signer', passkey: { status: { publicKey: 'AB'.repeat(32) } } }),
    audiusReady: async () => true,
    audiusItem: async (kind, id, opts) => { options = opts; calls.push([kind, id]); return item.promise },
    audiusPlay: () => calls.push('ticket')
  })
  const card = { title: 'Stored', desc: 'Peer', url: track().url }
  h.ActiveMusicPlayer({ card, music: { kind: 'track', id: 'abc' }, epoch: (await import('../src/media/chatMedia.js')).playbackEpoch() })
  const unmount = h.effects[0]()
  await flush()
  t.is(options.member, 'ab'.repeat(32))
  t.is(options.origin, 'account-origin')
  t.is(options.request, 'signer')
  unmount()
  t.ok(options.signal.aborted)
  item.resolve(track())
  await flush()
  t.alike(calls, [['track', 'abc']])
})

test('the controller makes no request until press and checks readiness before the item', async (t) => {
  const ready = deferred()
  const f = await fixture(t, { ready: () => ready.promise })
  t.alike(f.readyCalls, [])
  const running = f.playback.press()
  t.is(f.readyCalls.length, 1)
  t.alike(f.items, [])
  ready.resolve(false)
  await running
  t.ok(f.states.at(-1).fallback)
  t.alike(f.items, [])
  t.alike(f.tickets, [])
  t.alike(f.calls, [])
})

test('a nonzero snippet awaits confirmed seek and uses the ticket base', async (t) => {
  const seek = deferred()
  const entered = deferred()
  const base = 'https://account.example'
  const f = await fixture(t, { ticket: () => ({ ...answer, base, url: base + answer.url }), seek: () => { entered.resolve(); return seek.promise } })
  const running = f.playback.press()
  await entered.promise
  t.alike(f.calls, [['create', base + answer.url, { origin: base }], ['seek', 30000]])
  t.alike(f.items.map(({ kind, id }) => ({ kind, id })), [{ kind: 'track', id: 'abc' }])
  t.is(f.states.at(-1).item.title, 'Faixa abc', 'authoritative item replaces stored text')
  seek.resolve()
  await running
  t.ok(f.calls.some((c) => c[0] === 'play'))
  t.is(f.states.at(-1).phase, 'playing')
  t.ok(f.tickets[0].opts.signal instanceof AbortSignal)
  t.is(f.tickets[0].opts.request, f.session.request)
})

test('a zero progress sample during seek does not override its confirmed target', async (t) => {
  const seek = deferred()
  const entered = deferred()
  const f = await fixture(t, { seek: () => { entered.resolve(); return seek.promise } })
  const running = f.playback.press()
  await entered.promise
  f.players[0].progress({ ms: 0, playing: false })
  t.absent(f.calls.some((c) => c[0] === 'play'))
  seek.resolve()
  await running
  t.alike(f.calls.filter((c) => c[0] === 'seek'), [['seek', 30000]])
  t.ok(f.calls.some((c) => c[0] === 'play'))
  t.is(f.states.at(-1).phase, 'playing')
  t.is(f.states.at(-1).ms, 30000)
  f.players[0].progress({ ms: 30000, playing: true })
  t.alike([...f.timers.values()].map((timer) => timer.ms), [15000])
})

test('rejected and out-of-range snippets never play from zero', async (t) => {
  const { MUSIC_SEEK_TEXT } = await import('../src/music.js')
  for (const seek of [() => { throw new Error('seek') }, () => { throw Object.assign(new Error(), { code: 'seek-range' }) }]) {
    const f = await fixture(t, { seek })
    await f.playback.press()
    t.absent(f.calls.some((c) => c[0] === 'play'))
    t.is(f.states.at(-1).error, MUSIC_SEEK_TEXT)
    t.ok(f.calls.some((c) => c[0] === 'release'))
  }
  const f = await fixture(t, { music: { kind: 'snippet', id: 'abc', start: 7200 } })
  await f.playback.press()
  t.alike(f.tickets, [])
  t.is(f.states.at(-1).error, MUSIC_SEEK_TEXT)
})

test('superseded and released seeks stop silently', async (t) => {
  for (const code of ['superseded', 'released']) {
    const f = await fixture(t, { seek: () => { throw Object.assign(new Error(), { code }) } })
    await f.playback.press()
    t.is(f.states.at(-1).error, '')
    t.is(f.states.at(-1).phase, 'idle')
    t.absent(f.calls.some((c) => c[0] === 'play'))
  }
})

test('snippet progress stops at fifteen seconds and short tracks end early', async (t) => {
  for (const [duration, start, end] of [[90, 30, 45000], [7, 0, 7000]]) {
    const f = await fixture(t, { music: { kind: 'snippet', id: 'abc', start }, item: () => track('abc', duration) })
    await f.playback.press()
    f.players[0].progress({ ms: end, playing: true })
    t.is(f.states.at(-1).phase, 'idle')
    t.ok(f.calls.some((c) => c[0] === 'release'))
    await f.playback.press()
    t.is(f.tickets.length, 1, 'explicit replay reuses a valid ticket')
    t.is(f.calls.filter((c) => c[0] === 'play').length, 2)
  }
})

test('buffering clears the snippet timer and a final timer stops between progress events', async (t) => {
  const f = await fixture(t)
  await f.playback.press()
  f.players[0].progress({ ms: 32000, playing: true, buffering: false })
  t.is([...f.timers.values()][0].ms, 13000)
  f.players[0].progress({ ms: 33000, playing: true, buffering: true })
  t.is(f.timers.size, 0)
  f.players[0].progress({ ms: 44000, playing: true, buffering: false })
  const timer = [...f.timers.values()][0]
  t.is(timer.ms, 1000)
  timer.fn()
  t.is(f.timers.size, 0)
  t.is(f.states.at(-1).phase, 'idle')
  t.is(f.states.at(-1).ms, 45000)
})

test('every pending stage is invalidated when bound playback stops', async (t) => {
  const { stopBoundPlayback } = await import('../src/media/chatMedia.js')
  for (const stage of ['ready', 'item', 'ticket', 'seek', 'play']) {
    const wait = deferred()
    const entered = deferred()
    const f = await fixture(t, { [stage]: () => { entered.resolve(); return wait.promise } })
    const running = f.playback.press()
    await entered.promise
    stopBoundPlayback()
    const updates = f.states.length
    wait.resolve(stage === 'ready' ? true : stage === 'item' ? track() : stage === 'ticket' ? answer : undefined)
    await running
    t.is(f.states.length, updates, stage + ': late result has no UI update')
    t.is(f.calls.filter((c) => c[0] === 'play').length, stage === 'play' ? 1 : 0, stage + ': no later playback')
    t.ok(f.readyCalls[0].signal.aborted, stage + ': aborts requests')
    if (f.players.length) t.ok(f.calls.some((c) => c[0] === 'release'), stage + ': releases player')
  }
})

test('a tap epoch invalidated before mounting does nothing', async (t) => {
  const { playbackEpoch, stopBoundPlayback } = await import('../src/media/chatMedia.js')
  const epoch = playbackEpoch()
  const f = await fixture(t)
  stopBoundPlayback()
  await f.playback.press(epoch)
  t.alike(f.readyCalls, [])
  t.alike(f.calls, [])
})

test('taking a pending claim cancels it without changing the screen epoch', async (t) => {
  const { claimPlayback } = await import('../src/media/chatMedia.js')
  const ticket = deferred()
  const entered = deferred()
  const f = await fixture(t, { ticket: () => { entered.resolve(); return ticket.promise } })
  const running = f.playback.press()
  await entered.promise
  const releaseOther = claimPlayback({ pause () {} })
  ticket.resolve(answer)
  await running
  t.alike(f.calls, [])
  t.ok(f.tickets[0].opts.signal.aborted)
  releaseOther()
})

test('taking an active claim releases subscriptions and stops the snippet timer', async (t) => {
  const { claimPlayback } = await import('../src/media/chatMedia.js')
  const f = await fixture(t)
  await f.playback.press()
  f.players[0].progress({ ms: 31000, playing: true })
  const releaseOther = claimPlayback({ pause () {} })
  t.is(f.players[0].listeners.size, 0)
  t.is(f.players[0].errors.size, 0)
  t.is(f.timers.size, 0)
  t.ok(f.calls.some((c) => c[0] === 'release'))
  t.is(f.states.at(-1).phase, 'idle')
  releaseOther()
})

test('unmount and cancel abort a ticket and never let it restart', async (t) => {
  for (const unmount of [true, false]) {
    const ticket = deferred()
    const entered = deferred()
    const f = await fixture(t, { ticket: () => { entered.resolve(); return ticket.promise } })
    const running = f.playback.press()
    await entered.promise
    if (unmount) f.playback.release()
    else await f.playback.press()
    const updates = f.states.length
    ticket.resolve(answer)
    await running
    t.alike(f.calls, [])
    t.ok(f.tickets[0].opts.signal.aborted)
    t.is(f.states.length, updates)
  }
})

test('an old seek cannot release or play a newer attempt', async (t) => {
  const seek = deferred()
  const entered = deferred()
  let count = 0
  const f = await fixture(t, { seek: () => { if (++count === 1) { entered.resolve(); return seek.promise } } })
  const old = f.playback.press()
  await entered.promise
  await f.playback.press()
  await f.playback.press()
  const calls = f.calls.length
  seek.resolve()
  await old
  t.is(f.calls.length, calls)
  t.is(f.players[1].listeners.size, 1)
  t.is(f.states.at(-1).phase, 'playing')
})

test('a track pauses and resumes without a new ticket and scrubs only on an explicit action', async (t) => {
  const f = await fixture(t, { music: { kind: 'track', id: 'abc', start: null } })
  await f.playback.press()
  f.players[0].progress({ ms: 12000, playing: true })
  await f.playback.press()
  t.is(f.states.at(-1).phase, 'paused')
  await f.playback.pressSeek(42000)
  t.alike(f.calls.filter((c) => c[0] === 'seek'), [['seek', 42000]])
  t.is(f.calls.filter((c) => c[0] === 'play').length, 1, 'scrubbing a paused track stays paused')
  await f.playback.press()
  t.is(f.tickets.length, 1)
  t.is(f.calls.filter((c) => c[0] === 'play').length, 2)
  await f.playback.pressSeek(50000)
  t.is(f.states.at(-1).ms, 50000)
  t.is(f.calls.filter((c) => c[0] === 'play').length, 3)
})

test('expiry has no timer or automatic retry and renews only on a play tap', async (t) => {
  const f = await fixture(t, { music: { kind: 'track', id: 'abc' }, ticket: () => ({ ...answer, expiresAt: '2000-01-01T00:00:00Z' }) })
  await f.playback.press()
  f.players[0].progress({ ms: 12000, playing: true })
  t.is(f.timers.size, 0)
  t.is(f.tickets.length, 1)
  await f.playback.press()
  t.is(f.tickets.length, 1, 'pause does not renew')
  await f.playback.press()
  t.is(f.tickets.length, 2)
  t.alike(f.calls.filter((c) => c[0] === 'seek'), [['seek', 12000]], 'resume keeps the position')
})

test('playlist ended advances once, each track gets a ticket, and the last track stops', async (t) => {
  const f = await fixture(t, { music: { kind: 'playlist', id: 'list' } })
  await f.playback.press()
  f.players[0].progress({ ms: 90000, ended: true })
  f.players[0].progress({ ms: 90000, ended: true })
  await flush()
  t.alike(f.tickets.map((c) => c.id), ['a', 'b'])
  t.is(f.states.at(-1).queue.index, 1)
  f.players[1].progress({ ms: 90000, ended: true })
  await flush()
  t.ok(f.states.at(-1).queue.done)
  t.is(f.states.at(-1).phase, 'idle')
  t.is(f.tickets.length, 2)
  await f.playback.press()
  t.alike(f.tickets.map((c) => c.id), ['a', 'b', 'a'], 'explicit replay starts the playlist again')
})

test('playlist previous and next honor the queue edges', async (t) => {
  const f = await fixture(t, { music: { kind: 'playlist', id: 'list' } })
  await f.playback.press()
  await f.playback.pressStep('prev')
  t.is(f.tickets.length, 1)
  await f.playback.pressStep('next')
  t.is(f.states.at(-1).queue.index, 1)
  await f.playback.pressStep('next')
  t.is(f.tickets.length, 2)
  await f.playback.pressStep('prev')
  t.alike(f.tickets.map((c) => c.id), ['a', 'b', 'a'])
})

test('a failed queue track stops and retries only when pressed', async (t) => {
  let fail = true
  const f = await fixture(t, { music: { kind: 'playlist', id: 'list' }, ticket: (id) => { if (id === 'b' && fail) throw new Error('unavailable'); return answer } })
  await f.playback.press()
  f.players[0].progress({ ms: 90000, ended: true })
  await flush()
  t.is(f.states.at(-1).queue.index, 1)
  t.is(f.states.at(-1).phase, 'idle')
  t.ok(f.states.at(-1).error)
  t.is(f.tickets.length, 2)
  fail = false
  await f.playback.press()
  t.alike(f.tickets.map((c) => c.id), ['a', 'b', 'b'])
  t.is(f.states.at(-1).phase, 'playing')
})

test('service and stream failures use fixed texts, report once and never reconnect', async (t) => {
  const { MUSIC_LIMIT_TEXT, MUSIC_UNAVAILABLE_TEXT } = await import('../src/music.js')
  for (const code of ['limite-musica', 'nao-encontrado', 'indisponivel', 'feature-off', 'nao-autorizado']) {
    const f = await fixture(t, { item: () => { throw Object.assign(new Error('provider text'), { code }) } })
    await f.playback.press()
    t.is(f.states.at(-1).error, code === 'limite-musica' ? MUSIC_LIMIT_TEXT : MUSIC_UNAVAILABLE_TEXT)
    t.is(f.items.length, 1, 'no session retry outside account.js')
    t.is(f.tickets.length, 0)
  }
  for (const code of ['media', 'load-timeout', 'stall']) {
    const f = await fixture(t)
    await f.playback.press()
    f.players[0].error({ code })
    const updates = f.states.length
    f.players[0].error({ code })
    t.is(f.states.length, updates)
    t.is(f.states.at(-1).error, MUSIC_UNAVAILABLE_TEXT)
    t.is(f.tickets.length, 1)
    await f.playback.press()
    t.is(f.tickets.length, 2)
  }
})

test('playlist UI safely shows authoritative text and a collapsed capped list with the partial note', async (t) => {
  const { queueStep, queueIdle, musicPartialText, MUSIC_FULL_LIST_TEXT } = await import('../src/music.js')
  const h = await ui()
  const item = playlist(Array.from({ length: 50 }, (_, i) => track('t' + i)), 60)
  item.title = 'Lista\u202e'
  item.artist = 'Autor\u0007'
  item.tracks[0].title = 'Música\u202e'
  item.tracks[0].artist = 'Artista\u0007'
  const queue = queueStep(queueIdle, { type: 'load', tracks: [...item.tracks, track('extra')] })
  const props = { card: { title: 'Peer', desc: 'Peer artist' }, music: { kind: 'playlist' }, state: { item, queue, phase: 'playing', ms: 0, error: '' } }
  const tree = h.MusicCardView(props)
  const text = textOf(tree)
  for (const value of [item.title, item.artist, item.tracks[0].title, item.tracks[0].artist]) t.ok(text.includes(displayText(value)))
  t.absent(text.includes('Peer'))
  t.ok(text.includes(musicPartialText(item)))
  t.ok(text.includes(MUSIC_FULL_LIST_TEXT))
  t.absent(text.includes('Faixa t49'), 'list starts collapsed')
  flatten(tree).find((n) => n.props.label === 'Mostrar faixas').props.onPress()
  h.reset()
  const expanded = textOf(h.MusicCardView(props))
  t.ok(expanded.includes('Faixa t49'))
  t.absent(expanded.includes('Faixa extra'))
  t.absent(expanded.includes('\u202e'))
})

test('progress slider exposes web values and keyboard steps while retaining native actions', async (t) => {
  for (const os of ['android', 'ios', 'web']) {
    const h = await ui({ Platform: { OS: os } })
    let ms = 42000
    const render = (onSeek = (value) => { ms = value }) => {
      h.reset()
      return flatten(h.MusicProgress({ ms, durationMs: 190000, onSeek })).find((n) => n.props.accessibilityLabel === 'Progresso da música').props
    }
    let slider = render()
    t.is(slider['aria-valuemin'], 0)
    t.is(slider['aria-valuemax'], 190000)
    t.is(slider['aria-valuenow'], 42000)
    t.is(slider['aria-valuetext'], '0:42 de 3:10')
    slider.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } })
    t.is(ms, 47000)
    if (os !== 'web') {
      t.is(slider.tabIndex, undefined)
      t.is(slider.onKeyDown, undefined)
      continue
    }
    t.is(slider.tabIndex, 0)
    t.is(typeof slider.onKeyDown, 'function')
    for (const [key, expected] of [['ArrowLeft', 42000], ['ArrowDown', 37000], ['ArrowRight', 42000], ['ArrowUp', 47000], ['Home', 0], ['ArrowLeft', 0], ['End', 190000], ['ArrowRight', 190000]]) {
      slider = render()
      let prevented = false
      slider.onKeyDown?.({ key, preventDefault: () => { prevented = true }, stopPropagation () {} })
      t.is(ms, expected, key)
      t.ok(prevented, key + ' prevents page scroll')
      t.is(render()['aria-valuenow'], expected)
    }
    let prevented = false
    render().onKeyDown?.({ key: 'Tab', preventDefault: () => { prevented = true } })
    t.absent(prevented, 'unhandled keys keep their default')
    slider = render(null)
    t.is(slider.accessibilityRole, 'progressbar')
    t.is(slider.tabIndex, undefined, 'a snippet is not a tab stop')
    t.is(slider.onKeyDown, undefined)
  }
})

test('a pending keyboard seek keeps the web slider focusable without starting another seek', async (t) => {
  const seek = deferred()
  const music = { kind: 'track', id: 'abc' }
  const f = await fixture(t, { music, seek: () => seek.promise })
  const h = await ui()
  const pending = []
  const onSeek = (ms) => { pending.push(f.playback.pressSeek(ms)) }
  const render = () => {
    h.reset()
    const tree = h.MusicCardView({ card: {}, music, state: f.states.at(-1), onSeek })
    const progress = flatten(tree).find((n) => n.type === h.MusicProgress)
    return flatten(h.MusicProgress(progress.props)).find((n) => n.props.accessibilityLabel === 'Progresso da música').props
  }
  const key = { key: 'ArrowRight', preventDefault () {}, stopPropagation () {} }
  await f.playback.press()
  render().onKeyDown(key)
  t.is(f.states.at(-1).phase, 'loading')
  const slider = render()
  t.is(slider.accessibilityRole, 'adjustable', 'loading keeps the slider role')
  t.is(slider.tabIndex, 0, 'loading keeps the slider in the tab order')
  t.is(typeof slider.onKeyDown, 'function', 'loading keeps keyboard handling')
  slider.onKeyDown?.(key)
  t.is(pending.length, 2, 'the loading key press reaches the controller')
  t.alike(f.calls.filter((c) => c[0] === 'seek'), [['seek', 5000]], 'the controller ignores the second seek')
  t.is(f.states.at(-1).ms, 5000, 'the pending target stays unchanged')
  seek.resolve()
  await Promise.all(pending)
  t.is(f.states.at(-1).phase, 'playing')
  t.is(render()['aria-valuenow'], 5000)
})

test('short snippet progress uses the actual track end', async (t) => {
  const { musicPlayerIdle } = await helpers()
  const h = await ui()
  for (const [duration, start, end, length] of [[7, 0, 7000, 7000], [90, 30, 45000, 15000]]) {
    h.clear()
    const tree = h.MusicCardView({ card: {}, music: { kind: 'snippet', start }, state: { ...musicPlayerIdle, item: track('abc', duration), ms: end } })
    const progress = flatten(tree).find((n) => n.type === h.MusicProgress)
    t.is(progress.props.durationMs, length)
    h.clear()
    const rendered = h.MusicProgress(progress.props)
    t.ok(textOf(rendered).includes(duration === 7 ? '0:07 / 0:07' : '0:15 / 0:15'))
    t.ok(flatten(rendered).some((n) => n.props.style?.some?.((style) => style?.width === '100%')))
  }
})

test('the title is interactive only when it has a long press action', async (t) => {
  const h = await ui()
  const props = { card: { title: 'Faixa', desc: 'Artista' }, music: { kind: 'track' } }
  for (const onLongPress of [undefined, null, false]) {
    h.clear()
    const title = h.MusicCardView({ ...props, onLongPress }).children[0].children[1]
    t.is(title.type, 'View')
    t.is(title.props.onLongPress, undefined)
    t.is(title.props.delayLongPress, undefined)
  }
  let calls = 0
  h.clear()
  const title = h.MusicCardView({ ...props, onLongPress: () => { calls++ } }).children[0].children[1]
  t.is(title.type, 'Pressable')
  t.is(title.props.delayLongPress, 350)
  title.props.onLongPress()
  t.is(calls, 1)
})

test('the playlist toggle announces its expanded state on the web', async (t) => {
  const { musicPlayerIdle } = await helpers()
  const h = await ui()
  const props = { card: {}, music: { kind: 'playlist' }, state: { ...musicPlayerIdle, item: playlist() } }
  const toggle = () => {
    h.reset()
    const node = flatten(h.MusicCardView(props)).find((n) => n.props.label === 'Mostrar faixas' || n.props.label === 'Ocultar faixas')
    return h.MusicButton(node.props)
  }
  const collapsed = toggle()
  t.is(collapsed.props['aria-expanded'], false)
  collapsed.props.onPress()
  const expanded = toggle()
  t.is(expanded.props['aria-expanded'], true)
  expanded.props.onPress()
  t.is(toggle().props['aria-expanded'], false)
})

test('shared player source keeps IO behind the tap and all provider text escaped', (t) => {
  t.absent(/\bfetch\s*\(|https?:\/\/|Platform\.OS|\bImage\b|globalThis\.|\bdocument\.|\bwindow\.|iframe|WebView|EmbedFrame/.test(source.replace("const WEB = Platform.OS === 'web'", '')))
  t.absent(source.includes('\u2014'))
  for (const value of ['card.title', 'card.desc', 'item.title', 'item.artist', 'track.title', 'track.artist', 'entry.title']) t.ok(source.includes('displayText(' + value + ')'), value)
  t.ok(source.includes("from '../media/stream'"))
  t.ok(source.includes('createStreamPlayer(url, { origin: base })'))
  t.ok(source.includes('claimPlayback(player, { bound: true, epoch })'))
  t.ok(source.includes('return () => playback.release()'))
  t.ok(source.includes('job.player.pause(); job.player.release()'))
  t.ok(source.includes('signal: job.controller.signal'))
  t.ok(source.includes('job.controller.abort()'))
  t.is([...source.matchAll(/useNode\(\)/g)].length, 1)
  t.ok(source.indexOf('useNode()') > source.indexOf('function ActiveMusicPlayer'))
  t.ok(source.includes('if (!queue.done) start(epoch, true)'), 'automatic start only on queue ended')
  t.is([...source.matchAll(/start\(epoch/g)].length, 3, 'only press, explicit queue step and ended call start')
  t.is([...source.matchAll(/await (?:job\.)?player\.play\(\)/g)].length, 3, 'start, resume and explicit scrub are the only play paths')
  t.ok(source.includes("accessibilityRole={onSeek ? 'adjustable' : 'progressbar'}"))
  t.ok(source.includes("name: 'increment'") && source.includes("name: 'decrement'"))
  t.ok(source.includes('PanResponder.create('))
  t.ok(source.includes('snippetEndMs(music.start, track?.duration) - music.start * 1000'))
})
