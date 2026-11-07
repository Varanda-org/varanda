'use strict'

// Chat media sources: only device-local URIs reach the screen (blob: from
// bytes the node or the verified fetch handed over, file:// the worklet
// wrote), cached per identity, released on eviction, lock and switch.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { createHash, webcrypto } = require('node:crypto')
const load = () => import('../src/media/chatMedia.js')

const ME = 'a1'.repeat(32)
const OTHER = 'b2'.repeat(32)
const FROM = 'c3'.repeat(32)
const DIARY = 'd4'.repeat(32)
const id = (n) => n.toString(16).padStart(32, '0')

// A 3x2 grayscale PNG that mediaBounds accepts.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAAAAAC4HznGAAAAC0lEQVR4nGNggAAAAAgAAbdYc5UAAAAASUVORK5CYII='
const png = () => new Uint8Array(Buffer.from(PNG_B64, 'base64'))

function display () {
  let n = 0
  const made = []
  const revoked = []
  return {
    made,
    revoked,
    urlFromBytes (bytes, mime) {
      const url = 'blob:test/' + (++n)
      made.push({ url, mime, copy: Array.from(bytes) })
      return url
    },
    revokeUrl (url) { revoked.push(url) }
  }
}

function webNode (answer = () => ({ bytes: png(), mime: 'image/png' })) {
  const reads = []
  return {
    reads,
    media: {
      async read (ref) {
        reads.push(ref)
        return answer(ref)
      }
    }
  }
}

function nativeNode (answer) {
  const reads = []
  const forgotten = []
  let cleared = 0
  return {
    reads,
    forgotten,
    get cleared () { return cleared },
    media: {
      async read (ref) {
        reads.push(ref)
        return answer ? answer(ref) : { uri: 'file:///data/cache/varanda-read/' + ref.id + '.png', mime: 'image/png', w: 3, h: 2 }
      },
      forgetReadFile (name) { forgotten.push(name) },
      clearReadFiles () { cleared++ }
    }
  }
}

const dmRef = (n, index = 0) => ({ kind: 'dm', from: FROM, id: id(n), index, item: { mime: 'image/png' } })

function publicItem (bytes) {
  return {
    core: 'e5'.repeat(32),
    mime: 'image/png',
    start: 1,
    blocks: 1,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: 3,
    height: 2
  }
}

function privateItem () {
  return {
    core: 'f6'.repeat(32),
    mime: 'application/octet-stream',
    start: 2,
    blocks: 1,
    bytes: 32768,
    sha256: '07'.repeat(32),
    key: '08'.repeat(32),
    nonce: '09'.repeat(24),
    plainMime: 'image/png',
    plainSha256: '0a'.repeat(32),
    w: 3,
    h: 2,
    ms: 0
  }
}

test('web DM: bytes become a blob: URL after bounds, then the plaintext is wiped', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const d = display()
  let handed = null
  const node = webNode(() => { handed = png(); return { bytes: handed, mime: 'image/png' } })
  const out = await media.sourceFor(dmRef(1, 2), { node, identity: ME, display: d })
  t.alike(out, { uri: 'blob:test/1', mime: 'image/png', w: 3, h: 2 })
  t.alike(node.reads, [{ kind: 'dm', from: FROM, id: id(1), index: 2 }], 'the node gets the exact ref')
  t.alike(d.made[0].copy, Array.from(png()), 'the URL was made from the bytes as read')
  t.ok(handed.every((b) => b === 0), 'the handed-over plaintext is zero-filled')
})

test('cache hit: the same ref is read once', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const d = display()
  const node = webNode()
  const a = await media.sourceFor(dmRef(1), { node, identity: ME, display: d })
  const b = await media.sourceFor(dmRef(1), { node, identity: ME, display: d })
  t.alike(a, b)
  t.is(node.reads.length, 1)
  const c = await media.sourceFor(dmRef(1, 1), { node, identity: ME, display: d })
  t.is(c.uri, 'blob:test/2', 'another index is another entry')
})

test('identity partition: a switch revokes the previous URLs and reads again', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const d = display()
  const node = webNode()
  await media.sourceFor(dmRef(1), { node, identity: ME, display: d })
  const other = await media.sourceFor(dmRef(1), { node, identity: OTHER, display: d })
  t.alike(d.revoked, ['blob:test/1'], 'the first identity\'s URL is gone')
  t.is(other.uri, 'blob:test/2')
  t.is(node.reads.length, 2)
})

