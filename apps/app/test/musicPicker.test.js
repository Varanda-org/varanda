'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const source = fs.readFileSync(path.join(__dirname, '../src/ui/MusicPicker.js'), 'utf8')

// Run the exported logic directly, with the account and stream imports
// replaced by local doubles. React Native and expo-audio never load in Node.
async function helpers (stubs = {}, code = source) {
  const music = await import('../src/music.js')
  const playback = await import('../src/media/chatMedia.js')
  const deps = { ...music, ...playback, ...stubs }
  const body = code.slice(code.indexOf('export const musicSearchIdle'), code.indexOf('export function MusicPicker')).replace(/\bexport /g, '')
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), body + '\nreturn { musicSearchIdle, musicSearchStep, musicTime, musicStartAt, musicPickStep, createSnippetPreview }')(...Object.values(deps))
}

function deferred () {
  let resolve, reject
  const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  return { promise, resolve, reject }
}

const track = (id = 'abc', duration = 90) => ({ id, title: 'Faixa', artist: 'Artista', duration })
const answer = { url: '/account/audius/audio/' + 'a'.repeat(43), base: null, expiresAt: '2099-01-01T00:00:00Z' }

async function previewFixture (options = {}) {
  const calls = []
  const states = []
  const players = []
  const tickets = []
  const session = { member: 'a'.repeat(64), origin: 'node-origin', request: () => {} }
  const h = await helpers({
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
        error: (err) => { for (const fn of [...errors]) fn(err) },
        listeners,
        errors
      }
      players.push(player)
      return player
    },
    ...options.timers
  }, options.code)
  const preview = h.createSnippetPreview(session, (state) => states.push(state))
  return { preview, calls, states, players, tickets, session }
}

