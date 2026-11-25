'use strict'

// Avatar rules (src/media/avatar.js): descriptor checks, the still-image
// header check and the verified load, with fetch and WebCrypto injected (no
// network).
const test = require('brittle')
const { createHash, webcrypto } = require('node:crypto')
const load = () => import('../src/media/avatar.js')

function compileAvatarUI (file, modules, globals = {}) {
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const { transformSync } = require('@babel/core')
  const { runInNewContext } = require('node:vm')
  const { code } = transformSync(readFileSync(join(__dirname, '../src/ui', file), 'utf8'), {
    configFile: false,
    babelrc: false,
    plugins: [
      ['@babel/plugin-transform-react-jsx', { runtime: 'automatic' }],
      ['@babel/plugin-transform-modules-commonjs', { noInterop: true }]
    ]
  })
  const exports = {}
  runInNewContext(code, {
    ...globals,
    exports,
    require (name) {
      if (!Object.hasOwn(modules, name)) throw new Error('Unexpected import: ' + name)
      return modules[name]
    }
  })
  return exports
}

async function avatarUI ({ keptOnly = false, keptHit = null, dropped = true, hosted = true, identity = '34'.repeat(32), node, read, source } = {}) {
  const avatar = await load()
  const { avatarColorOf } = await import('../src/format.js')
  const { stripes } = compileAvatarUI('theme.js', { 'react-native': { Platform: { select: (choices) => choices.default } } })
  const { createMediaCache, retryDelay } = await import('../src/media/cache.js')
  const { loadKept } = await import('../src/media/keptLoad.js')
  const { createChatMedia, chatMediaKey } = await import('../src/media/chatMedia.js')
  const groupImage = await import('../src/groupImage.js')
  const bytes = jpeg(512, 512)
  const io = deps(response(bytes))
  const calls = { keys: [], kept: [], keep: [], sources: [], reads: [], fetchBytes: [], display: [], pins: [], unpins: [], forgets: [], drops: [] }
  const display = {
    revokeUrl () {},
    urlFromBytes (...args) {
      calls.display.push(args)
      return io.urlFromBytes(...args)
    }
  }
  if (node === undefined) {
    node = {
      media: {
        async read (ref) {
          calls.reads.push(ref)
          return read ? read(ref) : { bytes: jpeg(512, 512), mime: 'image/jpeg' }
        }
      }
    }
  }
  const chat = createChatMedia({ fetch: () => { throw new Error('Unexpected public fetch') } })
  // Loads in flight: render awaits them, since a SHA-256 on Node 20 can
  // finish after a single setImmediate.
  const loads = []
  const state = []
  const timers = new Map()
  let now = 0
  let timerId = 0
  const effectState = []
  let cursor = 0
  let effectCursor = 0
  let effects = []
  const element = (type, props, key) => ({ type, props, key })
  const cache = createMediaCache({ max: 8, concurrency: 1, revoke () {} })
  const keptUrl = (...args) => { calls.kept.push(args); return keptOnly ? 'file:///kept/avatar.jpg' : keptHit }
  const modules = {
    react: {
      useContext: () => keptOnly,
      useMemo: (fn) => fn(),
      useRef (value) {
        const i = cursor++
        if (!(i in state)) state[i] = { current: value }
        return state[i]
      },
      useState (init) {
        const i = cursor++
        if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
        return [state[i], (value) => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
      },
      useEffect (fn, deps) {
        const i = effectCursor++
        const previous = effectState[i]
        if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return
        effects.push(() => {
          if (previous && previous.cleanup) previous.cleanup()
          effectState[i] = { deps, cleanup: fn() }
        })
      }
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'expo/fetch': { fetch: io.fetch },
    'react-native': { Image: 'Image', Text: 'Text', View: 'View', StyleSheet: { create: (s) => s, absoluteFillObject: {} } },
    '@varanda/rpc': require('@varanda/rpc'),
    '../node': { useHosted: () => hosted, useMemberKey: () => identity, useNodeHandle: () => node },
    '../groupImage': groupImage,
    '../format': { avatarColorOf },
    '../media/avatar': {
      ...avatar,
      fetchAvatarBytes (...args) {
        calls.fetchBytes.push(args)
        return avatar.fetchAvatarBytes(...args)
      }
    },
    '../media/chatMedia': {
      chatMediaKey,
      onChatMediaReturn: () => () => {},
      pinChatMedia (uri) {
        const pin = calls.pins.length
        calls.pins.push(uri)
        return () => calls.unpins.push(pin)
      },
      sourceFor (ref, ctx) {
        calls.sources.push({ ref, ctx })
        const pending = source ? source(ref, ctx) : chat.sourceFor(ref, ctx)
        loads.push(pending)
        return pending
      }
    },
    '../media/cache': {
      createMediaCache: () => ({
        peek: (key) => cache.peek(key),
        get: (key, loader) => {
          calls.keys.push(key)
          const load = cache.get(key, loader)
          loads.push(load)
          return load
        },
        forget: (key, url) => {
          calls.forgets.push([key, url])
          return cache.forget(key, url)
        }
      }),
      retryDelay
    },
    '../media/display': display,
    '../media/keep': { keptUrl, keep: async (...args) => { calls.keep.push(args) }, dropKept: (uri) => { calls.drops.push(uri); return dropped } },
    '../media/keptLoad': { loadKept, registerKeptStore () {} },
    '../localCaches': { cacheGeneration: () => 0 },
    '../appClient': { isAppClient: () => true },
    './Icon': { Icon: 'Icon' },
    './MediaView': { KeptOnlyContext: {}, keptOnlyUrl: keptUrl, mediaHashDeps: () => ({ subtle: webcrypto.subtle }) },
    './theme': { stripes },
    './ThemeProvider': { useTheme: () => ({ colors: {} }) }
  }
  const { Avatar, avatarErrorStep } = compileAvatarUI('Avatar.js', modules, {
    setTimeout (fn, delay) {
      const id = ++timerId
      timers.set(id, { fn, at: now + delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id)
  })
  const render = (props) => {
    cursor = 0
    effectCursor = 0
    effects = []
    const tree = Avatar(props)
    for (const effect of effects) effect()
    return tree
  }
  return {
    calls,
    avatarErrorStep,
    node,
    identity,
    display,
    io,
    avatar,
    stripes,
    avatarColorOf,
    get pendingTimers () { return timers.size },
    advance (ms) {
      now += ms
      for (const [id, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.fn()
      }
    },
    picture: descriptor(bytes),
    // One render pass with its effects, before any load settles.
    renderNow: (props) => render(props),
    async render (props) {
      render(props)
      await Promise.allSettled(loads.splice(0))
      await new Promise((resolve) => setImmediate(resolve))
      return render(props)
    },
    unmount () {
      for (const effect of effectState.splice(0)) {
        if (effect.cleanup) effect.cleanup()
      }
    },
    // A new mount of the same module (its caches and run state stay).
    remount () {
      this.unmount()
      state.length = 0
    }
  }
}

test('Avatar uses the media author for fetch, cache and kept copy while retaining the group stripe', async (t) => {
  const ui = await avatarUI()
  const group = '12'.repeat(32)
  const tree = await ui.render({ name: 'Grupo', publicKey: group, mediaAuthor: AUTHOR, picture: ui.picture, persist: true })
  t.is(ui.io.calls[0].url, '/media/' + AUTHOR + '/' + ui.picture.core + '/1/1')
  t.alike(ui.calls.keys, [ui.avatar.avatarKey(AUTHOR, ui.picture)])
  t.is(ui.calls.kept[0][1], AUTHOR)
  t.is(ui.calls.keep[0][1], AUTHOR)
  t.is(tree.props.style[1].backgroundColor, ui.stripes[ui.avatarColorOf(group)].bg)
  t.not(ui.avatarColorOf(group), ui.avatarColorOf(AUTHOR), 'distinct stripes exercise both identities')
  t.is(tree.props.children[1].props.source.uri, 'blob:test/image/jpeg')
})

test('Avatar profiles still default to their public key', async (t) => {
  const ui = await avatarUI()
  const tree = await ui.render({ publicKey: AUTHOR, picture: ui.picture })
  t.is(ui.io.calls[0].url, '/media/' + AUTHOR + '/' + ui.picture.core + '/1/1')
  t.alike(ui.calls.keys, [ui.avatar.avatarKey(AUTHOR, ui.picture)])
  t.is(ui.calls.sources.length, 0, 'public avatars never enter chat media')
  t.is(tree.props.style[1].backgroundColor, ui.stripes[ui.avatarColorOf(AUTHOR)].bg)
})

test('Avatar pins the drawn private URI until item change or unmount', async (t) => {
  for (const scheme of ['blob:', 'file:///']) {
    const ui = await avatarUI({
      source: async (ref) => ({ uri: scheme + ref.item.start + '.jpg', mime: 'image/jpeg', w: 512, h: 512 })
    })
    const props = { mediaAuthor: AUTHOR, privateItem: privateImage() }
    const first = await ui.render(props)
    const firstUri = first.props.children[1].props.source.uri
    t.alike(ui.calls.pins, [firstUri], 'pins the URI drawn by Image')
    t.alike(ui.calls.unpins, [], 'keeps the mounted photo pinned')
    await ui.render(props)
    t.alike(ui.calls.pins, [firstUri], 'a rerender does not pin again')
    t.alike(ui.calls.unpins, [])
    const second = await ui.render({ ...props, privateItem: { ...props.privateItem, start: 2 } })
    const secondUri = second.props.children[1].props.source.uri
    t.not(firstUri, secondUri)
    t.alike(ui.calls.pins, [firstUri, secondUri], 'pins the replacement photo')
    t.alike(ui.calls.unpins, [0], 'releases the previous pin exactly once')
    ui.unmount()
    t.alike(ui.calls.unpins, [0, 1], 'unmount releases the remaining pin exactly once')
  }
})

test('Avatar never pins public photos', async (t) => {
  for (const keptOnly of [false, true]) {
    const ui = await avatarUI({ keptOnly })
    const props = { publicKey: AUTHOR, picture: ui.picture }
    await ui.render(props)
    await ui.render({ ...props, localUri: 'blob:preview' })
    ui.unmount()
    t.alike(ui.calls.pins, [])
    t.alike(ui.calls.unpins, [])
  }
})

test('Avatar retries a transient private read and pins the recovered image', async (t) => {
  let available = false
  const ui = await avatarUI({
    read: () => {
      if (!available) throw new Error('blocks not replicated')
      return { bytes: jpeg(512, 512), mime: 'image/jpeg' }
    }
  })
  const props = { name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: privateImage() }
  const first = await ui.render(props)
  t.is(first.props.children[0].props.children, 'GP')
  t.is(first.props.children[1], false)
  t.is(ui.calls.reads.length, 1)
  t.is(ui.pendingTimers, 1)
  available = true
  ui.advance(1999)
  await ui.render({ ...props, privateItem: { ...props.privateItem } })
  t.is(ui.calls.reads.length, 1, 'a refreshed row waits for the retry delay')
  ui.advance(1)
  const recovered = await ui.render(props)
  t.is(ui.calls.reads.length, 2, 'the same item reads again')
  t.is(recovered.props.children[1] && recovered.props.children[1].props.source.uri, 'blob:test/image/jpeg')
  t.alike(ui.calls.pins, ['blob:test/image/jpeg'])
  t.is(ui.pendingTimers, 0)
  ui.unmount()
  t.alike(ui.calls.unpins, [0], 'the recovered image is unpinned exactly once')
})

test('Avatar never retries final private failures or invalid items', async (t) => {
  for (const invalid of [false, true]) {
    const ui = await avatarUI({ read: () => { throw new TypeError('invalid ref') } })
    const props = { name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: invalid ? {} : privateImage() }
    await ui.render(props)
    ui.advance(120000)
    const tree = await ui.render({ ...props, privateItem: { ...props.privateItem } })
    t.is(tree.props.children[0].props.children, 'GP')
    t.is(tree.props.children[1], false)
    t.is(ui.calls.reads.length, invalid ? 0 : 1)
    t.is(ui.calls.sources.length, invalid ? 0 : 1)
    t.is(ui.pendingTimers, 0)
    ui.unmount()
  }
})

test('Avatar bounds private retries across refreshes of the same item', async (t) => {
  const ui = await avatarUI({ read: () => { throw new Error('node unavailable') } })
  const props = { mediaAuthor: AUTHOR, privateItem: privateImage() }
  await ui.render(props)
  let reads = 1
  for (const delay of [2000, 5000, 15000, 30000, 60000]) {
    t.is(ui.pendingTimers, 1, 'one retry scheduled')
    ui.advance(delay - 1)
    await ui.render({ ...props, privateItem: { ...props.privateItem } })
    t.is(ui.calls.reads.length, reads, 'no early retry')
    ui.advance(1)
    const tree = await ui.render(props)
    t.is(ui.calls.reads.length, ++reads)
    t.is(tree.props.children[1], false)
  }
  ui.advance(120000)
  await ui.render({ ...props, privateItem: { ...props.privateItem } })
  t.is(ui.calls.reads.length, 6, 'initial read plus five retries')
  t.is(ui.pendingTimers, 0, 'the retry budget is exhausted')
  t.alike(ui.calls.pins, [])
  ui.unmount()
})

test('Avatar cancels private retries on item change and unmount', async (t) => {
  const ui = await avatarUI({ read: () => { throw new Error('node unavailable') } })
  const props = { mediaAuthor: AUTHOR, privateItem: privateImage() }
  await ui.render(props)
  t.is(ui.pendingTimers, 1)
  await ui.render({ ...props, privateItem: {} })
  t.is(ui.pendingTimers, 0, 'an invalid replacement cancels the retry')
  ui.advance(120000)
  await ui.render({ ...props, privateItem: {} })
  t.is(ui.calls.reads.length, 1)
  await ui.render({ ...props, privateItem: { ...props.privateItem, start: 2 } })
  t.is(ui.calls.reads.length, 2)
  t.is(ui.pendingTimers, 1, 'a new item has its own retry budget')
  ui.unmount()
  t.is(ui.pendingTimers, 0, 'unmount cancels the retry')
})

test('Avatar opens private images with the author diary and member context without keeping or fetching', async (t) => {
  for (const hosted of [false, true]) {
    for (const keptOnly of [false, true]) {
      const ui = await avatarUI({ hosted, keptOnly })
      const item = privateImage()
      const tree = await ui.render({ name: 'Grupo privado', publicKey: '12'.repeat(32), mediaAuthor: AUTHOR, privateItem: item, persist: true })
      t.is(tree.props.children[1].props.source.uri, 'blob:test/image/jpeg')
      t.is(ui.calls.sources.length, 1)
      const { ref, ctx } = ui.calls.sources[0]
      t.alike({ ...ref }, { kind: 'group', diary: AUTHOR, item })
      t.is(ctx.node, ui.node)
      t.is(ctx.identity, ui.identity)
      t.is(ctx.display, ui.display)
      t.not(ctx.identity, AUTHOR, 'the reader is distinct from the media author')
      t.alike(ui.calls.reads, [{ kind: 'group', diary: AUTHOR, item }])
      t.is(ui.calls.display.length, 1)
      t.is(ui.calls.display[0][1], 'image/jpeg')
      t.alike(ui.calls.fetchBytes, [])
      t.alike(ui.calls.keys, [])
      t.alike(ui.calls.kept, [])
      t.alike(ui.calls.keep, [])
      t.alike(ui.io.calls, [])
    }
  }
})

test('Avatar refuses invalid private items, missing context and conflicting public pictures', async (t) => {
  const item = privateImage()
  const cases = [
    ...[{}, [], 'bad', false, descriptor(jpeg(512, 512)), { ...item, key: null }, { ...item, extra: true }, { ...item, plainMime: 'image/png' }]
      .map((privateItem) => ({ props: { privateItem } })),
    { props: { mediaAuthor: null } },
    { props: { mediaAuthor: 'bad' } },
    { props: { picture: descriptor(jpeg(512, 512)) } },
    { identity: null },
    { identity: 'bad' },
    { node: null },
    { node: { media: {} } }
  ]
  for (const options of cases) {
    const ui = await avatarUI(options)
    const tree = await ui.render({ name: 'Grupo privado', publicKey: '12'.repeat(32), mediaAuthor: AUTHOR, privateItem: item, localUri: 'blob:preview', persist: true, ...options.props })
    t.is(tree.props.children[0].props.children, 'GP')
    t.is(tree.props.children[1], false)
    t.alike(ui.calls.sources, [])
    t.alike(ui.calls.fetchBytes, [])
    t.alike(ui.calls.kept, [])
    t.alike(ui.calls.keep, [])
    t.alike(ui.io.calls, [])
  }
})

test('Avatar leaves initials for failed opens and plaintext that is not a square 512 JPEG', async (t) => {
  const cases = [
    { read: () => { throw new Error('indisponível') } },
    { read: () => null },
    { read: () => ({ bytes: jpeg(511, 512), mime: 'image/jpeg' }) },
    { read: () => ({ bytes: jpeg(512, 513), mime: 'image/jpeg' }) },
    { read: () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' }) },
    { read: () => ({ bytes: riff([vp8(512, 512)]), mime: 'image/webp' }) },
    { source: () => Promise.reject(new Error('indisponível')) },
    { source: async () => ({ uri: 'blob:wrong-type', mime: 'image/webp', w: 512, h: 512 }) },
    { source: async () => ({ uri: 'https://example.invalid/image', mime: 'image/jpeg', w: 512, h: 512 }) }
  ]
  for (const options of cases) {
    const ui = await avatarUI(options)
    const tree = await ui.render({ name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: privateImage(), persist: true })
    t.is(tree.props.children[0].props.children, 'GP')
    t.is(tree.props.children[1], false)
    t.is(ui.calls.sources.length, 1)
    t.alike(ui.calls.fetchBytes, [])
    t.alike(ui.calls.kept, [])
    t.alike(ui.calls.keep, [])
  }
})

test('Avatar kept-only mode uses the media author and invalid authors never load', async (t) => {
  const ui = await avatarUI({ keptOnly: true })
  const props = { publicKey: '12'.repeat(32), mediaAuthor: AUTHOR, picture: ui.picture, persist: true }
  const tree = await ui.render(props)
  t.is(ui.calls.kept[0][1], AUTHOR)
  t.is(tree.props.children[1].props.source.uri, 'file:///kept/avatar.jpg')
  t.is(ui.io.calls.length, 0)
  for (const keptOnly of [false, true]) {
    for (const mediaAuthor of [null, '', 'bad', 'ab'.repeat(31), 1, {}]) {
      const invalid = await avatarUI({ keptOnly })
      const tree = await invalid.render({ ...props, mediaAuthor })
      t.is(invalid.calls.kept.length, 0)
      t.is(invalid.calls.keys.length, 0)
      t.is(invalid.io.calls.length, 0)
      t.is(tree.props.children[1], false)
    }
  }
})

test('avatarErrorStep reloads a cached URL once per key, then breaks', async (t) => {
  const { avatarErrorStep } = await avatarUI()
  const none = new Set()
  const first = avatarErrorStep(none, { key: 'k', cached: true })
  t.is(first.step, 'reload')
  t.ok(first.reloaded.has('k'))
  t.is(none.size, 0, 'the given set is not mutated')
  t.is(avatarErrorStep(first.reloaded, { key: 'k', cached: true }).step, 'broken', 'a second failure of the key breaks')
  t.is(avatarErrorStep(first.reloaded, { key: 'k2', cached: true }).step, 'reload', 'another key gets its own reload')
  t.is(avatarErrorStep(none, { key: 'k', cached: false }).step, 'broken', 'a URL the cache did not hand out breaks')
  t.is(avatarErrorStep(none, { key: null, cached: true }).step, 'broken', 'no key, no reload')
})

test('Avatar reloads a photo that does not render once, on a new Image, then leaves the initials', async (t) => {
  const ui = await avatarUI()
  const props = { publicKey: AUTHOR, picture: ui.picture, persist: true }
  const key = ui.avatar.avatarKey(AUTHOR, ui.picture)
  const first = (await ui.render(props)).props.children[1]
  const url = first.props.source.uri
  t.is(url, 'blob:test/image/jpeg')
  t.is(ui.io.calls.length, 1)
  first.props.onError()
  t.alike(ui.calls.forgets, [[key, url]], 'the cache lets go of the URL that failed')
  t.alike(ui.calls.drops, [url], 'and its kept file is dropped')
  t.is(ui.renderNow(props).props.children[1], false, 'the initials while it loads again, not the URL that failed')
  const second = (await ui.render(props)).props.children[1]
  t.is(ui.io.calls.length, 2, 'the photo is loaded once more')
  t.is(ui.calls.fetchBytes[1][2].fresh, true, 'revalidated with the server')
  t.is(second.props.source.uri, url, 'same URI, as a photo kept again has')
  t.not(second.key, first.key, 'drawn by a new Image')
  second.props.onError()
  t.is(ui.calls.forgets.length, 1, 'a second failure lets nothing go')
  t.is(ui.calls.drops.length, 1)
  t.is((await ui.render(props)).props.children[1], false, 'the initials stay')
  t.is(ui.io.calls.length, 2, 'and nothing is fetched again')

  ui.remount()
  const again = (await ui.render(props)).props.children[1]
  t.is(again.props.source.uri, url, 'a new mount draws the cached copy')
  again.props.onError()
  t.is(ui.calls.forgets.length, 1, 'a key let go of once in this run is not let go of again')
  t.is(ui.calls.drops.length, 1, 'so the copy kept again is not deleted')
  const reloaded = (await ui.render(props)).props.children[1]
  t.is(reloaded.props.source.uri, url, 'the mount still reloads once, from the cache')
  t.not(reloaded.key, again.key)
  t.is(ui.io.calls.length, 2, 'with no fetch')
  reloaded.props.onError()
  t.is((await ui.render(props)).props.children[1], false, 'then the initials')
})

test('Avatar reloads around the kept store when the failed kept file could not be deleted', async (t) => {
  const KEPT = 'file:///kept/avatars/broken.jpg'
  const ui = await avatarUI({ keptHit: KEPT, dropped: false })
  const props = { publicKey: AUTHOR, picture: ui.picture, persist: true }
  const key = ui.avatar.avatarKey(AUTHOR, ui.picture)
  const first = (await ui.render(props)).props.children[1]
  t.is(first.props.source.uri, KEPT, 'the kept copy is drawn')
  t.is(ui.io.calls.length, 0, 'with no fetch')
  first.props.onError()
  t.alike(ui.calls.forgets, [[key, KEPT]])
  t.alike(ui.calls.drops, [KEPT], 'the delete is tried and fails')
  const second = (await ui.render(props)).props.children[1]
  t.ok(second, 'a photo is drawn again')
  t.not(second && second.props.source.uri, KEPT, 'not the kept file that failed')
  t.is(ui.io.calls.length, 1, 'it is fetched')
  t.is(ui.calls.fetchBytes.length > 0 && ui.calls.fetchBytes[0][2].fresh, true, 'revalidated with the server')
  t.is(ui.calls.kept.length, 1, 'the kept store is not asked again')
  t.is(ui.calls.keep.length, 0, 'and nothing is kept under the URI that failed')

  ui.remount()
  const again = (await ui.render(props)).props.children[1]
  t.is(again.props.source.uri, second.props.source.uri, 'a new mount draws the fetched copy')
  again.props.onError()
  t.is(ui.calls.drops.length, 2, 'a delete that failed is tried again')
  t.is(ui.calls.forgets.at(-1)[1], again.props.source.uri, 'and the URL that failed is let go of')
  const third = (await ui.render(props)).props.children[1]
  t.not(third && third.props.source.uri, KEPT, 'still around the kept store')
  t.is(ui.io.calls.length, 2, 'fetched once more')
  t.is(ui.calls.kept.length, 1)
})

test('Avatar: another row showing a kept file whose delete failed tries the delete again', async (t) => {
  const KEPT = 'file:///kept/avatars/broken.jpg'
  const ui = await avatarUI({ keptHit: KEPT, dropped: false })
  const props = { publicKey: AUTHOR, picture: ui.picture, persist: true }
  const rowA = (await ui.render(props)).props.children[1]
  ui.remount()
  const rowB = (await ui.render(props)).props.children[1]
  t.is(rowA.props.source.uri, KEPT)
  t.is(rowB.props.source.uri, KEPT, 'two rows draw the same kept file')
  rowB.props.onError()
  t.alike(ui.calls.drops, [KEPT], 'the first delete fails')
  rowA.props.onError()
  t.alike(ui.calls.drops, [KEPT, KEPT], 'the other row tries it again, though the cache no longer holds the URI')
  const next = (await ui.render(props)).props.children[1]
  t.not(next && next.props.source.uri, KEPT, 'and the kept file is not drawn again')
})

test('Avatar breaks at once for a kept-only or private photo that does not render', async (t) => {
  const kept = await avatarUI({ keptOnly: true })
  const props = { publicKey: AUTHOR, picture: kept.picture, persist: true }
  ;(await kept.render(props)).props.children[1].props.onError()
  t.is((await kept.render(props)).props.children[1], false, 'kept-only: the initials')
  t.is(kept.calls.forgets.length + kept.calls.drops.length + kept.io.calls.length, 0, 'nothing let go or fetched')

  const priv = await avatarUI({ source: async () => ({ uri: 'blob:private', mime: 'image/jpeg', w: 512, h: 512 }) })
  const privProps = { mediaAuthor: AUTHOR, privateItem: privateImage() }
  ;(await priv.render(privProps)).props.children[1].props.onError()
  t.is((await priv.render(privProps)).props.children[1], false, 'private: the initials')
  t.is(priv.calls.forgets.length + priv.calls.drops.length, 0)
})

test('ChatHeader forwards mediaAuthor and makes missing group authors explicit', (t) => {
  const element = (type, props) => ({ type, props })
  const { ChatHeader } = compileAvatarUI('ChatHeader.js', {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { StyleSheet: { create: (s) => s } },
    '@varanda/rpc': require('@varanda/rpc'),
    './Avatar': { Avatar: 'Avatar' },
    './TopBar': { TopBar: 'TopBar' },
    './ThemeProvider': { useStyles: (fn) => fn() }
  })
  const props = { title: 'Grupo', publicKey: '12'.repeat(32), group: true }
  t.is(ChatHeader({ ...props, mediaAuthor: AUTHOR }).props.leading.props.mediaAuthor, AUTHOR)
  t.is(ChatHeader(props).props.leading.props.mediaAuthor, null)
  t.is(ChatHeader({ ...props, group: false }).props.leading.props.mediaAuthor, undefined)
  const item = privateImage()
  const privateProps = ChatHeader({ ...props, mediaAuthor: AUTHOR, privateItem: item }).props.leading.props
  t.is(privateProps.privateItem, item)
  t.is(privateProps.mediaAuthor, AUTHOR)
  t.is(privateProps.picture, undefined)
})

const AUTHOR = 'ab'.repeat(32)
const privateImage = () => ({
  core: 'cd'.repeat(32),
  mime: 'application/octet-stream',
  start: 1,
  blocks: 1,
  bytes: 32768,
  sha256: 'ef'.repeat(32),
  key: '12'.repeat(32),
  nonce: '34'.repeat(24),
  plainMime: 'image/jpeg',
  plainSha256: '56'.repeat(32),
  w: 512,
  h: 512,
  ms: 0
})
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

const be16 = (n) => [(n >> 8) & 0xff, n & 0xff]
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff]
const le24 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const le32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0))

function jpeg (width, height, sof = 0xc0) {
  const app0 = [0xff, 0xe0, ...be16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const frame = [0xff, sof, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  const sos = [0xff, 0xda, ...be16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]
  return new Uint8Array([0xff, 0xd8, ...app0, ...frame, ...sos, 1, 2, 3, 0xff, 0xd9])
}

function chunk (fourcc, payload) {
  const out = [...ascii(fourcc), ...le32(payload.length), ...payload]
  if (payload.length & 1) out.push(0)
  return out
}

function riff (chunks) {
  const body = [...ascii('WEBP'), ...chunks.flat()]
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body])
}

const vp8 = (w, h) => chunk('VP8 ', [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0])
function vp8l (w, h) {
  const v = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  return chunk('VP8L', [0x2f, ...le32(v >>> 0), 0, 0])
}
const vp8x = (w, h, flags = 0x10) => chunk('VP8X', [flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)])

// The same block is in packages/core/test/still-image.test.js and
// apps/app/test/mediaAvatar.test.js: both parsers must give these verdicts.
function hardeningVectors () {
  const S = { width: 512, height: 512 }
  const ck = (id, payload) => {
    const out = [...ascii(id), ...le32(payload.length), ...payload]
    if (payload.length & 1) out.push(0)
    return out
  }
  const body = (...chunks) => [...ascii('WEBP'), ...chunks.flat()]
  const wrap = (b, riffSize = b.length) => new Uint8Array([...ascii('RIFF'), ...le32(riffSize), ...b])
  const web = (...chunks) => wrap(body(...chunks))
  const v8 = (w, h) => ck('VP8 ', [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0])
  const v8l = (w, h) => ck('VP8L', [0x2f, ...le32((((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)) >>> 0), 0, 0])
  const v8x = (flags, w, h) => ck('VP8X', [flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)])
  const anim = ck('ANIM', [0, 0, 0, 0, 0, 0])
  const anmf = ck('ANMF', new Array(16).fill(0))
  const badStart = ck('VP8 ', [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2b, ...le16(512), ...le16(512), 0, 0])
  const sof = (len, nf, w, h) => [0xff, 0xc0, ...be16(len), 8, ...be16(h), ...be16(w), nf, ...new Array(Math.max(0, len - 8)).fill(1)]
  const jpg = (...parts) => new Uint8Array([0xff, 0xd8, ...parts.flat(), 0xff, 0xda, 0, 2, 0xff, 0xd9])
  const still = body(v8(512, 512))
  const early = body(ck('ICCP', [1, 2, 3, 4]), v8(512, 512))
  const W = 'image/webp'
  const J = 'image/jpeg'
  return [
    ['VP8 512 then a trailing ANIM', web(v8(512, 512), anim), W, null],
    ['VP8 then ANMF', web(v8(512, 512), anmf), W, null],
    ['still VP8X + VP8L 512', web(v8x(0x00, 512, 512), v8l(512, 512)), W, S],
    ['VP8X canvas 512 + VP8 frame 256', web(v8x(0x00, 512, 512), v8(256, 256)), W, null],
    ['VP8X then a VP8 with a bad start code', web(v8x(0x00, 512, 512), badStart), W, null],
    ['two VP8X', web(v8x(0x00, 512, 512), v8x(0x00, 512, 512), v8(512, 512)), W, null],
    ['VP8X after the image chunk', web(v8(512, 512), v8x(0x00, 512, 512)), W, null],
    ['two image chunks', web(v8(512, 512), v8l(512, 512)), W, null],
    ['ALPH + VP8 with VP8X', web(v8x(0x10, 512, 512), ck('ALPH', [0, 1, 2]), v8(512, 512)), W, S],
    ['riffSize larger than the buffer', wrap(still, still.length + 2), W, null],
    ['riffSize ends before the only image chunk', wrap(early, 4 + 12), W, null],
    ['trailing bytes after the RIFF end are ignored', new Uint8Array([...wrap(still), ...anim, 1, 2, 3]), W, S],
    ['truncated trailing chunk inside the RIFF', web(v8(512, 512), [...ascii('EXIF'), ...le32(100), 1, 2]), W, null],
    ['stray partial chunk header inside the RIFF', web(v8(512, 512), [...ascii('ANIM')]), W, null],
    ['odd last chunk without its pad byte', wrap(body(v8(512, 512), ck('EXIF', [1, 2, 3])).slice(0, -1)), W, null],
    ['JPEG with an 11-byte short SOF', new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x02, 0x00, 0x02, 0x00]), J, null],
    ['JPEG SOF0 Nf 3 L 17 at 512', jpg(sof(17, 3, 512, 512)), J, S],
    ['JPEG SOF0 Nf 1 L 11 at 512', jpg(sof(11, 1, 512, 512)), J, S],
    ['JPEG L 17 with Nf 1', jpg(sof(17, 1, 512, 512)), J, null],
    ['JPEG L 14 with Nf 3', jpg(sof(14, 3, 512, 512)), J, null],
    ['JPEG Nf 0', jpg(sof(11, 0, 512, 512)), J, null],
    ['JPEG Nf 5 L 23', jpg(sof(23, 5, 512, 512)), J, null]
  ]
}

