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
  return new Function(...Object.keys(deps), body + '\nreturn { musicSearchIdle, musicSearchStep, musicPickStep, createSnippetPreview }')(...Object.values(deps))
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
async function ui (stubs = {}, code = source, names = 'MusicContent, MusicPicker') {
  const { transformSync } = require('@babel/core')
  const music = await import('../src/music.js')
  const media = await import('../src/media/chatMedia.js')
  const instances = new Map()
  let slots, cursor, dirty, effects
  const changed = (prev, deps) => !prev || deps.some((value, i) => value !== prev.deps[i])
  const useState = (initial) => {
    const at = cursor++
    const store = slots
    // A function initialiser is the initial value, as in React. The editor is
    // seeded from open that way; storing the function would render it as data.
    if (!(at in store)) store[at] = typeof initial === 'function' ? initial() : initial
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
    tap: () => {},
    createSnippetLoop: () => ({ open () {}, setStart () {}, toggle () {}, stop () {}, release () {} }),
    loopIdle: { phase: 'idle', ms: 0, error: '' },
    StyleSheet: { create: (value) => value },
    useStyles: (make) => make({}),
    useTheme: () => ({ colors: {} }),
    useMusicCover: () => null,
    layout: { hit: 44 },
    radius: {},
    space: {},
    webInputReset: {},
    ...Object.fromEntries(['ActivityIndicator', 'FlatList', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View', 'Btn', 'Icon', 'Segmented', 'Sheet', 'MusicCover', 'MusicEditor', 'MusicStrip', 'Pill'].map((name) => [name, name])),
    ...stubs
  }
  const input = code.replace(/^import .+\n/gm, '').replace(/\bexport /g, '')
  const out = transformSync(input, { configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-react-jsx'] }).code
  // eslint-disable-next-line no-new-func
  const components = new Function(...Object.keys(deps), out + '\nreturn { ' + names + ' }')(...Object.values(deps))
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
  const props = { open: true, modes: ['snippet', 'track'], onClose () {}, onPick () {} }
  const render = () => flatten(h.render(h.MusicPicker, props))
  let nodes = render()
  nodes.find((n) => n.type === 'TextInput').props.onChangeText('samba')
  render()
  for (const [id, fn] of timers) { timers.delete(id); fn() }
  await new Promise((resolve) => setImmediate(resolve))
  nodes = render()
  t.alike(calls, ['samba'])
  const list = nodes.find((n) => n.type === 'FlatList')
  t.alike(list.props.data, [item])
  const row = list.props.renderItem({ item })
  mainOf(row).props.onPress()
  nodes = render()
  t.ok(nodes.some((n) => n.type === 'MusicEditor'), 'the row opens the editor')
  sheetOf(nodes).props.left.props.onPress()
  nodes = render()
  t.absent(nodes.some((n) => n.type === 'MusicEditor'))
  t.is(nodes.find((n) => n.type === 'TextInput').props.value, 'samba')
  t.alike(nodes.find((n) => n.type === 'FlatList').props.data, [item])
  t.is(timers.size, 0, 'returning does not schedule a search')
  t.alike(calls, ['samba'])
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

test('allowed uses open the editor', async (t) => {
  const h = await helpers()
  t.is(h.musicPickStep('track', ['snippet']), 'edit')
  t.is(h.musicPickStep('track', ['snippet', 'playlist']), 'edit')
  t.is(h.musicPickStep('track', ['snippet', 'track', 'playlist']), 'edit')
  t.is(h.musicPickStep('track', ['track']), 'edit')
  t.is(h.musicPickStep('track', ['playlist']), null)
  t.is(h.musicPickStep('playlist', ['snippet']), null)
  t.is(h.musicPickStep('playlist', ['snippet', 'track']), null)
  t.is(h.musicPickStep('playlist', ['playlist']), 'edit')
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
  const editor = fs.readFileSync(path.join(__dirname, '../src/ui/MusicEditor.js'), 'utf8')
  t.ok(source.includes('displayText(item.title)'))
  t.ok(source.includes('displayText(musicRowLine(item))'))
  t.ok(editor.includes('displayText(item.artist)'))
  t.ok(editor.includes('displayText(item.title)'))
  for (const code of [source, editor]) {
    t.absent(/\bfetch\s*\(|https?:\/\/|\bPlatform\b|\bImage\b|globalThis\.|\bdocument\.|\bwindow\.|\bURL\b/.test(code))
    t.absent(code.includes('\u2014'))
  }
  t.ok(source.includes("from '../media/stream'"))
  t.ok(source.includes('claimPlayback({ pause: stop }, { bound: true, epoch })'))
  t.ok(source.includes('return () => { preview.release(); stopRef.current = null }'))
  t.ok(source.includes('const close = () => { stopRef.current?.(); onClose() }'))
  t.ok(/const done = [\s\S]*?stopRef\.current\?\.\(\)[\s\S]*?onPick\(\{ ref:/.test(source))
  t.ok(source.includes("label='Concluído'"))
  t.ok(source.includes("'Ouvir prévia'"))
  t.ok(source.includes("label='Voltar'"))
  t.absent(source.includes('Voltar à busca'))
  t.absent(source.includes('StartPicker'))
  t.ok(source.includes('signal: controller.signal'))
  t.ok(source.includes('controller.abort()'))
  t.ok(source.includes('MUSIC_DEBOUNCE_MS'))
  t.ok(source.includes('Músicas do Audius'))
  t.ok(source.includes("onEndReached={() => dispatch({ type: 'more' })}"))
  t.ok(source.includes('{playlist ? <Segmented'))
})

const editorSource = fs.readFileSync(path.join(__dirname, '../src/ui/MusicEditor.js'), 'utf8')
const mainOf = (row) => flatten(row.type(row.props)).find((n) => n.type === 'Pressable' && !n.props.accessibilityLabel)
const previewOf = (row) => flatten(row.type(row.props)).find((n) => n.type === 'Pressable' && /prévia/.test(n.props.accessibilityLabel || ''))
const sheetOf = (nodes) => nodes.find((n) => n.type === 'Sheet')

test('rows and the editor ask a cover only through useMusicCover', async (t) => {
  for (const code of [source, editorSource]) {
    t.absent(/\bfetch\b|\bURL\b|https?:\/\/|\bImage\b|\baudiusArt\b/.test(code))
    t.ok(code.includes("import { useMusicCover } from './useMusicCover'"))
  }
  const session = { member: 'a'.repeat(64), origin: 'node-origin', request () {} }
  const item = { ...track(), cover: true }
  const uri = 'data:image/jpeg;base64,Y292ZXI='
  for (const kind of ['track', 'playlist']) {
    const calls = []
    let cover = uri
    const h = await ui({
      useMusicCover: (...args) => { calls.push(args); return cover }
    }, source, 'MusicSearch, MusicRow')
    t.teardown(h.unmount)
    const tree = h.render(h.MusicSearch, { ...session, modes: [kind], onStop () {} })
    const row = flatten(tree).find((n) => n.type === 'FlatList').props.renderItem({ item })
    t.is(row.type, h.MusicRow, 'the list mounts a row component for its hook')
    const rendered = h.render(row.type, row.props)
    t.alike(calls, [[kind, item, session]], 'the row forwards the search kind and session')
    t.alike(flatten(rendered).find((n) => n.type === 'MusicCover').props, { size: 48, uri })
    cover = null
    const fallback = h.render(row.type, row.props)
    t.is(flatten(fallback).find((n) => n.type === 'MusicCover').props.uri, null, 'no cover keeps the generated tile')
  }
  const calls = []
  let cover = uri
  const h = await ui({
    audiusPlay () {},
    createStreamPlayer () {},
    useMusicCover: (...args) => { calls.push(args); return cover }
  }, editorSource, 'MusicEditor')
  t.teardown(h.unmount)
  const props = { item, start: 0, modes: ['snippet', 'track', 'playlist'], session, stopRef: { current: null } }
  for (const kind of ['snippet', 'track', 'playlist']) {
    const tree = h.render(h.MusicEditor, { ...props, kind })
    t.alike(calls.at(-1), [kind === 'playlist' ? 'playlist' : 'track', item, session, true, true])
    t.alike(flatten(tree).find((n) => n.type === 'MusicCover').props, { size: 160, uri })
  }
  cover = null
  const fallback = h.render(h.MusicEditor, { ...props, kind: 'track' })
  t.is(flatten(fallback).find((n) => n.type === 'MusicCover').props.uri, null, 'the editor also keeps the generated tile')
})

async function pickerFixture (t, props = {}) {
  const searches = []
  const preview = []
  const timers = new Map()
  let serial = 0
  const h = await ui({
    audiusSearch: async (query, opts) => { searches.push([query, opts.kind]); return { items: opts.kind === 'playlist' ? [{ id: 'pl', title: 'Lista', artist: 'A', count: 3 }] : [track('abc', 90), track('def', 120)], next: null } },
    audiusPlay: async (id) => { preview.push(['ticket', id]); return answer },
    createStreamPlayer: () => ({ seek: async () => {}, play: async () => { preview.push(['play']) }, pause () {}, release: () => preview.push(['release']), onProgress: () => () => {}, onError: () => () => {} }),
    setTimeout: (fn) => { timers.set(++serial, fn); return serial },
    clearTimeout: (id) => timers.delete(id)
  })
  t.teardown(h.unmount)
  const picks = []
  let closed = 0
  const p = { open: true, modes: ['snippet', 'track', 'playlist'], onPick: (v) => picks.push(v), onClose: () => { closed++ }, ...props }
  const render = () => flatten(h.render(h.MusicPicker, p))
  const flush = async () => { for (const [id, fn] of timers) { timers.delete(id); fn() } await new Promise((resolve) => setImmediate(resolve)) }
  const search = async (text) => {
    render().find((n) => n.type === 'TextInput').props.onChangeText(text)
    render()
    await flush()
    return render()
  }
  const rows = (nodes) => nodes.find((n) => n.type === 'FlatList').props.data.map((item) => nodes.find((n) => n.type === 'FlatList').props.renderItem({ item }))
  return { h, p, render, search, rows, flush, searches, preview, picks, get closed () { return closed } }
}

test('a row preview plays without opening the editor', async (t) => {
  const f = await pickerFixture(t)
  let nodes = await f.search('samba')
  const [row] = f.rows(nodes)
  t.is(previewOf(row).props.accessibilityLabel, 'Ouvir prévia')
  previewOf(row).props.onPress()
  await f.flush()
  nodes = f.render()
  t.absent(nodes.some((n) => n.type === 'MusicEditor'), 'no editor')
  t.alike(f.picks, [])
  t.alike(f.preview.filter((c) => c[0] === 'ticket'), [['ticket', 'abc']])
  t.ok(f.preview.some((c) => c[0] === 'play'))
  const again = f.rows(nodes)[0]
  t.is(previewOf(again).props.accessibilityLabel, 'Parar prévia')
  t.is(previewOf(f.rows(nodes)[1]).props.accessibilityLabel, 'Ouvir prévia')
  previewOf(again).props.onPress()
  nodes = f.render()
  t.is(previewOf(f.rows(nodes)[0]).props.accessibilityLabel, 'Ouvir prévia')
})

test('one row previews at a time and a new query stops it', async (t) => {
  const f = await pickerFixture(t)
  let nodes = await f.search('samba')
  previewOf(f.rows(nodes)[0]).props.onPress()
  await f.flush()
  nodes = f.render()
  previewOf(f.rows(nodes)[1]).props.onPress()
  await f.flush()
  nodes = f.render()
  t.is(previewOf(f.rows(nodes)[0]).props.accessibilityLabel, 'Ouvir prévia')
  t.is(previewOf(f.rows(nodes)[1]).props.accessibilityLabel, 'Parar prévia')
  const released = f.preview.filter((c) => c[0] === 'release').length
  t.ok(released >= 1, 'the first player is released')
  nodes = await f.search('jazz')
  t.ok(f.preview.filter((c) => c[0] === 'release').length > released, 'a new query releases the preview')
  t.ok(f.rows(nodes).every((row) => previewOf(row).props.accessibilityLabel === 'Ouvir prévia'))
  nodes.find((n) => n.type === 'Segmented').props.onSelect('playlist')
  nodes = f.render()
  await f.flush()
  nodes = f.render()
  t.is(previewOf(f.rows(nodes)[0]), undefined, 'playlist rows have no preview')
})

test('the editor has Concluído in the top row and Voltar keeps the query', async (t) => {
  const f = await pickerFixture(t)
  let nodes = await f.search('samba')
  t.is(sheetOf(nodes).props.right, undefined)
  t.is(sheetOf(nodes).props.onBack, undefined)
  t.is(sheetOf(nodes).props.title, 'Música')
  mainOf(f.rows(nodes)[1]).props.onPress()
  nodes = f.render()
  const sheet = sheetOf(nodes)
  t.is(sheet.props.right.type, 'Pill')
  t.is(sheet.props.right.props.label, 'Concluído')
  t.ok(sheet.props.right.props.filled)
  t.is(sheet.props.left.props.label, 'Voltar')
  t.is(sheet.props.onBack, sheet.props.left.props.onPress)
  const editor = nodes.find((n) => n.type === 'MusicEditor')
  t.is(editor.props.item.id, 'def')
  t.is(editor.props.kind, 'snippet')
  t.is(editor.props.start, 0)
  t.alike(f.picks, [], 'opening picks nothing')
  sheet.props.onBack()
  nodes = f.render()
  t.is(nodes.find((n) => n.type === 'TextInput').props.value, 'samba')
  t.is(f.searches.length, 1)
  t.absent(nodes.some((n) => n.type === 'MusicEditor'))
})

test('done answers a clamped snippet ref, a track ref with start null and a playlist ref', async (t) => {
  for (const [kind, expected] of [['snippet', 75], ['track', null], ['playlist', null]]) {
    const f = await pickerFixture(t)
    let nodes = await f.search('samba')
    if (kind === 'playlist') {
      nodes.find((n) => n.type === 'Segmented').props.onSelect('playlist')
      f.render()
      await f.flush()
      nodes = f.render()
    }
    mainOf(f.rows(nodes)[0]).props.onPress()
    nodes = f.render()
    let editor = nodes.find((n) => n.type === 'MusicEditor')
    if (kind === 'playlist') t.is(editor.props.kind, 'playlist')
    if (kind === 'track') editor.props.onKind('track')
    if (kind === 'snippet') editor.props.onStart(500)
    nodes = f.render()
    editor = nodes.find((n) => n.type === 'MusicEditor')
    let released = 0
    editor.props.stopRef.current = () => { released++ }
    sheetOf(nodes).props.right.props.onPress()
    t.is(released, 1, kind + ': the loop is released')
    const id = kind === 'playlist' ? 'pl' : 'abc'
    t.alike(f.picks.map((p) => p.ref), [{ kind, id, start: expected }], kind)
    t.is(f.picks[0].item.id, id)
    t.is(f.closed, 1)
  }
})

test('a momento picker offers the strip and no chips', async (t) => {
  const loops = []
  const audiusPlay = () => { throw new Error('the loop owns the ticket') }
  const h = await ui({
    audiusPlay,
    createStreamPlayer () {},
    createSnippetLoop: (deps, session, notify) => {
      const calls = []
      loops.push({ deps, calls, notify })
      return { open: (...a) => calls.push(['open', ...a]), setStart: (s) => calls.push(['setStart', s]), toggle: () => calls.push(['toggle']), stop: () => calls.push(['stop']), release: () => calls.push(['release']) }
    }
  }, editorSource, 'MusicEditor')
  t.teardown(h.unmount)
  const starts = []
  const stopRef = { current: null }
  const item = track('abc', 90)
  const props = { item, kind: 'snippet', start: 10, modes: ['snippet'], session: {}, onKind () {}, onStart: (s) => starts.push(s), stopRef }
  let nodes = flatten(h.render(h.MusicEditor, props))
  t.absent(nodes.some((n) => n.type === 'Segmented'), 'no chips')
  const strip = nodes.find((n) => n.type === 'MusicStrip')
  t.is(strip.props.start, 10)
  t.is(strip.props.progress, null)
  t.is(loops.length, 1)
  t.alike(loops[0].calls, [['open', item, 10]])
  t.is(loops[0].deps.audiusPlay, audiusPlay, 'the loop gets the account ticket call')
  t.is(typeof stopRef.current, 'function', 'the release is exposed')
  strip.props.onChange(20)
  t.alike(loops[0].calls.filter((c) => c[0] === 'setStart'), [], 'a drag never seeks')
  strip.props.onCommit(30)
  t.alike(starts, [20, 30])
  t.alike(loops[0].calls.at(-1), ['setStart', 30])
  nodes.find((n) => n.props.accessibilityLabel === 'Ouvir trecho').props.onPress()
  t.alike(loops[0].calls.at(-1), ['toggle'])
  loops[0].notify({ phase: 'playing', ms: 17500, error: '' })
  nodes = flatten(h.render(h.MusicEditor, props))
  t.is(nodes.find((n) => n.type === 'MusicStrip').props.progress, 0.5)
  t.ok(nodes.some((n) => n.props.accessibilityLabel === 'Pausar trecho'))
  nodes = flatten(h.render(h.MusicEditor, { ...props, modes: ['snippet', 'track'] }))
  t.alike(nodes.find((n) => n.type === 'Segmented').props.options.map((o) => o.label), ['15 s', 'Faixa inteira'])
  nodes = flatten(h.render(h.MusicEditor, { ...props, modes: ['snippet', 'track'], kind: 'track' }))
  t.absent(nodes.some((n) => n.type === 'MusicStrip'))
  t.ok(nodes.some((n) => n.children.includes('A faixa inteira toca na publicação')))
  t.alike(loops[0].calls.at(-1), ['stop'])
  t.is(loops.filter((l) => l.calls.some((c) => c[0] === 'open')).length, 1, 'one loop opened once')
  h.unmount()
  t.alike(loops[0].calls.at(-1), ['release'])
  t.is(stopRef.current, null)
})

test('the snippet host stretches its children and the play toggle stays centered', async (t) => {
  const h = await ui({
    audiusPlay: () => { throw new Error('the loop owns the ticket') },
    createStreamPlayer () {},
    createSnippetLoop: () => ({ open () {}, setStart () {}, toggle () {}, stop () {}, release () {} })
  }, editorSource, 'MusicEditor')
  t.teardown(h.unmount)
  const stopRef = { current: null }
  const tree = h.render(h.MusicEditor, { item: track('abc', 90), kind: 'snippet', start: 10, modes: ['snippet'], session: {}, onKind () {}, onStart () {}, stopRef })
  const hostOf = (node, type) => {
    if (!node || typeof node !== 'object' || !node.children) return null
    for (const child of node.children) {
      if (child && child.type === type) return node
      const found = hostOf(child, type)
      if (found) return found
    }
    return null
  }
  const host = hostOf(tree, 'MusicStrip')
  const align = host && host.props.style && host.props.style.alignItems
  t.ok(host && (align == null || align === 'stretch'), 'the strip host does not centre its children')
  const play = flatten(tree).find((n) => n.props.accessibilityLabel === 'Ouvir trecho')
  const applied = [play.props.style({ pressed: false })].flat().filter(Boolean)
  t.ok(applied.some((rule) => rule.alignSelf === 'center'), 'the play toggle stays centered')
})

test('initial reopens the editor at the chosen start', async (t) => {
  const item = track('abc', 90)
  const f = await pickerFixture(t, { modes: ['snippet', 'track'], initial: { ref: { kind: 'snippet', id: 'abc', start: 42 }, item } })
  let nodes = f.render()
  const editor = nodes.find((n) => n.type === 'MusicEditor')
  t.is(editor.props.item, item)
  t.is(editor.props.kind, 'snippet')
  t.is(editor.props.start, 42)
  t.is(sheetOf(nodes).props.right.props.label, 'Concluído')
  const g = await pickerFixture(t, { modes: ['snippet'], initial: { ref: { kind: 'track', id: 'abc', start: null }, item } })
  nodes = g.render()
  t.absent(nodes.some((n) => n.type === 'MusicEditor'), 'a kind outside modes starts on the search')
  const k = await pickerFixture(t, { modes: ['snippet', 'track'], initial: { ref: { kind: 'track', id: 'abc', start: null }, item } })
  nodes = k.render()
  t.is(nodes.find((n) => n.type === 'MusicEditor').props.start, 0)
  k.p.initial = { ref: { kind: 'snippet', id: 'abc', start: 5 }, item }
  nodes = k.render()
  t.is(nodes.find((n) => n.type === 'MusicEditor').props.kind, 'track', 'initial is read on opening only')
})

test('reopening from the sticker never focuses the hidden search', async (t) => {
  const item = track('abc', 90)
  const choice = { ref: { kind: 'snippet', id: 'abc', start: 42 }, item }
  const focused = (nodes) => nodes.find((n) => n.type === 'TextInput' && n.props.accessibilityLabel === 'Buscar música')
  const f = await pickerFixture(t, { modes: ['snippet', 'track'], initial: choice })
  let nodes = f.render()
  t.is(focused(nodes).props.autoFocus, false)
  t.is(nodes.find((n) => n.type === 'MusicEditor').props.start, 42)
  sheetOf(nodes).props.left.props.onPress()
  nodes = f.render()
  t.absent(nodes.some((n) => n.type === 'MusicEditor'))
  t.is(focused(nodes).props.autoFocus, false, 'backing out does not focus the search')
  f.p.open = false
  f.render()
  f.p.open = true
  nodes = f.render()
  t.is(focused(nodes).props.autoFocus, false)
  t.is(nodes.find((n) => n.type === 'MusicEditor').props.start, 42)
  const g = await pickerFixture(t, { modes: ['snippet', 'track'] })
  nodes = g.render()
  t.is(focused(nodes).props.autoFocus, true)
  t.absent(nodes.some((n) => n.type === 'MusicEditor'))
})

test('closing without Concluído picks nothing', async (t) => {
  const f = await pickerFixture(t)
  let nodes = await f.search('samba')
  previewOf(f.rows(nodes)[0]).props.onPress()
  await f.flush()
  nodes = f.render()
  mainOf(f.rows(nodes)[0]).props.onPress()
  nodes = f.render()
  const editor = nodes.find((n) => n.type === 'MusicEditor')
  let released = 0
  editor.props.stopRef.current = () => { released++ }
  const before = f.preview.filter((c) => c[0] === 'release').length
  sheetOf(nodes).props.onClose()
  t.is(released, 1, 'close releases the editor loop')
  t.ok(f.preview.filter((c) => c[0] === 'release').length >= before)
  t.is(f.closed, 1)
  t.alike(f.picks, [])
})

async function loopFixture (t, options = {}) {
  const { createSnippetLoop } = await import('../src/musicLoop.js')
  const media = await import('../src/media/chatMedia.js')
  const calls = []
  const states = []
  const players = []
  const tickets = []
  const claims = []
  const session = { member: 'a'.repeat(64), origin: 'node-origin', request: () => {} }
  const loop = createSnippetLoop({
    audiusPlay: async (id, opts) => {
      tickets.push({ id, opts })
      calls.push(['ticket', id])
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
    claimPlayback: (player, opts) => {
      claims.push({ player, opts })
      calls.push(['claim'])
      return media.claimPlayback(player, opts)
    },
    playbackEpoch: options.playbackEpoch || media.playbackEpoch,
    now: options.now
  }, session, (state) => states.push(state))
  t.teardown(loop.release)
  return { loop, calls, states, players, tickets, claims, session }
}

const flushLoop = () => new Promise((resolve) => setImmediate(resolve))
const loopCalls = (f, name) => f.calls.filter((call) => call[0] === name)

test('the editor loop reuses one ticket and one player across start changes', async (t) => {
  const { loopIdle } = await import('../src/musicLoop.js')
  t.alike(loopIdle, { phase: 'idle', ms: 0, error: '' })
  const f = await loopFixture(t)
  await f.loop.open(track(), 0)
  t.alike(f.calls.slice(0, 3), [['claim'], ['ticket', 'abc'], ['create', answer.url, { origin: answer.base }]])
  t.alike(f.tickets[0].opts, { ...f.session, signal: f.tickets[0].opts.signal })
  t.ok(f.tickets[0].opts.signal instanceof AbortSignal)
  t.is(f.states.at(-1).phase, 'loading', 'play alone does not confirm audible playback')
  f.players[0].progress({ ms: 100, playing: true, buffering: true })
  t.is(f.states.at(-1).phase, 'loading')
  f.players[0].progress({ ms: 200, playing: true, buffering: false })
  t.alike(f.states.at(-1), { phase: 'playing', ms: 200, error: '' })
  f.players[0].progress({ ms: 300, playing: true, buffering: true })
  t.alike(f.states.at(-1), { phase: 'loading', ms: 300, error: '' })
  for (const start of [10, 20, 30, 40, 100]) await f.loop.setStart(start)
  t.is(f.tickets.length, 1)
  t.is(f.players.length, 1)
  t.alike(loopCalls(f, 'seek').map((call) => call[1]), [0, 10000, 20000, 30000, 40000, 75000])
  await f.loop.open(track(), 50)
  t.is(f.tickets.length, 1, 'opening the selected item keeps its ticket')
  await f.loop.open(track('other'), 0)
  t.is(f.tickets.length, 2)
  t.is(loopCalls(f, 'release').length, 1)
})

test('start changes during a seek collapse to the latest target', async (t) => {
  const pending = []
  const f = await loopFixture(t, { seek: () => { const seek = deferred(); pending.push(seek); return seek.promise } })
  const opening = f.loop.open(track(), 10)
  await flushLoop()
  const changes = [20, 30, 40, 50, 60].map((start) => f.loop.setStart(start))
  t.alike(loopCalls(f, 'seek'), [['seek', 10000]])
  t.is(f.states.at(-1).phase, 'loading', 'a pending seek publishes loading')
  const updates = f.states.length
  f.players[0].progress({ ms: 0, playing: true, ended: true })
  t.is(f.states.length, updates, 'progress is ignored until the latest target is confirmed')
  pending[0].resolve()
  await flushLoop()
  t.alike(loopCalls(f, 'seek'), [['seek', 10000], ['seek', 60000]])
  t.is(f.states.at(-1).phase, 'loading', 'the collapsed seek stays loading until it confirms')
  t.is(loopCalls(f, 'play').length, 0)
  pending[1].resolve()
  await Promise.all([opening, ...changes])
  t.is(loopCalls(f, 'play').length, 1)
  f.players[0].progress({ ms: 61000, playing: true, buffering: false })
  t.alike(f.states.at(-1), { phase: 'playing', ms: 61000, error: '' })
  const moved = f.loop.setStart(15)
  t.alike(f.states.at(-1), { phase: 'loading', ms: 15000, error: '' })
  t.is(loopCalls(f, 'play').length, 1)
  pending.at(-1).resolve()
  await moved
})

test('a failed seek moves on to a newer start', async (t) => {
  const { MUSIC_SEEK_TEXT } = await import('../src/music.js')
  for (const failLatest of [false, true]) {
    const pending = []
    const f = await loopFixture(t, { seek: () => { const seek = deferred(); pending.push(seek); return seek.promise } })
    const opening = f.loop.open(track(), 10)
    await flushLoop()
    const moving = f.loop.setStart(30)
    pending[0].reject({ code: 'seek-range' })
    await flushLoop()
    t.alike(loopCalls(f, 'seek'), [['seek', 10000], ['seek', 30000]])
    t.absent(f.states.some((state) => state.error))
    t.is(loopCalls(f, 'release').length, 0)
    t.is(loopCalls(f, 'play').length, 0)
    if (failLatest) pending[1].reject({ code: 'seek-range' })
    else pending[1].resolve()
    await Promise.all([opening, moving])
    t.is(f.states.at(-1).error, failLatest ? MUSIC_SEEK_TEXT : '')
    t.is(f.states.at(-1).phase, failLatest ? 'idle' : 'loading')
    t.is(loopCalls(f, 'release').length, failLatest ? 1 : 0)
    t.is(loopCalls(f, 'play').length, failLatest ? 0 : 1)
    t.is(f.tickets.length, 1)
    t.is(f.players.length, 1)
    f.loop.release()
  }
})

test('a seek error reported by onError moves on to a newer start', async (t) => {
  const { MUSIC_SEEK_TEXT } = await import('../src/music.js')
  for (const failLatest of [false, true]) {
    const pending = []
    const f = await loopFixture(t, { seek: () => { const seek = deferred(); pending.push(seek); return seek.promise } })
    const opening = f.loop.open(track(), 10)
    await flushLoop()
    const moving = f.loop.setStart(30)
    f.players[0].error({ code: 'seek-timeout' })
    pending[0].reject({ code: 'seek-timeout' })
    await flushLoop()
    t.alike(loopCalls(f, 'seek'), [['seek', 10000], ['seek', 30000]])
    t.absent(f.states.some((state) => state.error))
    t.is(loopCalls(f, 'release').length, 0)
    t.is(loopCalls(f, 'play').length, 0)
    t.is(f.players[0].errors.size, 1, 'the player stays subscribed')
    if (failLatest) {
      f.players[0].error({ code: 'seek-timeout' })
      pending[1].reject({ code: 'seek-timeout' })
    } else pending[1].resolve()
    await Promise.all([opening, moving])
    t.is(f.states.at(-1).error, failLatest ? MUSIC_SEEK_TEXT : '')
    t.is(f.states.at(-1).phase, failLatest ? 'idle' : 'loading')
    t.is(loopCalls(f, 'release').length, failLatest ? 1 : 0)
    t.is(loopCalls(f, 'play').length, failLatest ? 0 : 1)
    t.is(f.players.length, 1)
    f.loop.release()
  }
})

test('a resume from pause publishes loading before the seek resolves', async (t) => {
  const pending = deferred()
  let gate = false
  const f = await loopFixture(t, { seek: () => { if (gate) return pending.promise } })
  await f.loop.open(track(), 20)
  f.players[0].progress({ ms: 21000, playing: true, buffering: false })
  await f.loop.toggle()
  t.alike(f.states.at(-1), { phase: 'paused', ms: 21000, error: '' })
  gate = true
  const resuming = f.loop.toggle()
  t.alike(f.states.at(-1), { phase: 'loading', ms: 20000, error: '' })
  t.is(loopCalls(f, 'play').length, 1)
  t.alike(loopCalls(f, 'seek').at(-1), ['seek', 20000])
  pending.resolve()
  await resuming
  t.is(loopCalls(f, 'play').length, 2)
  t.is(f.tickets.length, 1)
  t.is(f.players.length, 1)
})

test('the loop seeks back at the window end and pauses after MAX_LOOPS', async (t) => {
  const { MAX_LOOPS } = await import('../src/musicLoop.js')
  t.is(MAX_LOOPS, 8)
  const f = await loopFixture(t)
  await f.loop.open(track(), 30)
  for (let i = 0; i < MAX_LOOPS; i++) {
    f.players[0].progress({ ms: i % 2 ? 45000 : 32000, ended: i % 2 === 0 })
    await flushLoop()
    t.is(loopCalls(f, 'play').length, i + 2, 'each automatic restart plays again')
  }
  f.players[0].progress({ ms: 45000 })
  await flushLoop()
  t.is(loopCalls(f, 'play').length, MAX_LOOPS + 1, 'the first pass is additional to the eight restarts')
  t.alike(f.states.at(-1), { phase: 'paused', ms: 30000, error: '' })
  t.is(loopCalls(f, 'seek').length, MAX_LOOPS + 2, 'the final pause also returns to the start')
  t.ok(loopCalls(f, 'seek').every((call) => call[1] === 30000))
  t.is(f.tickets.length, 1)
  t.is(f.players.length, 1)
  await f.loop.toggle()
  f.players[0].progress({ ms: 45000 })
  await flushLoop()
  t.is(loopCalls(f, 'play').length, MAX_LOOPS + 3, 'a tap resets the loop allowance')
})

test('the loop cap shows paused during the seek back', async (t) => {
  const { MAX_LOOPS } = await import('../src/musicLoop.js')
  const pending = []
  let hold = false
  const f = await loopFixture(t, {
    seek: () => {
      if (!hold) return
      const seek = deferred()
      pending.push(seek)
      return seek.promise
    }
  })
  await f.loop.open(track(), 30)
  for (let i = 0; i < MAX_LOOPS; i++) {
    f.players[0].progress({ ms: 45000 })
    await flushLoop()
  }
  hold = true
  const plays = loopCalls(f, 'play').length
  f.players[0].progress({ ms: 45000 })
  t.alike(f.states.at(-1), { phase: 'paused', ms: 30000, error: '' })
  t.alike(loopCalls(f, 'seek').at(-1), ['seek', 30000])
  t.is(loopCalls(f, 'play').length, plays)
  pending[0].resolve()
  await flushLoop()
  t.alike(f.states.at(-1), { phase: 'paused', ms: 30000, error: '' })
  t.is(loopCalls(f, 'play').length, plays)
})

test('setStart resets the loop count', async (t) => {
  const { MAX_LOOPS } = await import('../src/musicLoop.js')
  const f = await loopFixture(t)
  await f.loop.open(track(), 30)
  for (let i = 0; i < MAX_LOOPS; i++) {
    f.players[0].progress({ ms: 45000 })
    await flushLoop()
  }
  await f.loop.setStart(20)
  for (let i = 0; i < MAX_LOOPS; i++) {
    f.players[0].progress({ ms: 35000 })
    await flushLoop()
  }
  t.is(loopCalls(f, 'play').length, MAX_LOOPS * 2 + 2, 'a dragged start earns another eight restarts')
  f.players[0].progress({ ms: 21000, playing: true, buffering: false })
  t.is(f.states.at(-1).phase, 'playing')
  f.players[0].progress({ ms: 35000 })
  await flushLoop()
  t.alike(f.states.at(-1), { phase: 'paused', ms: 20000, error: '' })
  t.is(loopCalls(f, 'play').length, MAX_LOOPS * 2 + 2)
})

test('an interruption outside a seek publishes paused and one tap resumes', async (t) => {
  const f = await loopFixture(t)
  await f.loop.open(track(), 20)
  f.players[0].progress({ ms: 22000, playing: true, buffering: false })
  f.players[0].progress({ ms: 23000, playing: false, buffering: false })
  t.alike(f.states.at(-1), { phase: 'paused', ms: 23000, error: '' })
  t.is(loopCalls(f, 'play').length, 1)
  t.is(loopCalls(f, 'release').length, 0)
  await f.loop.toggle()
  t.is(loopCalls(f, 'play').length, 2)
  t.is(f.tickets.length, 1)
  t.is(f.players.length, 1)
  t.alike(loopCalls(f, 'seek').at(-1), ['seek', 20000])
  t.is(f.states.at(-1).phase, 'loading')
})

test('a paused status while play is pending does not stop the snippet window', async (t) => {
  const { MAX_LOOPS } = await import('../src/musicLoop.js')
  const pending = deferred()
  const f = await loopFixture(t, { play: () => pending.promise })
  const opening = f.loop.open(track(), 20)
  await flushLoop()
  t.is(loopCalls(f, 'play').length, 1)
  f.players[0].progress({ ms: 20000, playing: false, buffering: false })
  t.alike(f.states.at(-1), { phase: 'loading', ms: 20000, error: '' })
  f.players[0].progress({ ms: 21000, playing: true, buffering: false })
  t.alike(f.states.at(-1), { phase: 'playing', ms: 21000, error: '' })
  pending.resolve()
  await opening
  for (let i = 0; i < MAX_LOOPS; i++) {
    f.players[0].progress({ ms: 40000, playing: true, buffering: false })
    await flushLoop()
    t.is(loopCalls(f, 'play').length, i + 2)
    t.alike(loopCalls(f, 'seek').at(-1), ['seek', 20000])
    f.players[0].progress({ ms: 21000, playing: true, buffering: false })
    t.is(f.states.at(-1).phase, 'playing')
  }
  f.players[0].progress({ ms: 40000, playing: true, buffering: false })
  await flushLoop()
  t.alike(f.states.at(-1), { phase: 'paused', ms: 20000, error: '' })
  t.is(loopCalls(f, 'play').length, MAX_LOOPS + 1)
  t.is(f.tickets.length, 1)
})

test('a stale paused status after play resolves does not disarm the window', async (t) => {
  const f = await loopFixture(t)
  await f.loop.open(track(), 20)
  t.is(loopCalls(f, 'play').length, 1)
  f.players[0].progress({ ms: 20000, playing: false, buffering: false })
  t.alike(f.states.at(-1), { phase: 'loading', ms: 20000, error: '' })
  f.players[0].progress({ ms: 21000, playing: true, buffering: false })
  t.alike(f.states.at(-1), { phase: 'playing', ms: 21000, error: '' })
  f.players[0].progress({ ms: 40000, playing: true, buffering: false })
  await flushLoop()
  t.alike(loopCalls(f, 'seek').at(-1), ['seek', 20000])
  t.is(loopCalls(f, 'play').length, 2)
  t.absent(f.states.some((state) => state.phase === 'paused'))
})

test('a playhead outside the window is a seek error, not a loop', async (t) => {
  const { MUSIC_SEEK_TEXT } = await import('../src/music.js')
  for (const ms of [0, NaN, Infinity]) {
    const f = await loopFixture(t)
    await f.loop.open(track(), 20)
    f.players[0].progress({ ms: 21000, playing: true, buffering: false })
    const pauses = loopCalls(f, 'pause').length
    f.players[0].progress({ ms, playing: true, buffering: false })
    await flushLoop()
    t.alike(f.states.at(-1), { phase: 'paused', ms: 20000, error: MUSIC_SEEK_TEXT })
    t.is(loopCalls(f, 'pause').length, pauses + 1)
    t.alike(loopCalls(f, 'seek'), [['seek', 20000]], 'no automatic restart seeks')
    t.is(loopCalls(f, 'play').length, 1, 'no automatic restart plays')
    t.is(f.tickets.length, 1)
    f.loop.release()
  }
})

test('an autoplay refusal waits for a tap without an error', async (t) => {
  for (const err of [{ name: 'NotAllowedError' }, { cause: { name: 'NotAllowedError' } }]) {
    let attempts = 0
    const f = await loopFixture(t, { play: () => { if (++attempts === 1) throw err } })
    await f.loop.open(track(), 20)
    t.alike(f.states.at(-1), { phase: 'paused', ms: 20000, error: '' })
    await flushLoop()
    t.is(attempts, 1)
    await f.loop.toggle()
    t.is(attempts, 2)
    t.is(f.tickets.length, 1)
    t.is(f.players.length, 1)
    f.loop.release()
  }
  const f = await loopFixture(t, { play: (player) => player.error({ code: 'play', cause: { name: 'NotAllowedError' } }) })
  await f.loop.open(track(), 20)
  t.alike(f.states.at(-1), { phase: 'paused', ms: 20000, error: '' }, 'the web stream reports play refusals through onError')
  t.is(loopCalls(f, 'release').length, 0)
})

test('a failure never mints a ticket by itself and a tap does', async (t) => {
  const { MUSIC_UNAVAILABLE_TEXT } = await import('../src/music.js')
  const f = await loopFixture(t)
  await f.loop.open(track(), 20)
  f.players[0].error({ code: 'media', message: 'untrusted provider message' })
  t.alike(f.states.at(-1), { phase: 'idle', ms: 20000, error: MUSIC_UNAVAILABLE_TEXT })
  t.is(f.players[0].listeners.size, 0)
  t.is(f.players[0].errors.size, 0)
  await f.loop.setStart(30)
  await f.loop.open(track(), 40)
  await flushLoop()
  t.is(f.tickets.length, 1)
  await f.loop.toggle()
  t.is(f.tickets.length, 2)
  t.is(f.players.length, 2)
  t.alike(loopCalls(f, 'seek').at(-1), ['seek', 40000])
})

test('release aborts a pending ticket and a late answer stays silent', async (t) => {
  for (const reject of [false, true]) {
    const ticket = deferred()
    const f = await loopFixture(t, { ticket: () => ticket.promise })
    const opening = f.loop.open(track(), 0)
    f.loop.release()
    const updates = f.states.length
    t.ok(f.tickets[0].opts.signal.aborted)
    if (reject) ticket.reject(new Error('late failure'))
    else ticket.resolve(answer)
    await opening
    t.is(f.states.length, updates)
    t.is(f.players.length, 0)
    t.is(loopCalls(f, 'play').length, 0)
  }
})

test('a pending open gives way when another player claims playback', async (t) => {
  const { claimPlayback } = await import('../src/media/chatMedia.js')
  const ticket = deferred()
  const f = await loopFixture(t, { ticket: () => ticket.promise })
  const opening = f.loop.open(track(), 0)
  t.ok(f.claims[0].opts.bound)
  t.not(f.claims[0].player.pause, f.loop.stop)
  const unclaim = claimPlayback({ pause () {} })
  t.teardown(unclaim)
  t.ok(f.tickets[0].opts.signal.aborted)
  t.is(f.states.at(-1).phase, 'idle')
  ticket.resolve(answer)
  await opening
  t.is(f.players.length, 0)
  t.is(loopCalls(f, 'play').length, 0)
})

test('a lost claim aborts a pending ticket and never starts audio', async (t) => {
  const ticket = deferred()
  const f = await loopFixture(t, { ticket: () => ticket.promise })
  const opening = f.loop.open(track(), 20)
  f.claims[0].player.pause()
  const updates = f.states.length
  t.ok(f.tickets[0].opts.signal.aborted)
  ticket.resolve(answer)
  await opening
  t.is(f.states.length, updates)
  t.is(f.players.length, 0)
  await f.loop.toggle()
  t.is(f.claims.length, 2)
  t.is(f.tickets.length, 2)
  t.is(loopCalls(f, 'play').length, 1)
})

test('a lost claim whose ticket request rejects shows no error', async (t) => {
  const { claimPlayback } = await import('../src/media/chatMedia.js')
  const ticket = deferred()
  let requests = 0
  const f = await loopFixture(t, { ticket: () => ++requests === 1 ? ticket.promise : answer })
  const opening = f.loop.open(track(), 20)
  const unclaim = claimPlayback({ pause () {} })
  t.teardown(unclaim)
  t.ok(f.tickets[0].opts.signal.aborted)
  const updates = f.states.length
  ticket.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  await opening
  t.is(f.states.length, updates)
  t.alike(f.states.at(-1), { phase: 'idle', ms: 20000, error: '' })
  t.is(f.players.length, 0)
  t.is(f.tickets.length, 1)
  await f.loop.toggle()
  t.is(f.claims.length, 2)
  t.is(f.tickets.length, 2)
  t.absent(f.tickets[1].opts.signal.aborted)
  t.is(f.players.length, 1)
  t.is(loopCalls(f, 'play').length, 1)
  t.is(f.states.at(-1).error, '')
})

test('a stream error while the claim is lost releases the player and the next tap opens again', async (t) => {
  const { MUSIC_UNAVAILABLE_TEXT } = await import('../src/music.js')
  const f = await loopFixture(t)
  await f.loop.open(track(), 20)
  f.players[0].progress({ ms: 21000, playing: true, buffering: false })
  f.claims[0].player.pause()
  t.is(f.states.at(-1).phase, 'paused')
  f.players[0].error({ code: 'media', message: 'untrusted provider message' })
  t.alike(f.states.at(-1), { phase: 'idle', ms: 20000, error: MUSIC_UNAVAILABLE_TEXT })
  t.is(loopCalls(f, 'release').length, 1)
  t.is(f.players[0].listeners.size, 0)
  t.is(f.players[0].errors.size, 0)
  t.is(f.tickets.length, 1)
  await f.loop.toggle()
  t.is(f.tickets.length, 2)
  t.is(f.players.length, 2)
  t.is(loopCalls(f, 'play').length, 2)
  t.alike(loopCalls(f, 'seek').at(-1), ['seek', 20000])
})

test('a seek-range rejection shows the seek error while superseded stays silent', async (t) => {
  const { MUSIC_SEEK_TEXT } = await import('../src/music.js')
  for (const code of ['seek-range', 'seek', 'seek-timeout', 'unknown', 'superseded', 'released']) {
    const f = await loopFixture(t, { seek: () => { throw Object.assign(new Error('provider message'), { code }) } })
    await f.loop.open(track(), 20)
    t.alike(f.states.at(-1), { phase: 'idle', ms: 20000, error: ['superseded', 'released'].includes(code) ? '' : MUSIC_SEEK_TEXT }, code)
    t.is(loopCalls(f, 'play').length, 0)
    t.is(loopCalls(f, 'release').length, 1)
    await flushLoop()
    t.is(f.tickets.length, 1)
  }
})

test('stop keeps the ticket and a paused start change never resumes playback', async (t) => {
  const f = await loopFixture(t)
  await f.loop.open(track(), 10)
  f.players[0].progress({ ms: 12000, playing: true, buffering: false })
  await f.loop.toggle()
  t.is(f.states.at(-1).phase, 'paused')
  await f.loop.setStart(30)
  t.alike(f.states.at(-1), { phase: 'paused', ms: 30000, error: '' })
  t.is(loopCalls(f, 'play').length, 1)
  t.is(loopCalls(f, 'release').length, 0)
  t.absent(f.tickets[0].opts.signal.aborted)
  await f.loop.toggle()
  t.is(loopCalls(f, 'play').length, 2)
  t.is(f.tickets.length, 1)
})

test('stopping a pending ticket keeps it and a tap resumes that same request', async (t) => {
  for (const resume of [false, true]) {
    const ticket = deferred()
    const f = await loopFixture(t, { ticket: () => ticket.promise })
    const opening = f.loop.open(track(), 10)
    f.loop.stop()
    t.absent(f.tickets[0].opts.signal.aborted)
    await f.loop.setStart(20)
    if (resume) await f.loop.toggle()
    t.is(f.tickets.length, 1)
    ticket.resolve(answer)
    await opening
    t.is(loopCalls(f, 'play').length, resume ? 1 : 0)
    t.alike(loopCalls(f, 'seek'), [['seek', 20000]])
    t.is(f.players.length, 1)
    f.loop.release()
  }
})

test('stopping during a seek prevents playback after its confirmation', async (t) => {
  const seek = deferred()
  const f = await loopFixture(t, { seek: () => seek.promise })
  const opening = f.loop.open(track(), 20)
  await flushLoop()
  f.loop.stop()
  seek.resolve()
  await opening
  t.alike(f.states.at(-1), { phase: 'paused', ms: 20000, error: '' })
  t.is(loopCalls(f, 'play').length, 0)
  t.is(loopCalls(f, 'release').length, 0)
  await f.loop.toggle()
  t.is(loopCalls(f, 'play').length, 1)
  t.is(f.tickets.length, 1)
})

test('editor stream errors preserve the preview error rules while seeking', async (t) => {
  const { MUSIC_UNAVAILABLE_TEXT, MUSIC_SEEK_TEXT } = await import('../src/music.js')
  for (const code of ['media', 'load-timeout', 'seek', 'seek-timeout']) {
    const seek = deferred()
    const f = await loopFixture(t, { seek: () => seek.promise })
    const opening = f.loop.open(track(), 30)
    await flushLoop()
    const seekCoded = code === 'seek' || code === 'seek-timeout'
    f.players[0].error({ code })
    if (seekCoded) {
      t.is(f.states.at(-1).error, '', code)
      seek.reject({ code })
    } else {
      t.is(f.states.at(-1).error, MUSIC_UNAVAILABLE_TEXT, code)
      seek.resolve()
    }
    await opening
    t.is(f.states.at(-1).error, seekCoded ? MUSIC_SEEK_TEXT : MUSIC_UNAVAILABLE_TEXT, code)
    t.is(loopCalls(f, 'play').length, 0)
  }
})

test('a lost claim during seek needs a fresh claim and keeps seeks serialized', async (t) => {
  const { claimPlayback, playbackEpoch } = await import('../src/media/chatMedia.js')
  const seek = deferred()
  let seeks = 0
  const f = await loopFixture(t, { seek: () => { if (++seeks === 1) return seek.promise } })
  const opening = f.loop.open(track(), 10)
  await flushLoop()
  let otherPauses = 0
  const unclaim = claimPlayback({ pause () { otherPauses++ } })
  t.teardown(unclaim)
  t.is(f.states.at(-1).phase, 'paused')
  const tapping = f.loop.toggle()
  t.is(otherPauses, 1)
  t.is(f.claims.at(-1).opts.epoch, playbackEpoch())
  t.is(seeks, 1)
  seek.resolve()
  await Promise.all([opening, tapping])
  t.is(seeks, 2)
  t.is(loopCalls(f, 'play').length, 1)
  t.is(f.tickets.length, 1)
  t.is(f.players.length, 1)
})

test('a lost seek and a released seek cannot play after they resolve', async (t) => {
  for (const release of [false, true]) {
    const seek = deferred()
    const f = await loopFixture(t, { seek: () => seek.promise })
    const opening = f.loop.open(track(), 10)
    await flushLoop()
    if (release) f.loop.release()
    else f.claims[0].player.pause()
    const updates = f.states.length
    seek.resolve()
    await opening
    t.is(loopCalls(f, 'play').length, 0)
    t.is(f.states.length, updates)
    if (release) {
      t.is(f.players[0].listeners.size, 0)
      t.is(f.players[0].errors.size, 0)
    }
  }
})

test('expired editor tickets renew only on a tap and pass their base to the player', async (t) => {
  let now = 0
  const base = 'https://account.example'
  const url = base + answer.url
  const expiresAt = '2026-01-01T00:00:00Z'
  const f = await loopFixture(t, { ticket: () => ({ url, base, expiresAt }), now: () => now })
  await f.loop.open(track(), 0)
  t.alike(loopCalls(f, 'create')[0], ['create', url, { origin: base }])
  now = Date.parse(expiresAt)
  await f.loop.setStart(30)
  f.players[0].progress({ ms: 45000 })
  await flushLoop()
  t.is(f.tickets.length, 1)
  f.loop.stop()
  await f.loop.toggle()
  t.is(f.tickets.length, 2)
  t.is(loopCalls(f, 'release').length, 1)
})

test('an obsolete playback epoch disposes the editor job before audio starts', async (t) => {
  const { playbackEpoch } = await import('../src/media/chatMedia.js')
  let epoch = playbackEpoch()
  const seek = deferred()
  const f = await loopFixture(t, { playbackEpoch: () => epoch, seek: () => seek.promise })
  const opening = f.loop.open(track(), 10)
  await flushLoop()
  epoch++
  seek.resolve()
  await opening
  t.is(loopCalls(f, 'play').length, 0)
  t.is(loopCalls(f, 'release').length, 1)
  t.is(f.states.at(-1).phase, 'idle')
  t.ok(f.tickets[0].opts.signal.aborted)
})

test('editor progress timers respect buffering, short tracks, stop and release', async (t) => {
  const f = await loopFixture(t)
  await f.loop.open(track('short', 7), 30)
  const timers = new Map()
  let serial = 0
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  globalThis.setTimeout = (fn, ms) => { timers.set(++serial, { fn, ms }); return serial }
  globalThis.clearTimeout = (id) => timers.delete(id)
  try {
    const player = f.players[0]
    player.progress({ ms: 2000, playing: true, buffering: false })
    t.is([...timers.values()][0].ms, 5000)
    player.progress({ ms: 3000, playing: true, buffering: true })
    t.is(timers.size, 0)
    player.progress({ ms: 6000, playing: true, buffering: false })
    const timer = [...timers.values()][0]
    t.is(timer.ms, 1000)
    timer.fn()
    await flushLoop()
    t.is(timers.size, 0)
    t.alike(loopCalls(f, 'seek'), [['seek', 0], ['seek', 0]])
    t.is(loopCalls(f, 'play').length, 2)
    player.progress({ ms: 1000, playing: true, buffering: false })
    f.loop.stop()
    t.is(timers.size, 0)
    await f.loop.toggle()
    player.progress({ ms: 1000, playing: true, buffering: false })
    const lateTimer = [...timers.values()][0]
    f.loop.release()
    const updates = f.states.length
    const calls = f.calls.length
    t.is(timers.size, 0)
    lateTimer.fn()
    await flushLoop()
    t.is(f.states.length, updates)
    t.is(f.calls.length, calls)
    t.is(f.tickets.length, 1)
  } finally {
    f.loop.release()
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
  }
})

test('the editor loop is a pure module with only the shared music imports', (t) => {
  const code = fs.readFileSync(path.join(__dirname, '../src/musicLoop.js'), 'utf8')
  t.absent(/react|fetch\(|\u2014/.test(code))
  t.alike(code.match(/^import .+$/gm), ["import { clampStart, snippetEndMs, snippetTick, seekReached, musicErrorText, MUSIC_SEEK_TEXT } from './music.js'"])
})

// MusicStrip with React Native, the theme and the haptics replaced by doubles.
async function stripUi (stubs = {}) {
  const { transformSync } = require('@babel/core')
  const music = await import('../src/music.js')
  const strip = await import('../src/musicStrip.js')
  const web = await import('../src/ui/musicKeys.web.js')
  const slots = []
  let cursor, dirty, effects
  const changed = (prev, deps) => !prev || !deps || deps.some((value, i) => value !== prev.deps[i])
  const useState = (initial) => {
    const at = cursor++
    if (!(at in slots)) slots[at] = initial
    return [slots[at], (next) => { if (slots[at] !== next) { slots[at] = next; dirty = true } }]
  }
  class Value {
    constructor (v) { this.value = v; this.sets = [] }
    setValue (v) { this.value = v; this.sets.push(v) }
  }
  const timings = []
  const taps = []
  let created = null
  const deps = {
    ...music,
    ...strip,
    stepKeyProps: web.stepKeyProps,
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) },
    useState,
    useRef: (initial) => useState({ current: initial })[0],
    useMemo: (fn, d) => {
      const at = cursor++
      if (changed(slots[at], d)) slots[at] = { deps: d, value: fn() }
      return slots[at].value
    },
    useEffect: (fn, d) => {
      const at = cursor++
      if (!changed(slots[at], d)) return
      const old = slots[at]
      const entry = slots[at] = { deps: d }
      effects.push(() => { old?.cleanup?.(); entry.cleanup = fn() })
    },
    Animated: {
      Value,
      View: 'Animated.View',
      timing: (value, config) => ({ start: () => { timings.push(config.toValue); value.value = config.toValue } })
    },
    Easing: { linear: (x) => x },
    PanResponder: { create: (config) => { created = config; return { panHandlers: {} } } },
    AccessibilityInfo: { isReduceMotionEnabled: () => Promise.resolve(false) },
    StyleSheet: { create: (value) => value },
    useStyles: (make) => make({ accent: 'accent', line: 'line', soft: 'soft' }),
    useTheme: () => ({ colors: { accent: 'accent', line: 'line', soft: 'soft' } }),
    radius: { sm: 4 },
    tap: (kind) => taps.push(kind),
    Text: 'Text',
    View: 'View',
    ...stubs
  }
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/MusicStrip.js'), 'utf8')
  const input = src.replace(/^import .+\n/gm, '').replace(/\bexport /g, '')
  const { code } = transformSync(input, { configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-react-jsx'] })
  // eslint-disable-next-line no-new-func
  const { MusicStrip } = new Function(...Object.keys(deps), code + '\nreturn { MusicStrip }')(...Object.values(deps))
  function render (props) {
    let tree
    do {
      dirty = false
      effects = []
      cursor = 0
      tree = MusicStrip(props)
      for (const effect of effects) effect()
    } while (dirty)
    return tree
  }
  return { render, timings, taps, responder: () => created }
}

function stripProps (over = {}) {
  const changes = []
  const commits = []
  return { changes, commits, props: { id: 'abc', duration: 190, start: 42, progress: null, onChange: (v) => changes.push(v), onCommit: (v) => commits.push(v), ...over } }
}

const layout = (root, width) => root.props.onLayout({ nativeEvent: { layout: { width } } })

test('the strip is adjustable with times as its value', async (t) => {
  const h = await stripUi()
  const { props } = stripProps()
  const root = h.render(props)
  t.is(root.props.accessible, true)
  t.is(root.props.accessibilityRole, 'adjustable')
  t.is(root.props.accessibilityLabel, 'Início do trecho')
  t.alike(root.props.accessibilityValue, { min: 0, max: 175, now: 42, text: 'De 0:42 a 0:57' })
  t.is(root.props['aria-valuemin'], 0)
  t.is(root.props['aria-valuemax'], 175)
  t.is(root.props['aria-valuenow'], 42)
  t.is(root.props['aria-valuetext'], 'De 0:42 a 0:57')
  t.alike(root.props.accessibilityActions.map((a) => a.name), ['increment', 'decrement'])
  const clock = flatten(root).find((n) => n.type === 'Text')
  t.alike(clock.children, ['0:42'])
  t.ok(clock.props.accessibilityElementsHidden)
})

test('increment and decrement step one second and commit', async (t) => {
  const h = await stripUi()
  const { props, changes, commits } = stripProps()
  const root = h.render(props)
  root.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } })
  root.props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } })
  t.alike(changes, [43, 41])
  t.alike(commits, [43, 41])
  const top = h.render({ ...props, start: 175 })
  top.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } })
  t.is(changes.at(-1), 175, 'clamped at the end')
})

test('web keys step, Home and End jump, native has no key handler', async (t) => {
  const web = await import('../src/ui/musicKeys.web.js')
  const native = await import('../src/ui/musicKeys.native.js')
  const got = []
  const keys = web.stepKeyProps((v) => got.push(v))
  t.is(keys.tabIndex, 0)
  let prevented = 0
  const press = (key) => keys.onKeyDown({ key, preventDefault: () => prevented++, stopPropagation: () => {} })
  for (const key of ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End', 'Tab']) press(key)
  t.alike(got, [-1, -1, 1, 1, 'min', 'max'])
  t.is(prevented, 6, 'Tab is left alone')
  t.alike(native.stepKeyProps(() => {}), {})

  const h = await stripUi()
  const { props, changes, commits } = stripProps()
  const root = h.render(props)
  root.props.onKeyDown({ key: 'End', preventDefault () {}, stopPropagation () {} })
  root.props.onKeyDown({ key: 'Home', preventDefault () {}, stopPropagation () {} })
  t.alike(changes, [175, 0])
  t.alike(commits, [175, 0])
})

test('a drag to the left starts later and commits once on release', async (t) => {
  const h = await stripUi()
  const { props, changes, commits } = stripProps()
  layout(h.render(props), 300)
  const strip = () => flatten(h.render(props)).find((n) => n.type === 'Animated.View').props.style[1].transform[0].translateX
  const translate = strip()
  const origin = translate.value
  const r = h.responder()
  t.ok(r.onStartShouldSetPanResponder())
  r.onPanResponderGrant()
  r.onPanResponderMove({}, { dx: -40 })
  t.is(translate.value, origin - 40)
  r.onPanResponderMove({}, { dx: -41 })
  t.alike(changes, [47], 'one change per whole second')
  h.render({ ...props, start: 47 })
  t.is(translate.value, origin - 41, 'a re-render mid drag keeps the strip under the finger')
  r.onPanResponderRelease()
  r.onPanResponderTerminate()
  t.alike(commits, [47])
  t.alike(h.taps, ['select'])

  const short = await stripUi()
  short.render(stripProps({ duration: 10 }).props)
  t.absent(short.responder().onStartShouldSetPanResponder(), 'no drag when nothing can move')
})

test('a 7200 s track renders at most 200 bars', async (t) => {
  const h = await stripUi()
  const { props } = stripProps({ duration: 7200, start: 3000 })
  layout(h.render(props), 2000)
  const nodes = flatten(h.render(props))
  const strip = nodes.find((n) => n.type === 'Animated.View')
  t.ok(strip.children.length > 0)
  t.ok(strip.children.length <= 200)
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/MusicStrip.js'), 'utf8')
  t.absent(/Platform\.OS|fetch\(|\u2014/.test(src))
  t.ok(src.includes('PanResponder.create('))
})