// Keep hook storage by tree position so hiding and unmounting the search have
// different lifecycles. Host elements and network/media imports stay local.
async function ui (stubs = {}) {
  const { transformSync } = require('@babel/core')
  const music = await import('../src/music.js')
  const media = await import('../src/media/chatMedia.js')
  const instances = new Map()
  let slots, cursor, dirty, effects
  const changed = (prev, deps) => !prev || deps.some((value, i) => value !== prev.deps[i])
  const useState = (initial) => {
    const at = cursor++
    const store = slots
    if (!(at in store)) store[at] = initial
    return [store[at], (next) => {
      if (store[at] !== next) { store[at] = next; dirty = true }
    }]
  }
  const deps = {
    ...music,
    ...media,
    rpc: require('@varanda/rpc'),
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) },
    useState,
    useReducer: (reduce, initial) => {
      const [state, set] = useState(initial)
      return [state, (action) => set(reduce(state, action))]
    },
    useRef: (initial) => useState({ current: initial })[0],
    useMemo: (fn, deps) => {
      const at = cursor++
      if (changed(slots[at], deps)) slots[at] = { deps, value: fn() }
      return slots[at].value
    },
    useEffect: (fn, deps) => {
      const at = cursor++
      if (!changed(slots[at], deps)) return
      const old = slots[at]
      const entry = slots[at] = { deps }
      effects.push(() => { old?.cleanup?.(); entry.cleanup = fn() })
    },
    Platform: { OS: 'web' },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    StyleSheet: { create: (value) => value },
    useStyles: (make) => make({}),
    useTheme: () => ({ colors: {} }),
    layout: { hit: 44 },
    radius: {},
    space: {},
    webInputReset: {},
    ...Object.fromEntries(['ActivityIndicator', 'FlatList', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View', 'Btn', 'Icon', 'Segmented', 'Sheet'].map((name) => [name, name])),
    ...stubs
  }
  const input = source.replace(/^import .+\n/gm, '').replace(/\bexport /g, '')
  const { code } = transformSync(input, { configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-react-jsx'] })
  // eslint-disable-next-line no-new-func
  const components = new Function(...Object.keys(deps), code + '\nreturn { MusicContent, StartPicker }')(...Object.values(deps))
  const cleanup = (instance) => { for (const slot of instance.slots) slot?.cleanup?.() }
  function render (Component, props) {
    let tree
    do {
      dirty = false
      effects = []
      const seen = new Set()
      const visit = (node, key) => {
        if (!node || typeof node !== 'object') return node
        if (typeof node.type === 'function') {
          let instance = instances.get(key)
          if (!instance || instance.type !== node.type) {
            if (instance) cleanup(instance)
            instance = { type: node.type, slots: [] }
            instances.set(key, instance)
          }
          seen.add(key)
          slots = instance.slots
          cursor = 0
          return visit(node.type(node.props), key + '.render')
        }
        return { ...node, children: node.children.map((child, i) => visit(child, key + '.' + i)) }
      }
      tree = visit({ type: Component, props }, 'root')
      for (const [key, instance] of instances) {
        if (!seen.has(key)) { cleanup(instance); instances.delete(key) }
      }
      for (const effect of effects) effect()
    } while (dirty)
    return tree
  }
  return { ...components, render, unmount: () => { for (const instance of instances.values()) cleanup(instance); instances.clear() } }
}

function flatten (node) {
  if (!node || typeof node !== 'object') return []
  return [node, ...node.children.flatMap(flatten)]
}

test('returning to search preserves the query and results without another request', async (t) => {
  const calls = []
  const timers = new Map()
  let serial = 0
  const item = track()
  const h = await ui({
    audiusSearch: async (query) => { calls.push(query); return { items: [item], next: null } },
    setTimeout: (fn) => { timers.set(++serial, fn); return serial },
    clearTimeout: (id) => timers.delete(id)
  })
  t.teardown(h.unmount)
  const props = { modes: ['snippet', 'track'], stopRef: { current: null } }
  const render = () => flatten(h.render(h.MusicContent, props))
  let nodes = render()
  nodes.find((n) => n.type === 'TextInput').props.onChangeText('samba')
  render()
  for (const [id, fn] of timers) { timers.delete(id); fn() }
  await new Promise((resolve) => setImmediate(resolve))
  nodes = render()
  t.alike(calls, ['samba'])
  const list = nodes.find((n) => n.type === 'FlatList')
  t.alike(list.props.data, [item])
  list.props.renderItem({ item }).props.onPress()
  nodes = render()
  nodes.find((n) => n.props.label === 'Voltar à busca').props.onPress()
  nodes = render()
  t.is(nodes.find((n) => n.type === 'TextInput').props.value, 'samba')
  t.alike(nodes.find((n) => n.type === 'FlatList').props.data, [item])
  t.is(timers.size, 0, 'returning does not schedule a search')
  t.alike(calls, ['samba'])
})

test('start slider exposes web values and keyboard steps while retaining native actions', async (t) => {
  for (const os of ['android', 'ios', 'web']) {
    const h = await ui({ Platform: { OS: os } })
    t.teardown(h.unmount)
    let start = 42
    const render = () => flatten(h.render(h.StartPicker, { duration: 190, start, onChange: (value) => { start = value } })).find((n) => n.props.accessibilityRole === 'adjustable').props
    let slider = render()
    t.is(slider['aria-valuemin'], 0)
    t.is(slider['aria-valuemax'], 175)
    t.is(slider['aria-valuenow'], 42)
    t.is(slider.accessibilityValue.text, '0:42 - 0:57')
    t.is(slider['aria-valuetext'], slider.accessibilityValue.text, os + ': ARIA preserves the snippet window')
    slider.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } })
    t.is(start, 43)
    if (os !== 'web') {
      t.is(slider.tabIndex, undefined)
      t.is(slider.onKeyDown, undefined)
      continue
    }
    t.is(slider.tabIndex, 0)
    t.is(typeof slider.onKeyDown, 'function')
    for (const [key, expected] of [['ArrowLeft', 42], ['ArrowDown', 41], ['ArrowRight', 42], ['ArrowUp', 43], ['Home', 0], ['ArrowLeft', 0], ['End', 175], ['ArrowRight', 175]]) {
      slider = render()
      let prevented = false
      slider.onKeyDown?.({ nativeEvent: { key }, preventDefault: () => { prevented = true }, stopPropagation () {} })
      t.is(start, expected, key)
      t.ok(prevented, key + ' prevents page scroll')
      t.is(render()['aria-valuenow'], expected)
    }
    let prevented = false
    render().onKeyDown?.({ key: 'Tab', preventDefault: () => { prevented = true } })
    t.absent(prevented, 'unhandled keys keep their default')
  }
})