function descriptor (bytes, over = {}) {
  return {
    core: 'cd'.repeat(32),
    mime: 'image/jpeg',
    start: 1,
    blocks: Math.max(1, Math.ceil(bytes.byteLength / 32768)),
    bytes: bytes.byteLength,
    sha256: sha(bytes),
    width: 512,
    height: 512,
    ...over
  }
}

function response (bytes, status = 200) {
  return { status, redirected: false, arrayBuffer: async () => bytes.slice().buffer }
}

function deps (res, over = {}) {
  const calls = []
  return {
    calls,
    fetch: async (url, opts) => { calls.push({ url, opts }); return typeof res === 'function' ? res() : res },
    subtle: webcrypto.subtle,
    urlFromBytes: (bytes, mime) => 'blob:test/' + mime,
    ...over
  }
}

test('constants and validAvatar mirror the core rules', async (t) => {
  const { validAvatar, AVATAR_SIDE, MAX_AVATAR_BLOCKS, MAX_AVATAR_BYTES, AVATAR_MIMES } = await load()
  t.is(AVATAR_SIDE, 512)
  t.is(MAX_AVATAR_BLOCKS, 8)
  t.is(MAX_AVATAR_BYTES, 262144)
  t.alike([...AVATAR_MIMES], ['image/jpeg', 'image/webp'])
  const d = descriptor(new Uint8Array(1000))
  t.ok(validAvatar(d))
  t.ok(validAvatar({ ...d, mime: 'image/webp' }))
  t.ok(validAvatar({ ...d, start: 8184, blocks: 8, bytes: 262144 }), 'worst case')
  const bad = [
    { mime: 'image/png' },
    { mime: 'image/gif' },
    { width: 511 },
    { height: 1024 },
    { blocks: 9, bytes: 9 * 32768 },
    { core: 'CD'.repeat(32) },
    { start: 0 }
  ]
  for (const over of bad) t.absent(validAvatar({ ...d, ...over }), JSON.stringify(over))
  t.absent(validAvatar({ ...d, extra: 1 }), 'extra key')
  for (const v of [null, undefined, 'x', 42, [], {}]) t.absent(validAvatar(v))
})