test('eviction revokes the least recently used URL', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia({ max: 2 })
  const d = display()
  const node = webNode()
  await media.sourceFor(dmRef(1), { node, identity: ME, display: d })
  await media.sourceFor(dmRef(2), { node, identity: ME, display: d })
  await media.sourceFor(dmRef(1), { node, identity: ME, display: d })
  await media.sourceFor(dmRef(3), { node, identity: ME, display: d })
  t.alike(d.revoked, ['blob:test/2'])
  t.is(media.size, 2)
})

test('native: the worklet file is shown; eviction and clear forget it', async (t) => {
  const { createChatMedia, clearChatMedia } = await load()
  const media = createChatMedia({ max: 1 })
  const node = nativeNode()
  const a = await media.sourceFor(dmRef(1), { node, identity: ME })
  t.alike(a, { uri: 'file:///data/cache/varanda-read/' + id(1) + '.png', mime: 'image/png', w: 3, h: 2 })
  await media.sourceFor(dmRef(2), { node, identity: ME })
  t.alike(node.forgotten, [id(1) + '.png'], 'evicted file forgotten')
  clearChatMedia()
  t.alike(node.forgotten, [id(1) + '.png', id(2) + '.png'], 'lock forgets the rest')
  t.is(node.cleared, 1, 'and asks the host to clear its read files')
  t.is(media.size, 0)
})

test('a node answer that is not a local file is never shown', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  for (const uri of ['ht' + 'tps://example.com/x.png', 'content://x', 'file:///x/a.png?y=1', 42]) {
    const node = nativeNode(() => ({ uri, mime: 'image/png' }))
    t.alike(await media.sourceFor(dmRef(1), { node, identity: ME }), { unavailable: true }, String(uri))
  }
})

test('bounds refuse the bytes: no URL, plaintext wiped', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const d = display()
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const node = webNode(() => ({ bytes: junk, mime: 'image/png' }))
  t.alike(await media.sourceFor(dmRef(1), { node, identity: ME, display: d }), { unavailable: true })
  t.is(d.made.length, 0)
  t.ok(junk.every((b) => b === 0))
})

test('a mime other than the item promised is refused', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const d = display()
  const node = webNode(() => ({ bytes: png(), mime: 'image/gif' }))
  t.alike(await media.sourceFor(dmRef(1), { node, identity: ME, display: d }), { unavailable: true })
  t.is(d.made.length, 0)
})

test('missing capability, gone item or bad ref: unavailable', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const d = display()
  t.alike(await media.sourceFor(dmRef(1), { node: {}, identity: ME, display: d }), { unavailable: true }, 'no media.read')
  t.alike(await media.sourceFor(dmRef(1), { node: null, identity: ME, display: d }), { unavailable: true }, 'no node')
  t.alike(await media.sourceFor({ ...dmRef(1), item: { unavailable: true } }, { node: webNode(), identity: ME, display: d }), { unavailable: true }, 'gone')
  t.alike(await media.sourceFor(dmRef(1), { node: webNode(), identity: 'nope', display: d }), { unavailable: true }, 'no identity')
  t.alike(await media.sourceFor({ kind: 'dm', from: FROM, id: '../x', index: 0 }, { node: webNode(), identity: ME, display: d }), { unavailable: true }, 'bad id')
  t.alike(await media.sourceFor(dmRef(1), { node: webNode(() => { throw new TypeError('x') }), identity: ME, display: d }), { unavailable: true }, 'bad ref refused by the node')
})