test('search generations invalidate old pages and failures before the debounce', async (t) => {
  const { musicSearchIdle: idle, musicSearchStep: step } = await helpers()
  let s = step(idle, { type: 'query', text: ' samba ', kind: 'track' })
  t.is(s.query, 'samba')
  t.is(s.phase, 'waiting')
  const old = s.gen
  s = step(s, { type: 'query', text: 'jazz', kind: 'track' })
  t.is(step(s, { type: 'loading', gen: old }), s)
  t.is(step(s, { type: 'page', gen: old, page: { items: [track()], next: null } }), s)
  t.is(step(s, { type: 'fail', gen: old, error: { code: 'limite-musica' } }), s)
  s = step(s, { type: 'page', gen: s.gen, page: { items: [track('a')], next: '12' } })
  s = step(s, { type: 'more' })
  t.is(s.phase, 'more')
  t.is(step(s, { type: 'more' }), s, 'one page in flight')
  s = step(s, { type: 'page', gen: s.gen, page: { items: [track('a'), track('b')], next: null } })
  t.alike(s.items.map((item) => item.id), ['a', 'b'])
  t.is(step(s, { type: 'more' }), s, 'last page')
  const gen = s.gen
  s = step(s, { type: 'query', text: 'jazz', kind: 'playlist' })
  t.ok(s.gen > gen)
  t.alike(s.items, [])
  t.is(s.kind, 'playlist')
  t.is(step(s, { type: 'page', gen, page: { items: [track()], next: null } }), s, 'no tracks in a playlist answer')
  s = step(s, { type: 'query', text: ' ', kind: 'playlist' })
  t.is(s.phase, 'idle')
  t.is(s.query, '')
})

test('search errors use the shared texts and retry only on request', async (t) => {
  const m = await import('../src/music.js')
  const { musicSearchIdle: idle, musicSearchStep: step } = await helpers()
  for (const code of ['limite-musica', 'feature-off', 'nao-encontrado', 'indisponivel', 'nao-autorizado']) {
    let s = step(idle, { type: 'query', text: 'x', kind: 'track' })
    s = step(s, { type: 'fail', gen: s.gen, error: { code } })
    t.is(s.error, code === 'limite-musica' ? m.MUSIC_LIMIT_TEXT : m.MUSIC_UNAVAILABLE_TEXT, code)
    t.is(step(s, { type: 'more' }), s, 'end reached never retries a failure')
    t.is(step(s, { type: 'retry' }).phase, 'waiting')
  }
})

test('start coordinates, time labels and allowed uses', async (t) => {
  const h = await helpers()
  t.is(h.musicStartAt(50, 100, 90), 38)
  t.is(h.musicStartAt(-50, 100, 90), 0)
  t.is(h.musicStartAt(150, 100, 90), 75)
  t.is(h.musicStartAt(50, 0, 90), 0)
  t.is(h.musicStartAt(100, 100, 7), 0)
  t.is(h.musicTime(65), '1:05')
  t.is(h.musicTime(0), '0:00')
  t.is(h.musicPickStep('track', ['snippet']), 'snippet')
  t.is(h.musicPickStep('track', ['snippet', 'playlist']), 'snippet')
  t.is(h.musicPickStep('track', ['snippet', 'track', 'playlist']), 'choose')
  t.is(h.musicPickStep('track', ['track']), 'track')
  t.is(h.musicPickStep('playlist', ['snippet']), null)
  t.is(h.musicPickStep('playlist', ['playlist']), 'playlist')
})