test('stillImageSize reads still JPEG and WebP headers only', async (t) => {
  const { stillImageSize } = await load()
  t.alike(stillImageSize(jpeg(512, 512), 'image/jpeg'), { width: 512, height: 512 }, 'SOF0')
  t.alike(stillImageSize(jpeg(512, 512, 0xc2), 'image/jpeg'), { width: 512, height: 512 }, 'SOF2')
  t.alike(stillImageSize(jpeg(300, 200), 'image/jpeg'), { width: 300, height: 200 })
  t.alike(stillImageSize(riff([vp8(512, 512)]), 'image/webp'), { width: 512, height: 512 }, 'VP8')
  t.alike(stillImageSize(riff([vp8l(512, 512)]), 'image/webp'), { width: 512, height: 512 }, 'VP8L')
  t.alike(stillImageSize(riff([vp8x(512, 512), chunk('ALPH', [0, 1, 2]), vp8(512, 512)]), 'image/webp'), { width: 512, height: 512 }, 'still VP8X + ALPH')

  t.is(stillImageSize(riff([vp8x(512, 512, 0x12), vp8(512, 512)]), 'image/webp'), null, 'VP8X animation flag')
  t.is(stillImageSize(riff([chunk('ANIM', [0, 0, 0, 0, 0, 0]), vp8(512, 512)]), 'image/webp'), null, 'ANIM')
  t.is(stillImageSize(riff([vp8(512, 512), chunk('ANMF', [0, 0])]), 'image/webp'), null, 'ANMF')
  t.is(stillImageSize(riff([vp8x(512, 512)]), 'image/webp'), null, 'VP8X without an image chunk')
  t.is(stillImageSize(jpeg(512, 512), 'image/webp'), null, 'JPEG labelled image/webp')
  t.is(stillImageSize(riff([vp8(512, 512)]), 'image/jpeg'), null, 'WebP labelled image/jpeg')
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  t.is(stillImageSize(png, 'image/png'), null, 'PNG')
  t.is(stillImageSize(new Uint8Array(ascii('GIF89a')), 'image/gif'), null, 'GIF')
  t.is(stillImageSize(jpeg(512, 512).subarray(0, 30), 'image/jpeg'), null, 'truncated segment')
  const sizePast = riff([vp8(512, 512)])
  sizePast.set(le32(1000), 16)
  t.is(stillImageSize(sizePast, 'image/webp'), null, 'chunk size past the end')
  const many = Array.from({ length: 65 }, () => chunk('XYZW', [0, 0]))
  t.is(stillImageSize(riff([...many, vp8(512, 512)]), 'image/webp'), null, 'more than 64 chunks')
  t.is(stillImageSize([0xff, 0xd8, 0xff], 'image/jpeg'), null, 'not a Uint8Array')
  t.is(stillImageSize(null, 'image/jpeg'), null)

  let threw = false
  for (let i = 0; i < 1000; i++) {
    const b = new Uint8Array(Math.floor(Math.random() * 64))
    for (let j = 0; j < b.length; j++) b[j] = Math.floor(Math.random() * 256)
    if (i % 2 === 0 && b.length >= 3) b.set([0xff, 0xd8, 0xff])
    try { stillImageSize(b, i % 2 === 0 ? 'image/jpeg' : 'image/webp') } catch { threw = true }
  }
  t.absent(threw, 'random buffers never throw')
})

