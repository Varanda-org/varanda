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

async function avatarUI ({ keptOnly = false, keptHit = null, distinct = false, respond, hosted = true, identity = '34'.repeat(32), node, read, source, thumbs = {} } = {}) {
  // The URI the kept store gives this photo's name; keptHit: kept already.
  const keptUri = keptHit === null ? 'file:///kept/avatars/photo.jpg' : keptHit
  const avatar = await load()
  const { avatarColorOf } = await import('../src/format.js')
  const { stripes } = compileAvatarUI('theme.js', { 'react-native': { Platform: { select: (choices) => choices.default } } })
  const { createMediaCache, retryDelay } = await import('../src/media/cache.js')
  const { fetchPersist, loadKept, persistMode } = await import('../src/media/keptLoad.js')
  const { createChatMedia, chatMediaKey } = await import('../src/media/chatMedia.js')
  const groupImage = await import('../src/groupImage.js')
  const bytes = jpeg(512, 512)
  const io = deps(respond ? () => respond(bytes) : response(bytes))
  const calls = { keys: [], kept: [], keep: [], sources: [], reads: [], fetchBytes: [], display: [], pins: [], unpins: [], forgets: [], drops: [], persist: [], thumbKept: [], thumbKeeps: [], thumbReleases: [], readFiles: [], revoked: [] }
  const display = {
    revokeUrl (url) { calls.revoked.push(url) },
    urlFromBytes (...args) {
      calls.display.push(args)
      const url = io.urlFromBytes(...args)
      // distinct: each load hands out its own URL, as native temp files do.
      return distinct ? url + '#' + calls.display.length : url
    }
  }
  // The kept store as the view sees it: which files exist and which are
  // protected from a trim (handed out, or released less than the grace ago).
  // Any delete, under whatever name, takes the file and its protection.
  const store = { files: new Set(keptHit === null ? [] : [keptHit]), inUse: new Set(), released: new Set(), writes: 0 }
  store.protects = (uri) => store.inUse.has(uri) || store.released.has(uri)
  const deleteKept = (uri) => {
    calls.drops.push(uri)
    store.files.delete(uri)
    store.inUse.delete(uri)
    store.released.delete(uri)
    return true
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
  const keptUrl = (...args) => {
    calls.kept.push(args)
    if (keptOnly) return 'file:///kept/avatar.jpg'
    if (!store.files.has(keptUri)) return null
    store.inUse.add(keptUri)
    store.released.delete(keptUri)
    return keptUri
  }
  // Like keep.native: synchronous, and the same URI for the same name,
  // whether the file was there, is replaced or is new.
  const keep = (...args) => {
    calls.keep.push(args)
    store.files.add(keptUri)
    store.inUse.add(keptUri)
    store.released.delete(keptUri)
    store.writes++
    return keptUri
  }
  // As registerKeptStore wires it: a URL the cache lets go of is released.
  cache.onEvicted((url) => {
    if (store.inUse.delete(url)) store.released.add(url)
  })
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
    // dropKept: no Image error may delete a kept file; one that did would
    // show in calls.drops and in the store.
    '../media/keep': {
      keptUrl,
      keep,
      dropKept: deleteKept,
      keptGroupThumb (...args) {
        calls.thumbKept.push(args)
        return thumbs.kept ? thumbs.kept(...args) : null
      },
      // What the store gets, copied: the caller may wipe its array later.
      keepGroupThumb (author, sha, bytes, mime) {
        calls.thumbKeeps.push({ author, sha, bytes: Array.from(bytes), mime })
        return null
      },
      releaseKept (uri) { calls.thumbReleases.push(uri) }
    },
    '../media/reportAudio': {
      async readReportAudio (uri) {
        calls.readFiles.push(uri)
        if (!thumbs.readFile) throw new Error('Unexpected file read')
        return thumbs.readFile(uri)
      }
    },
    '../media/keptLoad': {
      fetchPersist,
      // The mode the view hands to loadKept, recorded for the persist tests.
      loadKept: (args) => {
        calls.persist.push(args.persist)
        return loadKept(args)
      },
      persistMode,
      registerKeptStore () {}
    },
    '../localCaches': {
      cacheGeneration: thumbs.generation || (() => 0),
      copyReadAllowed: thumbs.readAllowed || (() => true),
      groupThumbKeepAllowed: thumbs.allowed || (() => true)
    },
    '../appClient': { isAppClient: () => true },
    '../blocksProvider': { useBlocks: () => ({}) },
    './Icon': { Icon: 'Icon' },
    './MediaView': { KeptOnlyContext: {}, keptOnlyUrl: keptUrl, mediaHashDeps: () => ({ subtle: webcrypto.subtle }) },
    './theme': { stripes },
    './ThemeProvider': { useTheme: () => ({ colors: {} }) }
  }
  const compiled = compileAvatarUI('Avatar.js', modules, {
    // Bytes cross from this realm: the vm's own Uint8Array would refuse them.
    Uint8Array,
    setTimeout (fn, delay) {
      const id = ++timerId
      timers.set(id, { fn, at: now + delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id)
  })
  const { Avatar, avatarErrorStep } = compiled
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
    store,
    keptUri,
    cache,
    avatarErrorStep,
    exports: compiled,
    node,
    identity,
    display,
    io,
    avatar,
    stripes,
    avatarColorOf,
    get pendingTimers () { return timers.size },
    // Lets the background keep (a SHA-256, then the store) finish.
    async flush () {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
    },
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
  t.is(tree.props.children[1].props.source.uri, ui.keptUri, 'the kept file is drawn')
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
  t.is(url, ui.keptUri, 'fetched and kept')
  t.is(ui.io.calls.length, 1)
  first.props.onError()
  t.alike(ui.calls.forgets, [[key, url]], 'the cache lets go of the URL that failed')
  t.alike(ui.calls.drops, [], 'and nothing is deleted')
  t.is(ui.renderNow(props).props.children[1], false, 'the initials while it loads again, not the URL that failed')
  const second = (await ui.render(props)).props.children[1]
  t.is(ui.io.calls.length, 2, 'the photo is loaded once more')
  t.is(ui.calls.fetchBytes[1][2].fresh, true, 'revalidated with the server')
  t.is(second.props.source.uri, url, 'same URI, as a photo kept again has')
  t.not(second.key, first.key, 'drawn by a new Image')
  second.props.onError()
  t.is(ui.calls.forgets.length, 1, 'a second failure lets nothing go')
  t.is((await ui.render(props)).props.children[1], false, 'the initials stay')
  t.is(ui.io.calls.length, 2, 'and nothing is fetched again')
})

test('Avatar reloads a kept photo that does not render around the kept store and replaces it', async (t) => {
  const KEPT = 'file:///kept/avatars/broken.jpg'
  const ui = await avatarUI({ keptHit: KEPT })
  const props = { publicKey: AUTHOR, picture: ui.picture, persist: true }
  const key = ui.avatar.avatarKey(AUTHOR, ui.picture)
  const first = (await ui.render(props)).props.children[1]
  t.is(first.props.source.uri, KEPT, 'the kept copy is drawn')
  t.is(ui.io.calls.length, 0, 'with no fetch')
  first.props.onError()
  t.alike(ui.calls.forgets, [[key, KEPT]])
  t.alike(ui.calls.drops, [], 'the kept file is not deleted')
  const second = (await ui.render(props)).props.children[1]
  t.is(ui.io.calls.length, 1, 'it is fetched')
  t.is(ui.calls.fetchBytes.length > 0 && ui.calls.fetchBytes[0][2].fresh, true, 'revalidated with the server')
  t.is(ui.calls.kept.length, 1, 'the kept store is not read again')
  t.is(ui.calls.keep.length, 1, 'the verified bytes go to the store')
  t.is(ui.calls.keep[0] && ui.calls.keep[0][4] && ui.calls.keep[0][4].replace, true, 'replacing the kept copy')
  t.is(second && second.props.source.uri, KEPT, 'under the same URI')
  t.not(second && second.key, first.key, 'drawn by a new Image')

  ui.remount()
  const again = (await ui.render(props)).props.children[1]
  t.is(again.props.source.uri, KEPT, 'a new mount draws the replaced copy')
  t.is(ui.calls.kept.length, 1)
  t.is(ui.io.calls.length, 1)
})

// The cache let go of the entry (start-up clear, LRU) before the Image
// reported the error, so nothing in memory says the kept URI failed.
test('Avatar: a kept photo that fails after the cache was cleared is fetched, not drawn again', async (t) => {
  const KEPT = 'file:///kept/avatars/broken.jpg'
  const ui = await avatarUI({ keptHit: KEPT })
  const props = { publicKey: AUTHOR, picture: ui.picture, persist: true }
  const first = (await ui.render(props)).props.children[1]
  t.is(first.props.source.uri, KEPT)
  ui.cache.clear()
  first.props.onError()
  const second = (await ui.render(props)).props.children[1]
  t.is(ui.io.calls.length, 1, 'fresh bytes are fetched')
  t.is(ui.calls.kept.length, 1, 'the kept store is not read again')
  t.is(ui.calls.keep[0] && ui.calls.keep[0][4] && ui.calls.keep[0][4].replace, true, 'and they replace the kept copy')
  t.is(second && second.props.source.uri, KEPT, 'drawn under the same URI')
  t.not(second && second.key, first.key, 'on a new Image')
})

// A native temp file the OS purged while its entry is still in memory.
test('Avatar: a key reloaded once is let go of again when another URL of it fails while held', async (t) => {
  const ui = await avatarUI({ distinct: true })
  const props = { publicKey: AUTHOR, picture: ui.picture, persist: false }
  const key = ui.avatar.avatarKey(AUTHOR, ui.picture)
  const first = (await ui.render(props)).props.children[1]
  const u1 = first.props.source.uri
  first.props.onError()
  const u2 = (await ui.render(props)).props.children[1].props.source.uri
  t.not(u2, u1, 'repaired with a new URL')
  t.is(ui.io.calls.length, 2)

  ui.cache.clear()
  ui.remount()
  const again = (await ui.render(props)).props.children[1]
  const u3 = again.props.source.uri
  t.ok(u3 !== u1 && u3 !== u2, 'a new mount loads a third URL')
  t.is(ui.io.calls.length, 3)
  again.props.onError()
  t.alike(ui.calls.forgets, [[key, u1], [key, u3]], 'the URL that failed is let go of, though the key was repaired before')
  const third = (await ui.render(props)).props.children[1]
  t.is(ui.io.calls.length, 4, 'and loaded again')
  t.ok(third && third.props.source.uri !== u3, 'the URL that failed is not drawn again')
  t.not(third && third.key, again.key)
})

test('Avatar: a photo the decoder always refuses is fetched once per run, not once per mount', async (t) => {
  const KEPT = 'file:///kept/avatars/broken.jpg'
  const ui = await avatarUI({ keptHit: KEPT })
  const props = { publicKey: AUTHOR, picture: ui.picture, persist: true }
  const a = (await ui.render(props)).props.children[1]
  a.props.onError()
  const a2 = (await ui.render(props)).props.children[1]
  t.is(a2.props.source.uri, KEPT, 'replaced under the same URI')
  a2.props.onError()
  t.is((await ui.render(props)).props.children[1], false, 'mount A: the initials')
  t.is(ui.io.calls.length, 1)

  ui.remount()
  const b = (await ui.render(props)).props.children[1]
  t.is(b.props.source.uri, KEPT)
  b.props.onError()
  const b2 = (await ui.render(props)).props.children[1]
  t.is(b2 && b2.props.source.uri, KEPT, 'mount B draws it once more')
  t.not(b2 && b2.key, b.key, 'on a new Image')
  b2.props.onError()
  t.is((await ui.render(props)).props.children[1], false, 'mount B: the initials')
  t.is(ui.io.calls.length, 1, 'no fetch for mount B')
  t.is(ui.store.writes, 1, 'nor a second rewrite')
  t.is(ui.calls.forgets.length, 1)
})

test('Avatar: a reload whose fetch fails leaves the kept file in place and protected', async (t) => {
  const KEPT = 'file:///kept/avatars/fine.jpg'
  let answers = 0
  const ui = await avatarUI({ keptHit: KEPT, respond: (bytes) => response(bytes, ++answers === 1 ? 502 : 200) })
  const props = { publicKey: AUTHOR, picture: ui.picture, persist: true }
  const first = (await ui.render(props)).props.children[1]
  t.is(first.props.source.uri, KEPT)
  first.props.onError()
  t.is((await ui.render(props)).props.children[1], false, 'the initials while the fetch fails')
  t.is(ui.io.calls.length, 1, 'the fetch was tried')
  t.alike(ui.calls.drops, [], 'nothing is deleted')
  t.is(ui.store.writes, 0, 'nor written')
  t.ok(ui.store.files.has(KEPT), 'the kept file is still there')
  t.ok(ui.store.protects(KEPT), 'and still protected from a trim')

  ui.advance(2000)
  const retried = (await ui.render(props)).props.children[1]
  t.is(ui.io.calls.length, 2, 'the retry ladder fetches again')
  t.is(ui.calls.kept.length, 1, 'still around the kept store')
  t.is(ui.calls.keep[0] && ui.calls.keep[0][4] && ui.calls.keep[0][4].replace, true, 'and replaces the kept copy')
  t.is(retried && retried.props.source.uri, KEPT)
})

test('Avatar: during a pending reload the failed URI put back in memory is not drawn', async (t) => {
  const KEPT = 'file:///kept/avatars/broken.jpg'
  let answers = 0
  const ui = await avatarUI({ keptHit: KEPT, respond: (bytes) => response(bytes, ++answers === 1 ? 502 : 200) })
  const props = { publicKey: AUTHOR, picture: ui.picture, persist: true }
  const key = ui.avatar.avatarKey(AUTHOR, ui.picture)
  const first = (await ui.render(props)).props.children[1]
  first.props.onError()
  t.is((await ui.render(props)).props.children[1], false, 'the fetch fails')
  // Another mount reads the unrepaired kept file back into the shared cache.
  t.is(await ui.cache.get(key, async () => KEPT), KEPT)
  ui.advance(2000)
  const retried = (await ui.render(props)).props.children[1]
  t.is(ui.io.calls.length, 2, 'the retry fetches instead of drawing the memory hit')
  t.alike(ui.calls.forgets.at(-1), [key, KEPT], 'the failed URI is let go of again')
  t.is(ui.store.writes, 1, 'the kept copy is replaced')
  t.is(ui.calls.keep[0] && ui.calls.keep[0][4] && ui.calls.keep[0][4].replace, true)
  t.is(retried && retried.props.source.uri, KEPT)
})

test('Avatar: another row still drawing a replaced kept file draws the repaired file with no fetch', async (t) => {
  const KEPT = 'file:///kept/avatars/broken.jpg'
  const ui = await avatarUI({ keptHit: KEPT })
  const props = { publicKey: AUTHOR, picture: ui.picture, persist: true }
  const rowB = (await ui.render(props)).props.children[1]
  ui.remount()
  const rowA = (await ui.render(props)).props.children[1]
  t.is(rowA.props.source.uri, KEPT)
  t.is(rowB.props.source.uri, KEPT, 'two rows draw the same kept file')
  rowA.props.onError()
  t.is((await ui.render(props)).props.children[1].props.source.uri, KEPT, 'row A draws the replaced file')
  t.is(ui.io.calls.length, 1)
  t.is(ui.store.writes, 1)
  rowB.props.onError()
  t.is(ui.calls.forgets.length, 1, 'row B does not let go of the repaired file')
  const next = (await ui.render(props)).props.children[1]
  t.is(next && next.props.source.uri, KEPT, 'row B draws it')
  t.is(ui.io.calls.length, 1, 'with no fetch')
  t.is(ui.store.writes, 1, 'and no rewrite')
  t.ok(ui.store.protects(KEPT), 'still protected')
  t.alike(ui.calls.drops, [])
})

// persist 'copy' (a reopened screen's saved copy): loadKept gets the mode
// and picks the store kind; the HTTP cache only for a followed author.
async function copyCaches (t) {
  const caches = await import('../src/localCaches.js')
  caches.wipeLocalCaches()
  t.teardown(() => caches.wipeLocalCaches())
  return caches
}

test('Avatar: persist copy reaches loadKept as copy; a stranger is fetched as transient and kept in the copy kind', async (t) => {
  const caches = await copyCaches(t)
  caches.setAllowedAuthors([])
  caches.noteBlocksKnown(caches.wipeEpoch())
  const ui = await avatarUI()
  const drawn = (await ui.render({ publicKey: AUTHOR, picture: ui.picture, persist: 'copy' })).props.children[1]
  t.alike(ui.calls.persist, ['copy'], 'loadKept gets the mode itself')
  t.is(ui.calls.fetchBytes[0][2].persist, false, 'no HTTP cache for a stranger')
  t.is(ui.io.calls[0].opts.cache, 'no-store')
  t.is(ui.calls.keep[0] && ui.calls.keep[0][0], 'copyAvatars', 'kept only in the copy kind')
  t.is(drawn && drawn.props.source.uri, 'file:///kept/avatars/photo.jpg')
})

test('Avatar: persist copy of a followed author uses the HTTP cache and the main kind', async (t) => {
  const caches = await copyCaches(t)
  caches.setAllowedAuthors([AUTHOR])
  const ui = await avatarUI()
  await ui.render({ publicKey: AUTHOR, picture: ui.picture, persist: 'copy' })
  t.alike(ui.calls.persist, ['copy'])
  t.is(ui.calls.fetchBytes[0][2].persist, true, 'a followed author may use the HTTP cache')
  t.is(ui.calls.keep[0] && ui.calls.keep[0][0], 'avatars', 'kept in the main kind')
})

test('Avatar: a copy reload replaces the file in the kind loadKept chose', async (t) => {
  const caches = await copyCaches(t)
  caches.setAllowedAuthors([])
  caches.noteBlocksKnown(caches.wipeEpoch())
  const KEPT = 'file:///kept/avatars/broken.jpg'
  const ui = await avatarUI({ keptHit: KEPT })
  const props = { publicKey: AUTHOR, picture: ui.picture, persist: 'copy' }
  const first = (await ui.render(props)).props.children[1]
  t.is(first.props.source.uri, KEPT, 'the saved copy is drawn')
  t.is(ui.io.calls.length, 0, 'with no fetch')
  first.props.onError()
  const second = (await ui.render(props)).props.children[1]
  t.is(ui.io.calls.length, 1, 'the reload fetches')
  t.is(ui.calls.fetchBytes[0][2].persist, false, 'as transient')
  t.alike(ui.calls.keep.map((args) => [args[0], args[4] && args[4].replace]), [['copyAvatars', true]], 'replaced in the copy kind')
  t.is(second && second.props.source.uri, KEPT)
  t.alike(ui.calls.persist, ['copy', 'copy'])
})

test('Avatar: no persist prop is false: transient, never kept', async (t) => {
  await copyCaches(t)
  const ui = await avatarUI()
  await ui.render({ publicKey: AUTHOR, picture: ui.picture })
  t.alike(ui.calls.persist, [false])
  t.is(ui.calls.fetchBytes[0][2].persist, false)
  t.is(ui.calls.keep.length, 0)
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

// Private group pictures kept for reopened screens (groupThumb, keepGroupThumb).
const thumbItem = (bytes) => ({ ...privateImage(), plainSha256: sha(bytes) })
const KEPT_THUMB = 'file:///keep/copyGroupThumbs/thumb.jpg'

test('Avatar group thumbs: both props default off', async (t) => {
  const bytes = jpeg(512, 512)
  const ui = await avatarUI({ read: () => ({ bytes: bytes.slice(), mime: 'image/jpeg' }), thumbs: { kept: () => KEPT_THUMB } })
  const tree = await ui.render({ name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: thumbItem(bytes) })
  await ui.flush()
  t.is(tree.props.children[1].props.source.uri, 'blob:test/image/jpeg')
  t.is(ui.calls.sources[0].ctx.keep, undefined, 'no keeper reaches chatMedia')
  t.is(ui.calls.sources[0].ctx.readFile, undefined)
  t.alike(ui.calls.thumbKept, [], 'no kept picture is read')
  t.alike(ui.calls.thumbKeeps, [], 'nothing is kept')
  t.alike(ui.calls.readFiles, [])
})

test('Avatar group thumbs: the web keeps the verified plaintext, never the key or nonce', async (t) => {
  const bytes = jpeg(512, 512)
  const ui = await avatarUI({ read: () => ({ bytes: bytes.slice(), mime: 'image/jpeg' }) })
  const item = thumbItem(bytes)
  const tree = await ui.render({ name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: item, keepGroupThumb: true })
  await ui.flush()
  t.is(tree.props.children[1].props.source.uri, 'blob:test/image/jpeg')
  t.alike(ui.calls.thumbKeeps, [{ author: AUTHOR, sha: item.plainSha256, bytes: Array.from(bytes), mime: 'image/jpeg' }])
  const stored = JSON.stringify(ui.calls.thumbKeeps)
  for (const secret of [item.key, item.nonce, item.core]) t.absent(stored.includes(secret), 'no key, nonce or core reaches the store')
  t.alike(ui.calls.readFiles, [], 'the web path reads no file')
  ui.remount()
  await ui.render({ name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: item, keepGroupThumb: true })
  await ui.flush()
  t.is(ui.calls.thumbKeeps.length, 1, 'a pair kept in this run is not hashed and written again')
})

test('Avatar group thumbs: native reads the node file for the keeper', async (t) => {
  const bytes = jpeg(512, 512)
  const uri = 'file:///data/cache/varanda-read/thumb.jpg'
  const ui = await avatarUI({
    read: () => ({ uri, mime: 'image/jpeg', w: 512, h: 512 }),
    thumbs: { readFile: () => bytes.slice() }
  })
  const item = thumbItem(bytes)
  const tree = await ui.render({ name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: item, keepGroupThumb: true })
  await ui.flush()
  t.is(tree.props.children[1].props.source.uri, uri, 'the node file is drawn')
  t.alike(ui.calls.readFiles, [uri])
  t.alike(ui.calls.thumbKeeps, [{ author: AUTHOR, sha: item.plainSha256, bytes: Array.from(bytes), mime: 'image/jpeg' }])
})

test('Avatar group thumbs: a wrong hash, an oversized picture, a blocked author or an unknown block list keep nothing', async (t) => {
  const bytes = jpeg(512, 512)
  const big = new Uint8Array(262145)
  big.set(bytes)
  const caches = await import('../src/localCaches.js')
  const uri = 'file:///data/cache/varanda-read/thumb.jpg'
  const cases = [
    { why: 'wrong hash', item: { ...privateImage(), plainSha256: '77'.repeat(32) }, file: () => bytes.slice() },
    { why: 'oversized', item: thumbItem(big), file: () => big.slice() },
    { why: 'blocked author', item: thumbItem(bytes), file: () => bytes.slice(), allowed: () => false },
    // The real check: no block list known in this run.
    { why: 'unknown block list', item: thumbItem(bytes), file: () => bytes.slice(), allowed: caches.groupThumbKeepAllowed },
    { why: 'purged while hashing', item: thumbItem(bytes), file: () => bytes.slice(), generation: (() => { let n = 0; return () => n++ })() }
  ]
  for (const c of cases) {
    const given = []
    const ui = await avatarUI({
      read: () => ({ uri, mime: 'image/jpeg', w: 512, h: 512 }),
      thumbs: { readFile: () => { const b = c.file(); given.push(b); return b }, allowed: c.allowed, generation: c.generation }
    })
    await ui.render({ name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: c.item, keepGroupThumb: true })
    await ui.flush()
    t.is(ui.calls.readFiles.length, 1, c.why + ': the file was offered')
    t.alike(ui.calls.thumbKeeps, [], c.why + ': nothing kept')
    t.ok(given[0].every((b) => b === 0), c.why + ': the refused plaintext is wiped')
  }
})

test('Avatar group thumbs: a picture the live draw refuses is never kept', async (t) => {
  const small = jpeg(256, 256)
  const web = await avatarUI({ read: () => ({ bytes: small.slice(), mime: 'image/jpeg' }) })
  await web.render({ name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: thumbItem(small), keepGroupThumb: true })
  await web.flush()
  t.is(web.calls.sources.length, 1, 'the web read ran with a keeper')
  t.alike(web.calls.thumbKeeps, [], 'a 256x256 JPEG read as bytes is not kept')
  const uri = 'file:///data/cache/varanda-read/thumb.jpg'
  for (const [why, w, h] of [['256x256', 256, 256], ['512x256', 512, 256]]) {
    const given = []
    const ui = await avatarUI({
      read: () => ({ uri, mime: 'image/jpeg', w, h }),
      thumbs: { readFile: () => { const b = small.slice(); given.push(b); return b } }
    })
    await ui.render({ name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: thumbItem(small), keepGroupThumb: true })
    await ui.flush()
    t.is(ui.calls.readFiles.length, 1, why + ': the file was offered')
    t.alike(ui.calls.thumbKeeps, [], why + ': nothing kept')
    t.ok(given[0].every((b) => b === 0), why + ': the refused plaintext is wiped')
  }
})

test('Avatar group thumbs: keepGroupThumbBytes checks before the store', async (t) => {
  const ui = await avatarUI()
  const { keepGroupThumbBytes, GROUP_THUMB_MAX_BYTES } = ui.exports
  t.is(GROUP_THUMB_MAX_BYTES, 262144)
  const bytes = jpeg(512, 512)
  const kept = []
  const deps = { allowed: () => true, keep: (...args) => kept.push(args), subtle: webcrypto.subtle, generation: () => 0 }
  const base = { author: AUTHOR, sha: sha(bytes), mime: 'image/jpeg', w: 512, h: 512 }
  t.is(await keepGroupThumbBytes({ ...base, bytes: bytes.slice() }, { ...deps, subtle: null }), false, 'no digest, no keep')
  t.is(await keepGroupThumbBytes({ ...base, bytes: bytes.slice(), mime: 'image/svg+xml' }, deps), false, 'a type the store does not name')
  // Only what the live draw accepts: a 512x512 JPEG.
  for (const [why, over] of [['another type', { mime: 'image/webp' }], ['256x256', { w: 256, h: 256 }], ['another width', { w: 511 }], ['another height', { h: 1024 }], ['no size', { w: undefined, h: undefined }]]) {
    const given = bytes.slice()
    t.is(await keepGroupThumbBytes({ ...base, ...over, bytes: given }, deps), false, why + ': not kept')
    t.ok(given.every((b) => b === 0), why + ': wiped')
  }
  t.is(await keepGroupThumbBytes({ ...base, bytes: bytes.slice(), author: 'AB'.repeat(32) }, deps), false, 'a malformed author')
  t.is(await keepGroupThumbBytes({ ...base, bytes: new Uint8Array(0) }, deps), false, 'empty bytes')
  t.is(await keepGroupThumbBytes({ ...base, bytes: bytes.slice() }, { ...deps, allowed: () => { throw new Error('x') } }), false, 'a throwing check fails closed')
  t.alike(kept, [])
  t.is(await keepGroupThumbBytes({ ...base, bytes: bytes.slice() }, deps), true)
  t.is(kept.length, 1)
})

test('Avatar group thumbs: the kept picture shows first and the live one replaces it', async (t) => {
  const bytes = jpeg(512, 512)
  let finish
  const ui = await avatarUI({
    source: () => new Promise((resolve) => { finish = resolve }),
    thumbs: { kept: () => KEPT_THUMB }
  })
  const item = thumbItem(bytes)
  const props = { name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: item, groupThumb: { author: AUTHOR, sha: item.plainSha256 } }
  ui.renderNow(props)
  const first = ui.renderNow(props)
  t.is(first.props.children[1].props.source.uri, KEPT_THUMB, 'the kept copy is drawn while the node reads')
  t.alike(ui.calls.thumbKept, [[AUTHOR, item.plainSha256]])
  t.alike(ui.calls.pins, [], 'a kept picture is not chat media')
  finish({ uri: 'blob:live', mime: 'image/jpeg', w: 512, h: 512 })
  const live = await ui.render(props)
  t.is(live.props.children[1].props.source.uri, 'blob:live', 'the live picture replaces it')
  t.alike(ui.calls.pins, ['blob:live'])
})

test('Avatar group thumbs: a snapshot row with no live item draws the kept copy; another hash, author or a public picture hides it', async (t) => {
  const bytes = jpeg(512, 512)
  const item = thumbItem(bytes)
  const thumb = { author: AUTHOR, sha: item.plainSha256 }
  {
    const ui = await avatarUI({ thumbs: { kept: () => KEPT_THUMB } })
    const tree = await ui.render({ name: 'Grupo privado', mediaAuthor: AUTHOR, groupThumb: thumb })
    t.is(tree.props.children[1].props.source.uri, KEPT_THUMB, 'no live item yet: the kept copy')
    t.alike(ui.calls.sources, [])
  }
  const hidden = [
    { why: 'another plainSha256', props: { privateItem: { ...item, plainSha256: '77'.repeat(32) } } },
    { why: 'another author', props: { privateItem: item, mediaAuthor: 'cd'.repeat(32) } },
    { why: 'a public picture', props: { picture: descriptor(bytes) } },
    { why: 'a malformed thumb', props: { groupThumb: { author: AUTHOR, sha: 'x' } } }
  ]
  for (const c of hidden) {
    let finish
    const ui = await avatarUI({ source: () => new Promise((resolve) => { finish = resolve }), thumbs: { kept: () => KEPT_THUMB } })
    const props = { name: 'Grupo privado', mediaAuthor: AUTHOR, groupThumb: thumb, ...c.props }
    ui.renderNow(props)
    const tree = ui.renderNow(props)
    t.is(tree.props.children[1] && tree.props.children[1].props.source.uri === KEPT_THUMB, false, c.why + ': the kept copy is hidden')
    t.alike(ui.calls.thumbKept, [], c.why + ': not even read')
    if (finish) finish({ uri: 'blob:live', mime: 'image/jpeg', w: 512, h: 512 })
  }
  {
    const ui = await avatarUI({ thumbs: { kept: () => KEPT_THUMB, readAllowed: () => false } })
    const tree = await ui.render({ name: 'Grupo privado', mediaAuthor: AUTHOR, groupThumb: thumb })
    t.is(tree.props.children[1], false, 'a block list that refuses the author reads no copy')
    t.alike(ui.calls.thumbKept, [])
  }
})

test('Avatar group thumbs: the web draws kept bytes through a blob: URL it revokes', async (t) => {
  const bytes = jpeg(512, 512)
  const item = thumbItem(bytes)
  const ui = await avatarUI({ thumbs: { kept: async () => bytes.slice() } })
  const tree = await ui.render({ name: 'Grupo privado', mediaAuthor: AUTHOR, groupThumb: { author: AUTHOR, sha: item.plainSha256 } })
  t.is(tree.props.children[1].props.source.uri, 'blob:test/image/jpeg')
  t.alike(ui.calls.display.map((args) => args[1]), ['image/jpeg'])
  ui.unmount()
  t.alike(ui.calls.revoked, ['blob:test/image/jpeg'])
})

test('Avatar group thumbs: a block while the kept read is in flight shows nothing', async (t) => {
  const bytes = jpeg(512, 512)
  const item = thumbItem(bytes)
  let allowed = true
  let finish
  const ui = await avatarUI({ thumbs: { kept: () => new Promise((resolve) => { finish = resolve }), readAllowed: () => allowed } })
  const props = { name: 'Grupo privado', mediaAuthor: AUTHOR, groupThumb: { author: AUTHOR, sha: item.plainSha256 } }
  ui.renderNow(props)
  t.is(ui.calls.thumbKept.length, 1, 'the read started')
  allowed = false
  finish(bytes.slice())
  await ui.flush()
  t.alike(ui.calls.display, [], 'no blob: URL is made for the late bytes')
  const tree = ui.renderNow(props)
  t.is(tree.props.children[1], false, 'nor are they drawn')
})

test('Avatar group thumbs: a drawn kept picture goes when its author is blocked', async (t) => {
  const bytes = jpeg(512, 512)
  const item = thumbItem(bytes)
  let allowed = true
  const ui = await avatarUI({ thumbs: { kept: async () => bytes.slice(), readAllowed: () => allowed } })
  const props = { name: 'Grupo privado', mediaAuthor: AUTHOR, groupThumb: { author: AUTHOR, sha: item.plainSha256 } }
  const shown = await ui.render(props)
  t.is(shown.props.children[1].props.source.uri, 'blob:test/image/jpeg')
  allowed = false
  const tree = await ui.render(props)
  t.is(tree.props.children[1], false, 'the picture is cleared')
  t.alike(ui.calls.revoked, ['blob:test/image/jpeg'], 'and its URL revoked')
})

test('Avatar group thumbs: a kept picture first asked before the block list is known is read once it is', async (t) => {
  const bytes = jpeg(512, 512)
  const item = thumbItem(bytes)
  let known = false
  const ui = await avatarUI({ thumbs: { kept: async () => bytes.slice(), readAllowed: () => known } })
  const props = { name: 'Grupo privado', mediaAuthor: AUTHOR, groupThumb: { author: AUTHOR, sha: item.plainSha256 } }
  const before = await ui.render(props)
  t.is(before.props.children[1], false)
  t.alike(ui.calls.thumbKept, [], 'nothing read while the list is unknown')
  known = true
  ui.renderNow(props)
  await ui.flush()
  const tree = ui.renderNow(props)
  t.is(tree.props.children[1] && tree.props.children[1].props.source.uri, 'blob:test/image/jpeg', 'drawn once the list is known')
  t.is(ui.calls.thumbKept.length, 1)
})

test('Avatar group thumbs: a web hit keeps a picture its first decrypt could not, and only with a keeper', async (t) => {
  const bytes = jpeg(512, 512)
  let allowed = false
  const ui = await avatarUI({
    read: () => ({ bytes: bytes.slice(), mime: 'image/jpeg' }),
    thumbs: { allowed: () => allowed, readFile: () => bytes.slice() }
  })
  const item = thumbItem(bytes)
  const props = { name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: item, keepGroupThumb: true }
  await ui.render(props)
  await ui.flush()
  t.alike(ui.calls.thumbKeeps, [], 'the decrypt came before the block list allowed a keep')
  allowed = true
  ui.remount()
  await ui.render({ ...props, keepGroupThumb: false })
  await ui.flush()
  t.alike(ui.calls.readFiles, [], 'a hit with no keeper reads nothing')
  ui.remount()
  const tree = await ui.render(props)
  await ui.flush()
  t.is(tree.props.children[1].props.source.uri, 'blob:test/image/jpeg')
  t.alike(ui.calls.readFiles, ['blob:test/image/jpeg'], 'the hit reads its blob: URL back')
  t.alike(ui.calls.thumbKeeps, [{ author: AUTHOR, sha: item.plainSha256, bytes: Array.from(bytes), mime: 'image/jpeg' }])
  t.is(ui.calls.reads.length, 1, 'with no second node read')
  ui.remount()
  await ui.render(props)
  await ui.flush()
  t.is(ui.calls.readFiles.length, 1, 'a pair kept in this run is not read again')
})

test('Avatar group thumbs: a native hit reads no file for a picture the keep would refuse', async (t) => {
  const bytes = jpeg(512, 512)
  const caches = await import('../src/localCaches.js')
  const uri = 'file:///data/cache/varanda-read/thumb.jpg'
  const cases = [
    { why: 'blocked author', allowed: () => false },
    { why: 'unknown block list', allowed: caches.groupThumbKeepAllowed },
    { why: 'a 256x256 picture', w: 256, h: 256, item: thumbItem(jpeg(256, 256)) },
    { why: 'a 512x256 picture', w: 512, h: 256 }
  ]
  for (const c of cases) {
    const ui = await avatarUI({
      read: () => ({ uri, mime: 'image/jpeg', w: c.w || 512, h: c.h || 512 }),
      thumbs: { readFile: () => bytes.slice(), allowed: c.allowed }
    })
    const props = { name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: c.item || thumbItem(bytes), keepGroupThumb: true }
    await ui.render(props)
    await ui.flush()
    t.is(ui.calls.readFiles.length, 1, c.why + ': the decrypt offered its file')
    ui.remount()
    await ui.render(props)
    await ui.flush()
    t.is(ui.calls.readFiles.length, 1, c.why + ': the hit reads nothing')
    t.alike(ui.calls.thumbKeeps, [], c.why + ': nothing kept')
  }
  let allowed = false
  const ui = await avatarUI({
    read: () => ({ uri, mime: 'image/jpeg', w: 512, h: 512 }),
    thumbs: { readFile: () => bytes.slice(), allowed: () => allowed }
  })
  const item = thumbItem(bytes)
  const props = { name: 'Grupo privado', mediaAuthor: AUTHOR, privateItem: item, keepGroupThumb: true }
  await ui.render(props)
  await ui.flush()
  allowed = true
  ui.remount()
  await ui.render(props)
  await ui.flush()
  t.alike(ui.calls.readFiles, [uri, uri], 'an eligible hit reads once')
  t.alike(ui.calls.thumbKeeps, [{ author: AUTHOR, sha: item.plainSha256, bytes: Array.from(bytes), mime: 'image/jpeg' }], 'and keeps')
})

test('Avatar group thumbs: native releases a kept picture when the row lets it go', async (t) => {
  const bytes = jpeg(512, 512)
  const item = thumbItem(bytes)
  const other = { ...item, plainSha256: '77'.repeat(32) }
  const uriOf = (author, sha) => 'file:///keep/copyGroupThumbs/' + author + '-' + sha + '.jpg'
  const ui = await avatarUI({ thumbs: { kept: uriOf } })
  const props = { name: 'Grupo privado', mediaAuthor: AUTHOR, groupThumb: { author: AUTHOR, sha: item.plainSha256 } }
  const tree = await ui.render(props)
  const first = uriOf(AUTHOR, item.plainSha256)
  t.is(tree.props.children[1].props.source.uri, first)
  t.alike(ui.calls.thumbReleases, [], 'held while shown')
  await ui.render({ ...props, groupThumb: { author: AUTHOR, sha: other.plainSha256 } })
  t.alike(ui.calls.thumbReleases, [first], 'a change of pair releases the old URI')
  ui.unmount()
  t.alike(ui.calls.thumbReleases, [first, uriOf(AUTHOR, other.plainSha256)], 'an unmount releases the shown one')
  const web = await avatarUI({ thumbs: { kept: async () => bytes.slice() } })
  await web.render(props)
  web.unmount()
  t.alike(web.calls.thumbReleases, [], 'the web revokes its blob: URL instead')
  t.alike(web.calls.revoked, ['blob:test/image/jpeg'])
})