test('preview confirms the seek, uses the ticket base and reuses one ticket for a track', async (t) => {
  const seek = deferred()
  const entered = deferred()
  const f = await previewFixture({ seek: () => { entered.resolve(); return seek.promise } })
  const running = f.preview.play(track(), 30)
  await entered.promise
  t.alike(f.calls[0], ['create', answer.url, { origin: answer.base }])
  t.alike(f.calls[1], ['seek', 30000])
  t.absent(f.calls.some((c) => c[0] === 'play'), 'no playback before seek confirmation')
  seek.resolve()
  await running
  t.ok(f.calls.some((c) => c[0] === 'play'))
  await f.preview.play(track(), 40)
  t.is(f.tickets.length, 1, 'adjusting the start reuses the ticket')
  t.ok(f.tickets[0].opts.signal instanceof AbortSignal)
  t.is(f.tickets[0].opts.request, f.session.request)
  await f.preview.play(track('other'), 0)
  t.is(f.tickets.length, 2, 'another track gets another ticket')
  f.preview.release()
  t.ok(f.tickets.every((call) => call.opts.signal.aborted))
  t.ok(f.players.every((p) => p.listeners.size === 0 && p.errors.size === 0), 'all subscriptions released')
})

test('a ticket answered after stopBoundPlayback never creates or plays audio', async (t) => {
  const { stopBoundPlayback } = await import('../src/media/chatMedia.js')
  const ticket = deferred()
  const f = await previewFixture({ ticket: () => ticket.promise })
  const running = f.preview.play(track(), 30)
  stopBoundPlayback()
  ticket.resolve(answer)
  await running
  t.alike(f.calls, [])
  t.ok(f.tickets[0].opts.signal.aborted)
  t.is(f.states.at(-1).phase, 'idle')
  f.preview.release()
})

test('a zero progress sample during seek does not override its confirmed target', async (t) => {
  const seek = deferred()
  const entered = deferred()
  const timers = []
  const f = await previewFixture({
    seek: () => { entered.resolve(); return seek.promise },
    timers: { setTimeout: (fn, ms) => { timers.push(ms) }, clearTimeout: () => {} }
  })
  t.teardown(() => f.preview.release())
  const running = f.preview.play(track(), 30)
  await entered.promise
  f.players[0].progress({ ms: 0, playing: false })
  t.absent(f.calls.some((c) => c[0] === 'play'))
  seek.resolve()
  await running
  t.alike(f.calls.filter((c) => c[0] === 'seek'), [['seek', 30000]])
  t.ok(f.calls.some((c) => c[0] === 'play'))
  t.is(f.states.at(-1).phase, 'playing')
  f.players[0].progress({ ms: 30000, playing: true })
  t.alike(timers, [15000], 'the snippet window begins at the confirmed target')
})

test('errors during a pending seek distinguish unavailable media from seek failures', async (t) => {
  const { MUSIC_UNAVAILABLE_TEXT, MUSIC_SEEK_TEXT } = await import('../src/music.js')
  for (const code of ['media', 'load-timeout', 'seek', 'seek-timeout']) {
    const seek = deferred()
    const entered = deferred()
    const f = await previewFixture({ seek: () => { entered.resolve(); return seek.promise } })
    t.teardown(() => f.preview.release())
    const running = f.preview.play(track(), 30)
    await entered.promise
    f.players[0].error({ code })
    t.is(f.states.at(-1).error, code.startsWith('seek') ? MUSIC_SEEK_TEXT : MUSIC_UNAVAILABLE_TEXT, code)
    seek.resolve()
    await running
    t.absent(f.calls.some((c) => c[0] === 'play'))
  }
})

test('another playback claim cancels a pending preview seek', async (t) => {
  const { claimPlayback } = await import('../src/media/chatMedia.js')
  const seek = deferred()
  const entered = deferred()
  const f = await previewFixture({ seek: () => { entered.resolve(); return seek.promise } })
  t.teardown(() => f.preview.release())
  const running = f.preview.play(track(), 30)
  await entered.promise
  const releaseOther = claimPlayback({ pause () {} })
  t.teardown(releaseOther)
  seek.resolve()
  await running
  t.absent(f.calls.some((c) => c[0] === 'play'))
  t.ok(f.calls.some((c) => c[0] === 'release'))
  t.is(f.players[0].listeners.size, 0)
  t.is(f.players[0].errors.size, 0)
  t.ok(f.tickets[0].opts.signal.aborted)
  t.is(f.states.at(-1).phase, 'idle')
})