test('hardening vectors (shared with the core copy)', async (t) => {
  const { stillImageSize } = await load()
  for (const [name, bytes, mime, want] of hardeningVectors()) t.alike(stillImageSize(bytes, mime), want, name)
})

test('checkAvatarBytes needs the exact descriptor dimensions', async (t) => {
  const { checkAvatarBytes } = await load()
  const bytes = jpeg(512, 512)
  t.ok(checkAvatarBytes(bytes, descriptor(bytes)))
  t.absent(checkAvatarBytes(jpeg(512, 511), descriptor(bytes)))
  t.absent(checkAvatarBytes(bytes, descriptor(bytes, { mime: 'image/webp' })))
  const webp = riff([vp8l(512, 512)])
  t.ok(checkAvatarBytes(webp, descriptor(webp, { mime: 'image/webp' })))
})

test('avatarKey, avatarOf and sameAvatar', async (t) => {
  const { avatarKey, avatarOf, sameAvatar } = await load()
  const d = descriptor(jpeg(512, 512))
  const other = 'ef'.repeat(32)
  t.is(avatarKey(AUTHOR.toUpperCase(), d), avatarKey(AUTHOR, d), 'author lowercased')
  t.not(avatarKey(AUTHOR, d), avatarKey(other, d), 'per author')
  t.not(avatarKey(AUTHOR, d), avatarKey(AUTHOR, { ...d, mime: 'image/webp' }), 'per mime')

  const copy = avatarOf(d)
  t.alike(copy, d)
  t.not(copy, d, 'a fresh object')
  t.is(avatarOf({ ...d, width: 10 }), null)
  t.is(avatarOf(null), null)

  t.ok(sameAvatar(null, null))
  t.ok(sameAvatar(undefined, null))
  t.ok(sameAvatar(d, { ...d }))
  t.absent(sameAvatar(d, null))
  t.absent(sameAvatar(null, d))
  for (const k of Object.keys(d)) {
    t.absent(sameAvatar(d, { ...d, [k]: typeof d[k] === 'number' ? d[k] + 1 : d[k] + 'x' }), 'field ' + k)
  }
})

