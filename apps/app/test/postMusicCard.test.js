// The music sticker of a post (src/ui/PostMusic.js). React Native does not
// load under Node: the source is read as text for its rules, and the real JSX
// runs once with small hook and host doubles so the visibility loop can be
// driven tick by tick. No request, player or network is ever made.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { displayText } = require('@varanda/rpc')

const SRC = path.join(__dirname, '../src')
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8')
const source = read('ui', 'PostMusic.js')

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

const code = withoutComments(source)

// The text from `start` to the first `end` after it.
function between (src, start, end) {
  const from = src.indexOf(start)
  if (from === -1) return ''
  const to = src.indexOf(end, from + start.length)
  return to === -1 ? '' : src.slice(from, to)
}

const idleState = { item: null, queue: { tracks: [], index: -1, done: false }, phase: 'idle', ms: 0, error: '', fallback: false, blocked: false }
const VISIBLE = [0, 300, 400, 60]
const HIDDEN = [0, 2000, 400, 60]

// The session remembers automatic failures per member and song, so each
// harness is a different member unless a test names one.
let members = 0

async function harness (options = {}) {
  const { transformSync } = require('@babel/core')
  const postMusic = await import('../src/postMusic.js')
  const embedLive = await import('../src/embedLive.js')
  const music = await import('../src/music.js')
  const mute = await import('../src/soundMute.js')
  postMusic.clearMusicAutoHold()
  mute.setSoundMuted(false)
  const env = { visible: true, held: false, online: true, busy: false, readerOn: false, readerKnown: true, at: VISIBLE, hosted: true, ...options }
  const member = options.member || (++members).toString(16).padStart(64, 'a')
  const calls = []
  const covers = []
  const opened = []
  const store = new Map()
  const holds = new Set()
  const slots = []
  let cursor = 0
  let pending = []
  let ticker = null
  let controller = null
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const hooks = {
    useState: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
      return [slots[at], (next) => { slots[at] = typeof next === 'function' ? next(slots[at]) : next }]
    },
    useRef: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = { current: initial }
      return slots[at]
    },
    useMemo: (fn, deps) => {
      const at = cursor++
      if (!(at in slots) || !same(slots[at].deps, deps)) slots[at] = { deps, value: fn() }
      return slots[at].value
    },
    useEffect: (fn, deps) => {
      const at = cursor++
      if (!(at in slots) || !same(slots[at].deps, deps)) pending.push({ at, fn, deps })
    },
    useContext: (ctx) => ctx.get()
  }
  const view = { measureInWindow: (done) => done(...env.at) }
  const deps = {
    ...postMusic,
    ...music,
    ...mute,
    ...hooks,
    EMBED_IDLE: embedLive.EMBED_IDLE,
    EMBED_LIVE: embedLive.EMBED_LIVE,
    EMBED_TICK_MS: embedLive.EMBED_TICK_MS,
    embedSlots: embedLive.embedSlots,
    mostlyHidden: embedLive.mostlyHidden,
    embedsHeld: () => env.held,
    onEmbedHold: (fn) => { holds.add(fn); return () => holds.delete(fn) },
    displayText,
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    Icon: 'Icon',
    LinkCard: 'LinkCard',
    MusicCover: 'MusicCover',
    MusicEqualizer: 'MusicEqualizer',
    MusicPlayerCard: 'MusicPlayerCard',
    StyleSheet: { create: (value) => value },
    useStyles: (make) => make({}),
    useTheme: () => ({ colors: {} }),
    layout: { hit: 44, topBar: 52, tabBar: 49 },
    radius: {},
    space: {},
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
    ScreenVisible: { get: () => env.visible },
    SheetDepth: { get: () => 0 },
    EmbedBandBottom: { get: () => null },
    TabBarShown: { get: () => true },
    useHosted: () => env.hosted,
    useNode: () => ({ hosted: true, online: env.online, accountOrigin: 'https://conta.test', request: env.request, passkey: { status: { publicKey: member } } }),
    musicAutoStore: () => ({ getItem: (key) => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, value) }),
    openExternal: (url) => opened.push(url),
    playbackBusy: () => env.busy,
    playbackEpoch: () => 7,
    screenReaderOn: () => env.readerOn,
    screenReaderKnown: () => env.readerKnown,
    useMusicCover: (kind, item, session, enabled) => { covers.push({ kind, item, session, enabled }); return null },
    musicPlayerIdle: idleState,
    createMusicPlayback: (session, ref, notify) => {
      let state = idleState
      const publish = (patch) => { state = { ...state, ...patch }; notify(state) }
      controller = {
        session,
        publish,
        press: (epoch, attempt) => calls.push(attempt === undefined ? ['press', epoch] : ['press', epoch, attempt]),
        stop: () => { calls.push(['stop']); publish({ phase: 'idle', blocked: false }) },
        release: () => calls.push(['release'])
      }
      calls.push(['create'])
      return controller
    },
    setInterval: (fn) => { ticker = fn; return 1 },
    clearInterval: () => { ticker = null }
  }
  const input = source.replace(/^import .+\n/gm, '').replace(/\bexport default /g, '').replace(/\bexport /g, '')
  const { code } = transformSync(input, { configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-react-jsx'] })
  // eslint-disable-next-line no-new-func
  const { PostMusic, AmbientMusic } = new Function(...Object.keys(deps), code + '\nreturn { PostMusic, AmbientMusic }')(...Object.values(deps))

  const walk = (node, fn) => {
    if (!node || typeof node !== 'object') return
    fn(node)
    for (const child of node.children) walk(child, fn)
  }
  let tree = null
  let lastRoot = null
  const card = { url: 'https://audius.co/artista/faixa#varanda-musica=s:abc:30', title: 'Título‮', desc: 'Artista\u0007' }
  const ref = options.music || { kind: 'snippet', id: 'abc', start: 30 }
  const render = () => {
    cursor = 0
    tree = AmbientMusic({ card, music: ref })
    let root = null
    walk(tree, (node) => { if (node.props.ref) root = node.props.ref })
    // Like React's ref: null while a fallback card shows.
    if (root) {
      root.current = view
      lastRoot = root
    } else if (lastRoot) {
      lastRoot.current = null
    }
    const run = pending
    pending = []
    for (const { at, fn, deps } of run) {
      const before = slots[at]
      if (before && typeof before.cleanup === 'function') before.cleanup()
      slots[at] = { deps, cleanup: fn() }
    }
    return tree
  }
  const unmount = () => {
    for (const slot of slots) if (slot && typeof slot.cleanup === 'function') slot.cleanup()
  }
  const tick = () => { if (ticker) ticker(); render() }
  const find = (pred) => {
    const out = []
    walk(tree, (node) => { if (pred(node)) out.push(node) })
    return out
  }
  const text = (node) => typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.map(text).join('') : ''
  const sticker = () => find((n) => n.type === 'Pressable' && n.props.accessibilityRole === 'button' && n.props.accessibilityHint !== undefined)[0]
  const presses = () => calls.filter((c) => c[0] === 'press')
  const stops = () => calls.filter((c) => c[0] === 'stop').length
  const hold = (on) => { env.held = on; for (const fn of [...holds]) fn() }
  return { hold, env, calls, covers, opened, store, render, tick, unmount, find, text, sticker, presses, stops, PostMusic, AmbientMusic, card, ref, postMusic, embedLive, mute, get controller () { return controller } }
}

test('PostMusic: playlists, the switch off and a node that is not hosted keep the old cards', async (t) => {
  const h = await harness()
  const card = { url: 'https://audius.co/x#varanda-musica=p:abc', title: 't', desc: 'd' }
  t.is(h.PostMusic({ card, music: { kind: 'playlist', id: 'abc' } }).type, 'MusicPlayerCard', 'a playlist keeps its card')
  const track = h.PostMusic({ card, music: { kind: 'track', id: 'abc' } })
  t.is(track.type, h.AmbientMusic, 'a track gets the sticker')
  t.is(track.props.key, card.url, 'a changed card is a new sticker')
  h.postMusic.setMusicAutoEnabled({ getItem: () => null, setItem: (k, v) => h.store.set(k, v) }, false)
  t.is(h.PostMusic({ card, music: { kind: 'track', id: 'abc' } }).type, 'MusicPlayerCard', 'the switch off keeps the old card')
  h.store.clear()
  h.env.hosted = false
  t.is(h.PostMusic({ card, music: { kind: 'snippet', id: 'abc', start: 0 } }).type, 'LinkCard', 'no hosted node: the stored card only')
})

test('mounting asks nothing, and only two visible checks start the song', async (t) => {
  const h = await harness()
  h.render()
  t.is(h.presses().length, 0, 'mounting presses nothing')
  t.ok(h.covers.every((c) => c.item === null), 'no cover before an item was answered')
  const s = h.sticker()
  t.is(s.props.accessibilityLabel, 'Tocar música')
  t.ok(h.text(s).includes(displayText('Título‮')), 'the stored title goes through displayText')
  t.absent(h.text(s).includes('‮'), 'no raw control character reaches the screen')
  t.ok(h.text(s).includes('15 s'), 'a snippet keeps its badge')
  h.tick()
  t.is(h.presses().length, 0, 'one check is not enough')
  h.tick()
  t.alike(h.presses(), [['press', 7, { auto: true }]], 'the second check starts it, marked automatic')
  h.tick()
  h.tick()
  t.is(h.presses().length, 1, 'a live row never presses again')
  h.unmount()
  t.ok(h.calls.some((c) => c[0] === 'release'), 'unmounting releases the playback')
})

test('nothing starts by itself over another player, a loaded frame, a screen reader or before its answer', async (t) => {
  for (const [name, setup, undo] of [
    ['busy playback', (h) => { h.env.busy = true }],
    ['a loaded provider frame', (h) => { h.release = h.embedLive.embedSlots.acquire() }, (h) => h.release()],
    ['a screen reader', (h) => { h.env.readerOn = true }],
    ['an unknown screen reader', (h) => { h.env.readerKnown = false }],
    ['a held silence', (h) => { h.postMusic.holdMusicAuto() }]
  ]) {
    const h = await harness()
    setup(h)
    h.render()
    for (let i = 0; i < 5; i++) h.tick()
    t.is(h.presses().length, 0, name + ': no automatic start')
    if (undo) undo(h)
    h.unmount()
  }
  const h = await harness()
  h.render()
  h.tick()
  h.env.at = HIDDEN
  h.tick()
  h.env.at = VISIBLE
  h.tick()
  t.is(h.presses().length, 0, 'the dwell restarts after a hidden check')
  h.tick()
  t.is(h.presses().length, 1)
  h.unmount()
})

test('a screen reader still lets a tap play, and scrolling away stops it', async (t) => {
  const h = await harness({ readerOn: true })
  h.render()
  h.tick()
  h.tick()
  t.is(h.presses().length, 0)
  h.sticker().props.onPress()
  t.alike(h.presses(), [['press', 7]], 'a tap presses with no automatic mark')
  h.controller.publish({ phase: 'playing' })
  h.render()
  h.tick()
  t.is(h.stops(), 0, 'a visible tapped song keeps playing')
  h.env.at = HIDDEN
  h.tick()
  t.is(h.stops(), 1, 'scrolling away stops the tapped song')
  h.unmount()
})

test('a covered screen, a sheet or going offline stops the row', async (t) => {
  for (const [name, setup] of [
    ['another screen', (h) => { h.env.visible = false }],
    ['a sheet', (h) => { h.hold(true) }],
    ['offline', (h) => { h.env.online = false }]
  ]) {
    const h = await harness()
    h.render()
    h.tick()
    h.tick()
    t.is(h.presses().length, 1)
    h.controller.publish({ phase: 'playing' })
    h.render()
    setup(h)
    h.render()
    t.is(h.stops(), 1, name + ' stops it')
    h.env.visible = true
    h.hold(false)
    h.env.online = true
    h.render()
    h.tick()
    t.is(h.presses().length, 1, name + ': the dwell starts again from zero')
    h.unmount()
  }
})

test('a tap on a playing sticker silences every post until the next tap', async (t) => {
  const other = await harness()
  const h = await harness()
  h.render()
  h.tick()
  h.tick()
  h.controller.publish({ phase: 'playing' })
  h.render()
  t.is(h.sticker().props.accessibilityLabel, 'Silenciar música')
  h.sticker().props.onPress()
  t.is(h.stops(), 1)
  t.ok(h.postMusic.musicAutoHeld(), 'silenced everywhere')
  other.render()
  for (let i = 0; i < 4; i++) other.tick()
  t.is(other.presses().length, 0, 'another post does not start')
  h.render()
  h.sticker().props.onPress()
  t.absent(h.postMusic.musicAutoHeld(), 'the next tap lifts the silence')
  t.alike(h.presses().at(-1), ['press', 7])
  h.unmount()
  other.unmount()
})

const speaker = (h) => h.find((n) => n.type === 'Pressable' && (n.props.accessibilityLabel === 'Silenciar som' || n.props.accessibilityLabel === 'Ativar som'))[0]

test('the speaker mutes a playing row and covers read memory only', async (t) => {
  const h = await harness()
  h.render()
  const s = speaker(h)
  t.is(s.props.accessibilityLabel, 'Silenciar som')
  t.is(s.props.accessibilityHint, undefined, 'no hint, so it is not the song sticker')
  t.is(h.find((n) => n.type === 'Icon' && n.props.name === 'som').length, 1)
  h.tick()
  h.tick()
  h.controller.publish({ phase: 'playing', item: { id: 'abc', title: 'F', artist: 'A', duration: 200, url: 'https://audius.co/a/f', cover: true } })
  h.render()
  speaker(h).props.onPress()
  t.ok(h.mute.soundMuted())
  t.is(h.stops(), 1, 'the mute listener stops the controller')
  h.render()
  for (let i = 0; i < 4; i++) h.tick()
  t.is(h.presses().length, 1, 'no press on later ticks')
  t.is(h.covers.at(-1).enabled, 'cached')
  t.is(speaker(h).props.accessibilityLabel, 'Ativar som')
  h.unmount()
})

test('a mute from outside stops a live row at once; a hold does not', async (t) => {
  const h = await harness()
  h.render()
  h.tick()
  h.tick()
  h.controller.publish({ phase: 'playing' })
  h.render()
  h.postMusic.holdMusicAuto()
  t.is(h.stops(), 0, 'a hold from outside leaves the row playing')
  h.mute.setSoundMuted(true)
  t.is(h.stops(), 1, 'a mute stops it in the same call')
  h.unmount()
})

test('the speaker while muted unmutes through one manual press, only on an active row', async (t) => {
  const h = await harness()
  h.render()
  h.mute.setSoundMuted(true)
  h.postMusic.holdMusicAuto()
  h.render()
  t.is(speaker(h).props.accessibilityLabel, 'Ativar som')
  speaker(h).props.onPress()
  t.absent(h.mute.soundMuted())
  t.absent(h.postMusic.musicAutoHeld())
  t.alike(h.presses(), [['press', 7]])
  h.unmount()

  const away = await harness({ visible: false })
  away.render()
  away.mute.setSoundMuted(true)
  away.render()
  speaker(away).props.onPress()
  t.absent(away.mute.soundMuted(), 'inactive: state is cleared')
  t.is(away.presses().length, 0, 'nothing plays')
  away.unmount()
})

test('after a refusal the speaker offers sound and plays the kept player', async (t) => {
  const h = await harness()
  h.render()
  h.tick()
  h.tick()
  h.controller.publish({ phase: 'paused', blocked: true })
  h.render()
  t.is(speaker(h).props.accessibilityLabel, 'Ativar som')
  t.is(h.find((n) => n.type === 'Icon' && n.props.name === 'mudo').length, 1)
  speaker(h).props.onPress()
  t.alike(h.presses().at(-1), ['press', 7])
  h.unmount()
})

test('a sticker tap mute lets the row start again once sound returns', async (t) => {
  const h = await harness()
  h.render()
  h.tick()
  h.tick()
  h.controller.publish({ phase: 'playing' })
  h.render()
  h.sticker().props.onPress()
  h.mute.setSoundMuted(false)
  h.tick()
  h.tick()
  t.is(h.presses().length, 2, 'one automatic press after the first')
  t.alike(h.presses().at(-1), ['press', 7, { auto: true }])
  h.unmount()
})

test('a tap on a sounding sticker mutes sound', async (t) => {
  const h = await harness()
  h.render()
  h.tick()
  h.tick()
  h.controller.publish({ phase: 'playing' })
  h.render()
  h.sticker().props.onPress()
  t.ok(h.mute.soundMuted())
  h.unmount()
})

test('a refused sound shows Tocar música, and its tap plays the kept player', async (t) => {
  const h = await harness()
  h.render()
  h.tick()
  h.tick()
  h.controller.publish({ phase: 'paused', blocked: true })
  h.render()
  t.ok(h.postMusic.musicAutoHeld(), 'a refusal holds automatic starts')
  const chip = h.find((n) => n.type === 'Pressable' && h.text(n) === 'Tocar música')[0]
  t.ok(chip, 'the chip shows')
  chip.props.onPress()
  t.alike(h.presses().at(-1), ['press', 7], 'the chip presses the same controller, by hand')
  h.unmount()
})

test('an automatic failure shows nothing and is not retried; a manual one is announced', async (t) => {
  const h = await harness()
  h.render()
  h.tick()
  h.tick()
  h.controller.publish({ phase: 'idle', error: 'Música indisponível agora' })
  h.render()
  t.is(h.find((n) => n.props.accessibilityLiveRegion === 'polite').length, 0, 'no error text')
  t.absent(h.postMusic.musicAutoHeld(), 'a plain failure holds nothing')
  h.env.at = HIDDEN
  h.tick()
  h.env.at = VISIBLE
  for (let i = 0; i < 4; i++) h.tick()
  t.is(h.presses().length, 1, 'no automatic retry')
  h.sticker().props.onPress()
  h.controller.publish({ phase: 'idle', error: 'Música indisponível agora' })
  h.render()
  t.is(h.find((n) => n.props.accessibilityLiveRegion === 'polite').length, 1, 'a tapped failure is announced')
  h.unmount()

  const limit = await harness()
  limit.render()
  limit.tick()
  limit.tick()
  limit.controller.publish({ phase: 'idle', error: 'Limite de músicas por hoje' })
  t.ok(limit.postMusic.musicAutoHeld(), 'the daily limit holds every post')
  limit.unmount()
})

test('offline, a tap on an idle sticker starts nothing', async (t) => {
  const h = await harness({ online: false })
  h.render()
  h.sticker().props.onPress()
  h.render()
  t.is(h.presses().length, 0, 'no press, so no request')
  t.is(h.sticker().props.accessibilityLabel, 'Tocar música')
  h.unmount()
})

test('the daily limit after a tap holds automatic starts everywhere', async (t) => {
  const { MUSIC_LIMIT_TEXT } = await import('../src/music.js')
  // Made first: a new harness clears the hold.
  const other = await harness()
  const h = await harness()
  try {
    h.render()
    h.sticker().props.onPress()
    t.alike(h.presses(), [['press', 7]], 'a manual press')
    h.controller.publish({ phase: 'idle', error: MUSIC_LIMIT_TEXT })
    t.ok(h.postMusic.musicAutoHeld(), 'a tapped limit holds every post')
    other.render()
    for (let i = 0; i < 5; i++) other.tick()
    t.is(other.presses().length, 0, 'another visible sticker asks nothing')
  } finally {
    h.unmount()
    other.unmount()
    h.postMusic.clearMusicAutoHold()
  }
})

test('an automatic fallback keeps the sticker for a tap; a tapped one shows the link card', async (t) => {
  const h = await harness()
  h.render()
  h.tick()
  h.tick()
  h.controller.publish({ phase: 'idle', fallback: true })
  h.render()
  t.ok(h.sticker(), 'the sticker stays')
  t.absent(h.find((n) => n.type === 'LinkCard').length, 'no link card')
  t.ok(h.text(h.sticker()).includes(displayText('Título‮')), 'the stored title shows')
  h.env.at = HIDDEN
  h.tick()
  h.env.at = VISIBLE
  for (let i = 0; i < 4; i++) h.tick()
  t.is(h.presses().length, 1, 'no automatic retry')
  h.sticker().props.onPress()
  t.alike(h.presses().at(-1), ['press', 7], 'a tap takes the manual path')
  h.controller.publish({ phase: 'idle', fallback: true })
  h.render()
  t.is(h.render().type, 'LinkCard', 'a tapped fallback shows the link card')
  h.unmount()
})

test('an automatic failure is not repeated by the same row mounted again', async (t) => {
  for (const shape of [{ phase: 'idle', error: 'Música indisponível agora' }, { phase: 'idle', fallback: true }]) {
    const member = (++members).toString(16).padStart(64, 'c')
    const first = await harness({ member })
    first.render()
    first.tick()
    first.tick()
    first.controller.publish(shape)
    first.render()
    first.unmount()
    const again = await harness({ member })
    again.render()
    for (let i = 0; i < 5; i++) again.tick()
    t.is(again.presses().length, 0, (shape.error ? 'an error' : 'a fallback') + ': no new automatic start after scrolling back')
    again.unmount()
    const other = await harness()
    other.render()
    other.tick()
    other.tick()
    t.is(other.presses().length, 1, 'another member still starts by itself')
    other.unmount()
  }
})

test('the cover is asked only for this row answered item and only while seen', async (t) => {
  const h = await harness()
  h.render()
  h.tick()
  h.tick()
  const item = { id: 'abc', title: 'Faixa', artist: 'Artista', genre: 'Samba', year: 1999, duration: 200, url: 'https://audius.co/artista/faixa', cover: true }
  h.controller.publish({ phase: 'playing', item })
  h.render()
  const last = h.covers.at(-1)
  t.is(last.kind, 'track')
  t.is(last.item, item, 'the answered item reaches the cover hook')
  t.is(last.enabled, true, 'while seen')
  t.ok(h.text(h.sticker()).includes('Artista · Samba · 1999'), 'artist, genre and year')
  h.env.at = HIDDEN
  h.tick()
  h.render()
  t.is(h.covers.at(-1).enabled, false, 'a hidden row asks no cover')
  h.find((n) => n.props.accessibilityRole === 'link')[0].props.onPress()
  t.alike(h.opened, [item.url], 'Abrir no Audius opens the item page')
  h.unmount()
})

test('silenced, a row the person did not tap only reads a cover already in memory', async (t) => {
  const h = await harness()
  h.render()
  h.tick()
  h.tick()
  const item = { id: 'abc', title: 'Faixa', artist: 'Artista', duration: 200, url: 'https://audius.co/artista/faixa', cover: true }
  h.controller.publish({ phase: 'playing', item })
  h.render()
  t.is(h.covers.at(-1).enabled, true, 'playing by itself and seen: the cover may load')
  h.sticker().props.onPress()
  h.render()
  t.ok(h.postMusic.musicAutoHeld())
  t.is(h.covers.at(-1).item, item)
  t.is(h.covers.at(-1).enabled, 'cached', 'silenced: memory only')
  h.env.at = HIDDEN
  h.tick()
  t.is(h.covers.at(-1).enabled, false, 'hidden: nothing')
  h.env.at = VISIBLE
  h.tick()
  t.is(h.covers.at(-1).enabled, 'cached', 'back on screen, still silenced: no new load')
  h.sticker().props.onPress()
  h.render()
  t.is(h.covers.at(-1).enabled, true, 'a tap of the person may load it')
  h.unmount()
})

test('a refused row keeps its chip after scrolling away, until a tap or playback', async (t) => {
  for (const shape of [{ phase: 'paused', blocked: true }, { phase: 'idle', blocked: true }]) {
    const h = await harness()
    const chip = () => h.find((n) => n.type === 'Pressable' && h.text(n) === 'Tocar música')[0]
    h.render()
    h.tick()
    h.tick()
    h.controller.publish(shape)
    h.render()
    t.ok(chip(), shape.phase + ': the chip shows')
    h.env.at = HIDDEN
    h.tick()
    t.is(h.stops(), 1, shape.phase + ': scrolling away still stops the player')
    h.env.at = VISIBLE
    h.tick()
    h.tick()
    t.ok(chip(), shape.phase + ': the chip stays after the stop cleared blocked')
    chip().props.onPress()
    h.render()
    t.absent(chip(), shape.phase + ': a tap here takes it away')
    h.controller.publish({ ...shape })
    h.render()
    t.ok(chip())
    h.controller.publish({ phase: 'playing', blocked: false })
    h.render()
    t.absent(chip(), shape.phase + ': real playback takes it away')
    h.unmount()
  }
})

test('PostMusic source rules', (t) => {
  t.absent(/audiusItem\(|audiusPlay\(|audiusReady\(|audiusArt\(/.test(code), 'mounting makes no request of its own')
  t.absent(/AccessibilityInfo|Platform/.test(code), 'no AccessibilityInfo or Platform')
  t.absent(/\bfetch\s*\(/.test(code), 'no fetch')

  const presses = [...code.matchAll(/\.press\(/g)].map((m) => m.index)
  t.is(presses.length, 2, 'two presses: the start branch and the tap')
  const start = between(code, "if (action === 'start') {", "} else if (action === 'stop')")
  t.ok(start.includes('controller.current.press(playbackEpoch(), { auto: true })'), 'the automatic press reads the epoch there')
  t.is([...code.matchAll(/\{ auto: true \}/g)].length, 1, 'only the start branch marks a press automatic')
  const tap = between(code, 'const onTap = () => {', '\n  }\n')
  t.ok(/if \(phaseRef\.current === 'playing' \|\| phaseRef\.current === 'loading'\) \{\s*stepRef\.current = EMBED_IDLE\s*playback\.stop\(\)\s*setSoundMuted\(true\)\s*return/.test(tap), 'a tap on a sounding sticker stops it and mutes')
  t.absent(tap.includes('holdMusicAuto()'), 'the tap leaves the refusal hold alone')
  const clear = tap.indexOf('clearMusicAutoHold()')
  const press = tap.indexOf('playback.press(playbackEpoch())')
  t.ok(clear > 0 && press > clear, 'a tap clears the hold before it presses')
  const unmute = tap.indexOf('setSoundMuted(false)')
  t.ok(unmute > clear && press > unmute, 'a tap unmutes right after the hold and before it presses')
  t.ok(tap.includes('stepRef.current = EMBED_LIVE'), 'a tapped song is supervised')
  const active = tap.indexOf('if (!active) return')
  t.ok(active > 0 && tap.indexOf('setRefused(false)') > active, 'a tap that cannot start keeps the refusal chip')
  const reset = between(code, 'useEffect(() => {\n    setState(musicPlayerIdle)', '}, [playback])')
  t.ok(reset.includes('failedRef.current = false'), 'a new account or song forgets the row failure; the session record keys both')

  const settle = between(code, 'const settle = (hidden) => {', 'const unseen')
  t.ok(/if \(!enabled \|\| \(state\.fallback && !state\.auto\)\) return <LinkCard card=\{card\} \/>/.test(code), 'only a tapped fallback becomes the link card')
  t.ok(/if \(auto && \(next\.error \|\| next\.fallback\)\) \{\s*failedRef\.current = true\s*markMusicAutoFailed\(failKey\)/.test(code), 'an automatic error or fallback fails quietly, for the session')
  t.ok(code.includes('const failKey = JSON.stringify([member, origin, music.kind, music.id, music.start])'), 'the mark names the playback')
  const busy = settle.indexOf('playbackBusy()')
  const slots = settle.indexOf('embedSlots.count() > 0')
  const step = settle.indexOf('ambientStep(stepRef.current, { hidden, busy, failed: failedRef.current || musicAutoFailed(failKeyRef.current) })')
  t.ok(busy > 0 && slots > 0 && step > busy && step > slots, 'the probes are read right before the step')
  t.ok(/const autoOk = !musicAutoHeld\(\) && screenReaderKnown\(\) && !screenReaderOn\(\)/.test(settle), 'the automatic gate')
  t.ok(settle.includes('const busy = !autoOk || playbackBusy() || embedSlots.count() > 0'), 'no automatic start without the gate')
  const measure = between(code, 'view.measureInWindow((x, y, w, h) => {', '} catch {')
  t.ok(measure.includes('settle(mostlyHidden('), 'the step runs inside the measure answer')

  t.ok(code.includes('const active = visible && !held && node.online !== false\n'), 'supervision')
  const halt = between(code, 'const halt = () => {', '\n    }\n')
  t.ok(halt.includes('controller.current.stop()'), 'halting stops playback')
  t.absent(/screenReaderOn|autoOk/.test(halt) || /screenReaderOn|autoOk/.test(code.slice(code.indexOf('const active'), code.indexOf('\n', code.indexOf('const active')))), 'a screen reader never keeps a song from stopping')
  t.ok(/if \(!active\) \{\s*halt\(\)/.test(code), 'an inactive row stops')
  t.ok(code.includes('return () => playback.release()'), 'release on unmount')

  t.ok(code.includes('if (!ambientKind(music) || !auto) return <MusicPlayerCard card={card} music={music} />'), 'playlist and switch off keep the card')
  t.ok(code.includes('return onMusicAutoChange(sync)'), 'the switch reaches mounted rows')
  t.ok(code.includes("const coverMode = !shownNow || !active ? false : (silenced || musicAutoHeld()) ? 'cached' : true"), 'hidden or inactive asks nothing, silenced reads memory only, tapped rows too')
  const ambient = code.slice(code.indexOf('function AmbientMusic ('))
  t.ok(ambient.includes('const [silenced, setSilenced] = useState(musicAutoHeld)'), 'the hold is kept in state')
  t.ok(/useEffect\(\(\) => \{\s*const sync = \(\) => setSilenced\(musicAutoHeld\(\)\)\s*sync\(\)\s*return onMusicAutoHold\(sync\)\s*\}, \[\]\)/.test(ambient), 'a hold set by another row re-renders this one')
  t.ok(code.includes("useMusicCover('track', samePlayback ? state.item : null, { member, origin, request }, coverMode)"), 'the cover follows the item and the visibility')
  t.ok(code.includes("accessibilityLabel='Abrir no Audius'"))
  t.ok(code.includes('{MUSIC_SOURCE}'))
  t.ok(code.includes('displayText(item ? item.title : card.title)'), 'title through displayText')
  t.ok(code.includes('displayText(item ? (musicInfoLine(item) || musicRowLine(item)) : card.desc)'), 'second line through displayText')
  t.ok(code.includes("accessibilityLiveRegion='polite'"))
})

test('screen reader modules and the rows that read them', (t) => {
  const exportsOf = (file) => [...withoutComments(read('ui', file)).matchAll(/export function (\w+)/g)].map((m) => m[1]).sort()
  t.alike(exportsOf('screenReader.native.js'), ['screenReaderKnown', 'screenReaderOn'])
  t.alike(exportsOf('screenReader.web.js'), exportsOf('screenReader.native.js'), 'the same names on both platforms')
  const web = withoutComments(read('ui', 'screenReader.web.js'))
  t.absent(web.includes('AccessibilityInfo'), 'the web never asks react-native-web, which always answers true')
  const native = withoutComments(read('ui', 'screenReader.native.js'))
  t.ok(native.includes('AccessibilityInfo.isScreenReaderEnabled()'))
  t.ok(native.includes("AccessibilityInfo.addEventListener('screenReaderChanged'"))
  const row = withoutComments(read('ui', 'PostRow.js'))
  t.ok(row.includes("import { screenReaderOn } from './screenReader'"))
  t.absent(row.includes('isScreenReaderEnabled'), 'PostRow no longer asks by itself')
  t.ok(row.includes('if (screenReaderOn()) {'), 'the double tap still yields to a screen reader')
})

test('Ajustes: the music switch sits right above the link preview row', (t) => {
  const ajustes = withoutComments(read('screens', 'Ajustes.js'))
  t.ok(ajustes.includes("from '../postMusic'"))
  t.ok(ajustes.includes("import { musicAutoStore } from '../musicAutoStore'"))
  const musicRow = ajustes.indexOf('label={MUSIC_AUTO_PREF_LABEL}')
  const previewRow = ajustes.indexOf('label={PREVIEW_PREF_LABEL}')
  t.ok(musicRow > 0 && previewRow > musicRow, 'the music row comes before the preview row')
  t.is(ajustes.slice(musicRow, previewRow).split('<SwitchRow').length - 1, 1, 'right before it')
  t.ok(ajustes.includes('setMusicAutoEnabled(musicStore, next)'))
  t.absent(/setMusicAutoEnabled\(prefStore|previewsEnabled\(musicStore|setPreviewsEnabled\(musicStore/.test(ajustes), 'the two stores never mix')
  t.ok(ajustes.indexOf('caption={MUSIC_AUTO_PREF_NOTE}') > musicRow && ajustes.indexOf('caption={MUSIC_AUTO_PREF_NOTE}') < previewRow && ajustes.indexOf('caption={PREVIEW_PREF_NOTE}') > previewRow, 'each note is the caption of its own row')
  t.absent(/localStorage|\bdocument\.|\bwindow\./.test(ajustes), 'Ajustes touches no browser storage or DOM')
})