test('a confirmed seek after leaving releases its bound player without playing', async (t) => {
  const { stopBoundPlayback } = await import('../src/media/chatMedia.js')
  const seek = deferred()
  const entered = deferred()
  const f = await previewFixture({ seek: () => { entered.resolve(); return seek.promise } })
  const running = f.preview.play(track(), 30)
  await entered.promise
  stopBoundPlayback()
  t.ok(f.calls.some((c) => c[0] === 'pause'), 'the claim is bound while seeking')
  seek.resolve()
  await running
  t.absent(f.calls.some((c) => c[0] === 'play'))
  t.ok(f.calls.some((c) => c[0] === 'release'))
  t.is(f.players[0].listeners.size, 0)
})

test('close or unmount cancels an unanswered ticket with no later UI update', async (t) => {
  const ticket = deferred()
  const f = await previewFixture({ ticket: () => ticket.promise })
  const running = f.preview.play(track(), 0)
  f.preview.release()
  const updates = f.states.length
  ticket.resolve(answer)
  await running
  t.ok(f.tickets[0].opts.signal.aborted)
  t.alike(f.calls, [])
  t.is(f.states.length, updates)
})

test('an old seek cannot release or play a newer attempt', async (t) => {
  const seek = deferred()
  const entered = deferred()
  let n = 0
  const f = await previewFixture({ seek: () => { if (++n === 1) { entered.resolve(); return seek.promise } } })
  const old = f.preview.play(track(), 20)
  await entered.promise
  await f.preview.play(track(), 40)
  const before = f.calls.length
  seek.resolve()
  await old
  t.is(f.calls.length, before)
  t.is(f.players[1].listeners.size, 1)
  f.preview.release()
})

test('rejected seeks, including a landing outside the range, never start audio', async (t) => {
  const { MUSIC_SEEK_TEXT } = await import('../src/music.js')
  for (const seek of [() => { throw new Error('seek') }, () => { throw Object.assign(new Error(), { code: 'seek-range' }) }]) {
    const f = await previewFixture({ seek })
    await f.preview.play(track(), 30)
    t.absent(f.calls.some((c) => c[0] === 'play'))
    t.is(f.states.at(-1).error, MUSIC_SEEK_TEXT)
    t.ok(f.calls.some((c) => c[0] === 'release'))
  }
  for (const code of ['superseded', 'released']) {
    const f = await previewFixture({ seek: () => { throw Object.assign(new Error(code), { code }) } })
    await f.preview.play(track(), 30)
    t.is(f.states.at(-1).error, '')
    t.absent(f.calls.some((c) => c[0] === 'play'))
  }
})

test('the preview stops at the window end, including a track under fifteen seconds', async (t) => {
  for (const [duration, start, end] of [[90, 30, 45000], [7, 0, 7000]]) {
    const f = await previewFixture()
    await f.preview.play(track('a', duration), start)
    f.players[0].progress({ ms: end, playing: true })
    t.is(f.states.at(-1).phase, 'idle')
    t.ok(f.calls.some((c) => c[0] === 'pause'))
    t.ok(f.calls.some((c) => c[0] === 'release'))
    t.alike(f.calls.find((c) => c[0] === 'seek'), ['seek', start * 1000])
  }
})

test('a stream failure reports once, and only a new tap requests a fresh ticket', async (t) => {
  const { MUSIC_UNAVAILABLE_TEXT } = await import('../src/music.js')
  const f = await previewFixture()
  await f.preview.play(track(), 0)
  f.players[0].error(new Error('media'))
  const updates = f.states.length
  f.players[0].error(new Error('media'))
  t.is(f.states.length, updates)
  t.is(f.states.at(-1).error, MUSIC_UNAVAILABLE_TEXT)
  t.is(f.tickets.length, 1)
  await f.preview.play(track(), 0)
  t.is(f.tickets.length, 2)
  f.preview.release()
})