test('pickAvatar prefers a defined cached avatar, null included', async (t) => {
  const { pickAvatar } = await load()
  const a = descriptor(jpeg(512, 512))
  const b = descriptor(jpeg(512, 512), { core: 'ee'.repeat(32) })
  t.alike(pickAvatar({ avatar: a }, { avatar: b }), a)
  t.is(pickAvatar({ avatar: null }, { avatar: b }), null, 'a cached null wins')
  t.alike(pickAvatar({ avatar: undefined }, { avatar: b }), b, 'unknown falls back to the row')
  t.alike(pickAvatar(undefined, { avatar: b }), b)
  t.alike(pickAvatar(null, { avatar: b }), b)
  t.is(pickAvatar(null, null), null)
  t.is(pickAvatar(null, { avatar: { ...b, width: 1 } }), null, 'an invalid row value is none')
})

test('loadAvatarUrl returns a blob URL for verified still 512x512 bytes', async (t) => {
  const { loadAvatarUrl } = await load()
  const bytes = jpeg(512, 512)
  const d = descriptor(bytes)
  const io = deps(response(bytes))
  t.is(await loadAvatarUrl(AUTHOR, d, io), 'blob:test/image/jpeg')
  t.is(io.calls.length, 1)
  t.is(io.calls[0].url, '/media/' + AUTHOR + '/' + d.core + '/1/1')
  t.is(io.calls[0].opts.cache, 'force-cache', 'persisting by default')

  const webp = riff([vp8x(512, 512), vp8(512, 512)])
  const dw = descriptor(webp, { mime: 'image/webp' })
  t.is(await loadAvatarUrl(AUTHOR, dw, deps(response(webp))), 'blob:test/image/webp')
})