test('a node read that fails is retryable, and the retry reads again', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const d = display()
  let fail = true
  const node = webNode(() => {
    if (fail) throw Object.assign(new Error('mídia indisponível'), { code: 'USAGE' })
    return { bytes: png(), mime: 'image/png' }
  })
  t.alike(await media.sourceFor(dmRef(1), { node, identity: ME, display: d }), { unavailable: true, retryable: true }, 'dm read failure')
  const group = { kind: 'group', diary: DIARY, item: privateItem() }
  t.alike(await media.sourceFor(group, { node, identity: ME, display: d }), { unavailable: true, retryable: true }, 'private group read failure')
  fail = false
  const out = await media.sourceFor(dmRef(1), { node, identity: ME, display: d })
  t.is(out.uri, 'blob:test/1', 'the tap-to-retry read succeeds')
  t.is(node.reads.length, 3)
  t.alike(await media.sourceFor({ ...dmRef(2), item: { unavailable: true } }, { node, identity: ME, display: d }), { unavailable: true }, 'a gone item stays final')
})

test('native: a file without a positive integer size is refused and forgotten', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const sizes = [[null, null], [0, 2], [3, -1], [1.5, 2], ['3', '2'], [undefined, 2]]
  for (const [w, h] of sizes) {
    const node = nativeNode((ref) => ({ uri: 'file:///c/x.png', mime: 'image/png', w, h }))
    t.alike(await media.sourceFor(dmRef(1), { node, identity: ME }), { unavailable: true }, String(w) + 'x' + String(h))
    t.alike(node.forgotten, ['x.png'], 'the unbounded file is forgotten')
  }
})

test('a pinned URL outlives its eviction until unpinned; clear releases it anyway', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia({ max: 1 })
  const d = display()
  const node = webNode()
  const a = await media.sourceFor(dmRef(1), { node, identity: ME, display: d })
  const unpin = media.pin(a.uri)
  const b = await media.sourceFor(dmRef(2), { node, identity: ME, display: d })
  t.alike(d.revoked, [], 'the shown URL is not revoked on eviction')
  t.is(media.size, 1)
  const again = media.pin(a.uri)
  unpin()
  unpin()
  t.alike(d.revoked, [], 'another holder still shows it')
  again()
  t.alike(d.revoked, [a.uri], 'released when the last holder lets go')
  const unpinB = media.pin(b.uri)
  await media.sourceFor(dmRef(3), { node, identity: ME, display: d })
  media.clear()
  t.alike(d.revoked, [a.uri, 'blob:test/3', b.uri], 'a clear (lock) releases pinned URLs too')
  unpinB()
  t.is(d.revoked.length, 3, 'nothing released twice')
})

test('shouldLoad: a deferred cell reads only after its tap', async (t) => {
  const { shouldLoad } = await load()
  t.is(shouldLoad({ deferred: true, tapped: false }), false)
  t.is(shouldLoad({ deferred: true }), false)
  t.is(shouldLoad({ deferred: true, tapped: true }), true)
  t.is(shouldLoad({ deferred: false, tapped: false }), true)
  t.is(shouldLoad({}), true)
})