test('progress schedules the exact remaining window and buffering cancels that timer', async (t) => {
  const timers = new Map()
  let serial = 0
  const f = await previewFixture({
    timers: {
      setTimeout: (fn, ms) => { timers.set(++serial, { fn, ms }); return serial },
      clearTimeout: (id) => timers.delete(id)
    }
  })
  await f.preview.play(track(), 30)
  const player = f.players[0]
  player.progress({ ms: 32000, playing: true, buffering: false })
  t.is(timers.size, 1)
  t.is([...timers.values()][0].ms, 13000)
  player.progress({ ms: 33000, playing: true, buffering: true })
  t.is(timers.size, 0, 'buffering does not spend the remaining audio window')
  player.progress({ ms: 44000, playing: true, buffering: false })
  t.is([...timers.values()][0].ms, 1000)
  const timer = [...timers.values()][0]
  timer.fn()
  t.is(f.states.at(-1).phase, 'idle')
  t.is(timers.size, 0)
  t.ok(f.calls.some((c) => c[0] === 'release'))
})

test('a late play completion after leaving releases the player', async (t) => {
  const { stopBoundPlayback } = await import('../src/media/chatMedia.js')
  const playing = deferred()
  const entered = deferred()
  const f = await previewFixture({ play: () => { entered.resolve(); return playing.promise } })
  const running = f.preview.play(track(), 0)
  await entered.promise
  stopBoundPlayback()
  playing.resolve()
  await running
  t.ok(f.calls.some((c) => c[0] === 'release'))
  t.is(f.states.at(-1).phase, 'idle')
})

test('expired tickets renew on a tap and the account base reaches the player unchanged', async (t) => {
  const base = 'https://account.example'
  const url = base + answer.url
  const f = await previewFixture({ ticket: () => ({ url, base, expiresAt: '2000-01-01T00:00:00Z' }) })
  await f.preview.play(track(), 0)
  t.alike(f.calls[0], ['create', url, { origin: base }])
  t.is(f.tickets.length, 1)
  await f.preview.play(track(), 10)
  t.is(f.tickets.length, 2)
  f.preview.release()
})

test('the picker stays shared, uses safe provider text and releases on close, pick and unmount', (t) => {
  t.ok(source.includes('displayText(item.title)'))
  t.ok(source.includes('displayText(item.artist)'))
  t.absent(/\bfetch\s*\(|https?:\/\/|Platform\.OS|\bImage\b|globalThis\.|\bdocument\.|\bwindow\./.test(source.replace("const WEB = Platform.OS === 'web'", '')))
  t.absent(source.includes('\u2014'))
  t.ok(source.includes("from '../media/stream'"))
  t.ok(source.includes('claimPlayback({ pause: stop }, { bound: true, epoch })'))
  t.ok(source.includes('return () => { preview.release(); stopRef.current = null }'))
  t.ok(source.includes('const close = () => { stopRef.current?.(); onClose() }'))
  t.ok(/const pick = [\s\S]*?preview.release\(\)[\s\S]*?onPick\(\{ ref:/.test(source))
  t.ok(source.includes('signal: controller.signal'))
  t.ok(source.includes('controller.abort()'))
  t.ok(source.includes('MUSIC_DEBOUNCE_MS'))
  t.ok(source.includes("accessibilityRole='adjustable'"))
  t.ok(source.includes("name: 'increment'") && source.includes("name: 'decrement'"))
  t.ok(source.includes('PanResponder.create('))
  t.ok(source.includes('gesture.dx'))
  t.ok(source.includes('Músicas do Audius'))
  t.ok(source.includes('musicTime(start) + \' - \' + musicTime(end)'))
  t.ok(source.includes("onEndReached={() => dispatch({ type: 'more' })}"))
  t.ok(source.includes('{playlist ? <Segmented'))
})