test('loadAvatarUrl uses no-store when persist is false', async (t) => {
  const { loadAvatarUrl } = await load()
  const bytes = jpeg(512, 512)
  const io = deps(response(bytes), { persist: false })
  await loadAvatarUrl(AUTHOR, descriptor(bytes), io)
  t.is(io.calls[0].opts.cache, 'no-store')
  const again = deps(response(bytes), { persist: false, fresh: true })
  await loadAvatarUrl(AUTHOR, descriptor(bytes), again)
  t.is(again.calls[0].opts.cache, 'no-store', 'retries too')
})

test('loadAvatarUrl failures: invalid ones are never retryable, a 404 is', async (t) => {
  const { loadAvatarUrl } = await load()
  const bytes = jpeg(512, 512)

  const invalid = deps(response(bytes))
  await t.exception(() => loadAvatarUrl(AUTHOR, descriptor(bytes, { width: 256 }), invalid), /foto inválida/)
  t.is(invalid.calls.length, 0, 'nothing fetched for an invalid descriptor')

  const cases = [
    ['SHA-256 mismatch', bytes, descriptor(bytes, { sha256: 'ee'.repeat(32) })],
    ['animated WebP', riff([vp8x(512, 512, 0x12), vp8(512, 512)]), null],
    ['wrong dimensions', jpeg(512, 256), null]
  ]
  for (const [name, body, given] of cases) {
    const d = given || descriptor(body, { mime: name === 'animated WebP' ? 'image/webp' : 'image/jpeg' })
    try {
      await loadAvatarUrl(AUTHOR, d, deps(response(body)))
      t.fail(name + ' should throw')
    } catch (err) {
      t.ok(err.retryable !== true, name + ' not retryable')
    }
  }

  try {
    await loadAvatarUrl(AUTHOR, descriptor(bytes), deps(response(new Uint8Array(0), 404)))
    t.fail('404 should throw')
  } catch (err) {
    t.is(err.retryable, true, '404 retryable')
  }
})