test('source: a message request defers chat photos until a tap', (t) => {
  const screen = withoutComments(fs.readFileSync(path.join(__dirname, '../src/screens/Mensagem.js'), 'utf8'))
  t.ok(/<ChatMedia\b[^>]*\bdeferred=\{folder === 'request'\}/.test(screen), 'Mensagem passes the request state')
  const ui = withoutComments(fs.readFileSync(path.join(__dirname, '../src/ui/ChatMedia.js'), 'utf8'))
  t.ok(/const load = shouldLoad\(\{ deferred, tapped \}\)/.test(ui), 'the hook asks shouldLoad')
  t.ok(/if \(key === null \|\| !load\) return undefined\s*\n\s*let alive = true\s*\n\s*sourceFor\(/.test(ui), 'no sourceFor before the effect passes the gate')
  t.is((ui.match(/\bsourceFor\(/g) || []).length, 1, 'sourceFor is called in one place only')
  t.ok(/\[key, attempt, load,/.test(ui), 'accepting the request (load turns true) reads')
  t.ok(/accessibilityLabel=\{MEDIA_TAP_TO_LOAD/.test(ui) && ui.includes("'Toque para ver a foto'"), 'the tap label is announced')
  t.ok(/usePinned\(uri\)/.test(ui), 'cells and the viewer pin what they show')
})

test('private group item: opened by the node only, never fetched', async (t) => {
  const { createChatMedia } = await load()
  let fetched = 0
  const media = createChatMedia({ fetch: async () => { fetched++; return png() } })
  const d = display()
  const node = webNode()
  const item = privateItem()
  const out = await media.sourceFor({ kind: 'group', diary: DIARY, item }, { node, identity: ME, display: d })
  t.is(out.uri, 'blob:test/1')
  t.is(fetched, 0)
  t.alike(node.reads, [{ kind: 'group', diary: DIARY, item }])
  t.alike(await media.sourceFor({ kind: 'group', diary: DIARY, item }, { node: {}, identity: ME, display: d }), { uri: 'blob:test/1', mime: 'image/png', w: 3, h: 2 }, 'a cached entry answers')
})

test('public group item: fetched from the installation, verified, then bounded', async (t) => {
  const { createChatMedia } = await load()
  const bytes = png()
  const item = publicItem(bytes)
  const calls = []
  const media = createChatMedia({ fetch: async (author, desc, deps) => { calls.push({ author, desc, deps }); return png() } })
  const d = display()
  const out = await media.sourceFor({ kind: 'group', diary: DIARY, item }, { identity: ME, display: d })
  t.alike(out, { uri: 'blob:test/1', mime: 'image/png', w: 3, h: 2 })
  t.is(calls[0].author, DIARY)
  t.is(calls[0].desc, item)
  t.is(calls[0].deps.persist, false, 'chat media is not kept in the HTTP cache by default')
  t.is(calls[0].deps.chat, true, 'a chat item, so a public voice note descriptor is accepted')
})

test('public group item: the real fetch checks the SHA-256', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const d = display()
  const body = png()
  const fetch = async () => ({
    status: 200,
    url: '',
    headers: { get: () => String(body.byteLength) },
    arrayBuffer: async () => body.slice().buffer
  })
  const fetchDeps = { fetch, subtle: webcrypto.subtle }
  const good = await media.sourceFor({ kind: 'group', diary: DIARY, item: publicItem(body) }, { identity: ME, display: d, fetchDeps })
  t.is(good.uri, 'blob:test/1')
  const bad = { ...publicItem(body), sha256: '00'.repeat(32), core: '11'.repeat(32) }
  t.alike(await media.sourceFor({ kind: 'group', diary: DIARY, item: bad }, { identity: ME, display: d, fetchDeps }), { unavailable: true })
  t.is(d.made.length, 1)
})

test('public group item: a retryable fetch failure says so', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia({ fetch: async () => { throw Object.assign(new Error('indisponível'), { retryable: true }) } })
  const out = await media.sourceFor({ kind: 'group', diary: DIARY, item: publicItem(png()) }, { identity: ME, display: display() })
  t.alike(out, { unavailable: true, retryable: true })
})

test('lock while a read runs: nothing is kept', async (t) => {
  const { createChatMedia, clearChatMedia } = await load()
  const media = createChatMedia()
  let finish
  const node = nativeNode(() => new Promise((resolve) => { finish = resolve }))
  const pending = media.sourceFor(dmRef(1), { node, identity: ME })
  await new Promise((resolve) => setImmediate(resolve))
  clearChatMedia()
  finish({ uri: 'file:///c/late.png', mime: 'image/png' })
  t.alike(await pending, { unavailable: true })
  t.alike(node.forgotten, ['late.png'], 'the late file is forgotten')
  t.is(media.size, 0)
})

test('one instance cleared: only its own files are forgotten', async (t) => {
  const { createChatMedia } = await load()
  const a = createChatMedia()
  const b = createChatMedia({ max: 1 })
  const node = nativeNode()
  await a.sourceFor(dmRef(1), { node, identity: ME })
  await b.sourceFor(dmRef(2), { node, identity: ME })
  a.clear()
  t.alike(node.forgotten, [id(1) + '.png'], 'the other instance keeps its file')
  t.is(node.cleared, 0, 'no host-wide sweep for one instance')
  await a.sourceFor(dmRef(3), { node, identity: OTHER })
  t.is(node.cleared, 0, 'nor on an identity switch')
  t.is(b.size, 1)
})

test('a read queued before a clear never starts', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia({ concurrency: 1 })
  let finish
  const node = nativeNode((ref) => {
    if (ref.id === id(1)) return new Promise((resolve) => { finish = resolve })
    return { uri: 'file:///c/' + ref.id + '.png', mime: 'image/png' }
  })
  const first = media.sourceFor(dmRef(1), { node, identity: ME })
  const queued = media.sourceFor(dmRef(2), { node, identity: ME })
  await new Promise((resolve) => setImmediate(resolve))
  media.clear()
  finish({ uri: 'file:///c/one.png', mime: 'image/png' })
  t.alike(await first, { unavailable: true })
  t.alike(await queued, { unavailable: true })
  t.alike(node.reads.map((r) => r.id), [id(1)], 'the stale queued read was skipped')
})

test('shared sourceFor and clearChatMedia', async (t) => {
  const { sourceFor, clearChatMedia } = await load()
  const d = display()
  const out = await sourceFor(dmRef(9), { node: webNode(), identity: ME, display: d })
  t.is(out.uri, 'blob:test/1')
  clearChatMedia()
  t.alike(d.revoked, ['blob:test/1'])
})

test('background clears every read file and cached source, only with the capability', async (t) => {
  const { onAppStateChange, sourceFor } = await load()
  let cleared = 0
  const clear = () => { cleared++ }
  t.is(onAppStateChange('background', { canClear: true, clear }), true)
  t.is(cleared, 1, 'background clears')
  for (const state of ['inactive', 'unknown', undefined]) {
    t.is(onAppStateChange(state, { canClear: true, clear }), false, String(state))
  }
  t.is(onAppStateChange('active', { canClear: true, clear }), false, 'active never clears')
  t.is(onAppStateChange('background', { canClear: false, clear }), false, 'no clearReadFiles, no clear')
  t.is(onAppStateChange('background', { clear }), false, 'capability must be stated')
  t.is(cleared, 1)

  const d = display()
  const out = await sourceFor(dmRef(10), { node: webNode(), identity: ME, display: d })
  onAppStateChange('background', { canClear: true })
  t.alike(d.revoked, [out.uri], 'the default clear is clearChatMedia')
})

test('source: App.js subscribes to AppState and calls onAppStateChange', (t) => {
  const code = withoutComments(fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8'))
  t.ok(/import \{[^}]*\bAppState\b[^}]*\} from 'react-native'/.test(code), 'AppState imported')
  t.ok(/AppState\.addEventListener\(\s*'change'[\s\S]{0,120}?onAppStateChange\(/.test(code), 'change listener calls the helper')
  t.ok(/\.remove\(\)/.test(code), 'the subscription is removed on cleanup')
  t.ok(/typeof node\.media\.clearReadFiles === 'function'/.test(code), 'gated on the capability')
})

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

test('source: no third-party host, no network URL for private items, no blob route', (t) => {
  for (const name of ['chatMedia.js', 'fetch.js']) {
    const raw = fs.readFileSync(path.join(__dirname, '../src/media', name), 'utf8')
    const code = withoutComments(raw)
    t.absent(/https?:\/\//i.test(raw), name + ': no http(s) URL literal')
    t.absent(raw.includes('/blob'), name + ': never the /blob route')
    t.absent(/@varanda\/(core|web-member)/.test(code), name + ': no core or web-member import')
  }
  const code = withoutComments(fs.readFileSync(path.join(__dirname, '../src/media/chatMedia.js'), 'utf8'))
  t.absent(/['"`]https?:?['"`]?/i.test(code), 'chatMedia builds no http URL')
  t.absent(/\bfetch\s*\(/.test(code.replace(/fetchMedia/g, '')), 'chatMedia calls no fetch itself')
  t.ok(code.includes("from '@varanda/rpc'"), 'mediaBounds comes from @varanda/rpc')
})

test('photos on screen read again only once the app is active after a background clear', async (t) => {
  const { onAppStateChange, onChatMediaReturn } = await load()
  const clear = () => {}
  // An earlier test left a background clear pending: settle it first.
  onAppStateChange('active', { canClear: true, clear })
  let returns = 0
  const off = onChatMediaReturn(() => { returns++ })
  onAppStateChange('active', { canClear: true, clear })
  t.is(returns, 0, 'no clear, nothing to read again')
  onAppStateChange('background', { canClear: true, clear })
  t.is(returns, 0, 'never while in the background')
  onAppStateChange('inactive', { canClear: true, clear })
  t.is(returns, 0)
  onAppStateChange('active', { canClear: true, clear })
  t.is(returns, 1, 'back in the foreground: read again')
  onAppStateChange('active', { canClear: true, clear })
  t.is(returns, 1, 'once per clear')
  off()
  onAppStateChange('background', { canClear: true, clear })
  onAppStateChange('active', { canClear: true, clear })
  t.is(returns, 1, 'an unsubscribed cell is not told')
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/ui/ChatMedia.js'), 'utf8')
  t.ok(/onChatMediaReturn\(\(\) => setAttempt/.test(src), 'ChatMedia cells read again on return')
})

test('the viewer closes on return from a background clear and a gone item reloads the cell', (t) => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/ui/ChatMedia.js'), 'utf8')
  t.ok(/onChatMediaReturn\(\(\) => setOpen\(null\)\)/.test(src), 'the open viewer closes when its file was cleared')
  t.ok(/\[key, attempt, load, gone, node && node\.media\]/.test(src), 'availability is part of the load effect')
  t.ok(/result\.gone !== gone/.test(src), 'a result for the other availability is not shown')
})

// Voice notes: audio/mp4 bytes pass only through audioBounds (stubbed here,
// tested in packages/rpc), native files only as the worklet answered them.
const voice = () => new Uint8Array([1, 2, 3, 4])
const audioOk = () => ({ ms: 4200 })
const voiceDm = (n) => ({ kind: 'dm', from: FROM, id: id(n), index: 0, item: { mime: 'audio/mp4', w: 0, h: 0, ms: 4200 } })

test('web voice note: audioBounds passes, the bytes become a blob: URL with the duration, then are wiped', async (t) => {
  const { createChatMedia } = await load()
  const checked = []
  const media = createChatMedia({ audioBounds: (b) => { checked.push(b.byteLength); return audioOk() } })
  const d = display()
  let handed = null
  const node = webNode(() => { handed = voice(); return { bytes: handed, mime: 'audio/mp4' } })
  const out = await media.sourceFor(voiceDm(1), { node, identity: ME, display: d })
  t.alike(out, { uri: 'blob:test/1', mime: 'audio/mp4', w: 0, h: 0, ms: 4200 })
  t.alike(checked, [4], 'audioBounds read the bytes')
  t.is(d.made[0].mime, 'audio/mp4')
  t.ok(handed.every((b) => b === 0), 'the plaintext is zero-filled')
})

test('web voice note: refused by audioBounds, over the byte cap or a throwing check: no URL', async (t) => {
  const { createChatMedia, MAX_AUDIO_BYTES } = await load()
  const cases = [
    { bounds: () => null, bytes: voice() },
    { bounds: () => { throw new Error('x') }, bytes: voice() },
    { bounds: () => ({ ms: 0 }), bytes: voice() },
    { bounds: audioOk, bytes: new Uint8Array(MAX_AUDIO_BYTES + 1) }
  ]
  for (const c of cases) {
    const media = createChatMedia({ audioBounds: c.bounds })
    const d = display()
    const node = webNode(() => ({ bytes: c.bytes, mime: 'audio/mp4' }))
    t.alike(await media.sourceFor(voiceDm(1), { node, identity: ME, display: d }), { unavailable: true })
    t.is(d.made.length, 0)
  }
})

test('web voice note: the shown ms is the container one; a declared ms past the tolerance is refused', async (t) => {
  const { createChatMedia } = await load()
  const run = async (declared, containerMs) => {
    const media = createChatMedia({ audioBounds: () => ({ ms: containerMs }), fetch: async () => voice() })
    const d = display()
    const node = webNode(() => ({ bytes: voice(), mime: 'audio/mp4' }))
    const ref = { ...voiceDm(1), item: { mime: 'audio/mp4', w: 0, h: 0, ms: declared } }
    return media.sourceFor(ref, { node, identity: ME, display: d })
  }
  t.is((await run(4200, 4900)).ms, 4900, 'within the tolerance: the container length')
  t.is((await run(4200, 3200)).ms, 3200)
  t.alike(await run(4200, 5201), { unavailable: true }, 'past the tolerance')
  t.alike(await run(1, 120000), { unavailable: true }, 'two minutes claiming 1 ms')
  const media = createChatMedia({ audioBounds: () => ({ ms: 120000 }), fetch: async () => voice() })
  const pub = { core: 'e5'.repeat(32), mime: 'audio/mp4', start: 1, blocks: 1, bytes: 4, sha256: '0b'.repeat(32), width: 0, height: 0, ms: 1 }
  t.alike(await media.sourceFor({ kind: 'group', diary: DIARY, item: pub }, { identity: ME, display: display() }), { unavailable: true }, 'a public descriptor too')
})

test('native voice note: the worklet ms is shown; one past the tolerance is refused and forgotten', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const ok = nativeNode((ref) => ({ uri: 'file:///c/' + ref.id + '.m4a', mime: 'audio/mp4', w: 0, h: 0, ms: 4900 }))
  t.is((await media.sourceFor(voiceDm(1), { node: ok, identity: ME })).ms, 4900, 'the container length')
  const far = nativeNode(() => ({ uri: 'file:///c/z.m4a', mime: 'audio/mp4', w: 0, h: 0, ms: 120000 }))
  t.alike(await media.sourceFor(voiceDm(2), { node: far, identity: ME }), { unavailable: true })
  t.alike(far.forgotten, ['z.m4a'])
})

test('voice note: an image answer for an audio item, or audio for an image item, is refused', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia({ audioBounds: audioOk })
  const d = display()
  t.alike(await media.sourceFor(voiceDm(1), { node: webNode(), identity: ME, display: d }), { unavailable: true })
  const node = webNode(() => ({ bytes: voice(), mime: 'audio/mp4' }))
  t.alike(await media.sourceFor(dmRef(2), { node, identity: ME, display: d }), { unavailable: true })
  t.is(d.made.length, 0)
})

test('native voice note: the worklet file with w/h 0 is accepted; a sized answer is refused and forgotten', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const ok = nativeNode((ref) => ({ uri: 'file:///c/' + ref.id + '.m4a', mime: 'audio/mp4', w: 0, h: 0 }))
  t.alike(await media.sourceFor(voiceDm(1), { node: ok, identity: ME }), { uri: 'file:///c/' + id(1) + '.m4a', mime: 'audio/mp4', w: 0, h: 0, ms: 4200 })
  const bad = nativeNode(() => ({ uri: 'file:///c/y.m4a', mime: 'audio/mp4', w: 3, h: 2 }))
  t.alike(await media.sourceFor(voiceDm(2), { node: bad, identity: ME }), { unavailable: true })
  t.alike(bad.forgotten, ['y.m4a'])
  const remote = nativeNode(() => ({ uri: 'https://example.com/y.m4a', mime: 'audio/mp4', w: 0, h: 0 }))
  t.alike(await media.sourceFor(voiceDm(3), { node: remote, identity: ME }), { unavailable: true })
})

test('private group voice note is opened by the node; a public audio descriptor is fetched then checked', async (t) => {
  const { createChatMedia, isAudioDescriptor, isVoiceItem } = await load()
  const media = createChatMedia({ audioBounds: audioOk, fetch: async () => voice() })
  const d = display()
  const priv = { ...privateItem(), plainMime: 'audio/mp4', w: 0, h: 0, ms: 4200 }
  const node = webNode(() => ({ bytes: voice(), mime: 'audio/mp4' }))
  const a = await media.sourceFor({ kind: 'group', diary: DIARY, item: priv }, { node, identity: ME, display: d })
  t.is(a.mime, 'audio/mp4')
  const pub = { core: 'e5'.repeat(32), mime: 'audio/mp4', start: 1, blocks: 1, bytes: 4, sha256: '0b'.repeat(32), width: 0, height: 0, ms: 4200 }
  t.ok(isAudioDescriptor(pub))
  t.absent(isAudioDescriptor({ ...pub, width: 3 }))
  t.absent(isAudioDescriptor({ ...pub, mime: 'video/mp4' }))
  t.absent(isAudioDescriptor({ ...pub, ms: 120001 }))
  const b = await media.sourceFor({ kind: 'group', diary: DIARY, item: pub }, { identity: ME, display: d })
  t.alike(b, { uri: 'blob:test/2', mime: 'audio/mp4', w: 0, h: 0, ms: 4200 })
  t.ok(isVoiceItem(priv) && isVoiceItem(pub) && isVoiceItem({ mime: 'audio/mp4' }))
  t.absent(isVoiceItem(privateItem()) || isVoiceItem(null))
})

test('one voice note plays at a time', async (t) => {
  const { claimPlayback, stopPlayback } = await load()
  const paused = []
  const a = { pause () { paused.push('a') } }
  const b = { pause () { paused.push('b') } }
  const releaseA = claimPlayback(a)
  claimPlayback(a)
  t.alike(paused, [], 'claiming again does not pause itself')
  claimPlayback(b)
  t.alike(paused, ['a'], 'the previous player is paused')
  releaseA()
  stopPlayback()
  t.alike(paused, ['a', 'b'], 'a stale release does not forget the current player')
  stopPlayback()
  t.alike(paused, ['a', 'b'])
  t.is(typeof claimPlayback(null), 'function')
})

test('bytesFor: a public voice note comes back as checked bytes, never through a display URL', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia({ audioBounds: audioOk, fetch: async () => voice() })
  const pub = { core: 'e5'.repeat(32), mime: 'audio/mp4', start: 1, blocks: 1, bytes: 4, sha256: '0b'.repeat(32), width: 0, height: 0, ms: 4200 }
  const out = await media.bytesFor({ kind: 'group', diary: DIARY, item: pub }, { identity: ME })
  t.alike(Array.from(out.bytes), [1, 2, 3, 4])
  t.is(out.mime, 'audio/mp4')
  t.is(out.ms, 4200)
  t.is(out.w, 0)
  t.is(media.size, 0, 'nothing cached')
  const refused = createChatMedia({ audioBounds: () => null, fetch: async () => voice() })
  t.is(await refused.bytesFor({ kind: 'group', diary: DIARY, item: pub }, { identity: ME }), null, 'bounds still apply')
  const throws = createChatMedia({ fetch: async () => { throw new Error('x') } })
  t.is(await throws.bytesFor({ kind: 'group', diary: DIARY, item: pub }, { identity: ME }), null)
})

test('bytesFor: a node file is read through ctx.readFile then forgotten; node bytes are bounded', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia({ audioBounds: audioOk })
  const native = nativeNode(() => ({ uri: 'file:///c/abc.bin', mime: 'audio/mp4', w: 0, h: 0, ms: 4200 }))
  const read = []
  const out = await media.bytesFor(voiceDm(1), { node: native, identity: ME, readFile: async (uri) => { read.push(uri); return voice() } })
  t.alike(read, ['file:///c/abc.bin'])
  t.alike(Array.from(out.bytes), [1, 2, 3, 4])
  t.alike(native.forgotten, ['abc.bin'], 'the plaintext file is forgotten at once')
  const noReader = nativeNode(() => ({ uri: 'file:///c/def.bin', mime: 'audio/mp4' }))
  t.is(await media.bytesFor(voiceDm(2), { node: noReader, identity: ME }), null)
  t.alike(noReader.forgotten, ['def.bin'])
  const web = webNode(() => ({ bytes: png(), mime: 'image/png' }))
  const img = await media.bytesFor(dmRef(3), { node: web, identity: ME })
  t.alike({ mime: img.mime, w: img.w, h: img.h }, { mime: 'image/png', w: 3, h: 2 })
  t.is(await media.bytesFor(dmRef(4), { node: webNode(() => ({ bytes: voice(), mime: 'audio/mp4' })), identity: ME }), null, 'a mime other than promised')
  t.is(await media.bytesFor({ ...dmRef(5), item: { unavailable: true } }, { node: web, identity: ME }), null)
})

test('sourceFor cachedOnly: a hit answers, a miss reads nothing', async (t) => {
  const { createChatMedia } = await load()
  const media = createChatMedia()
  const node = webNode()
  const d = display()
  t.alike(await media.sourceFor(dmRef(1), { node, identity: ME, display: d, cachedOnly: true }), { unavailable: true })
  t.is(node.reads.length, 0, 'no read on a miss')
  const first = await media.sourceFor(dmRef(1), { node, identity: ME, display: d })
  t.alike(await media.sourceFor(dmRef(1), { node, identity: ME, display: d, cachedOnly: true }), first)
  t.is(node.reads.length, 1)
})
