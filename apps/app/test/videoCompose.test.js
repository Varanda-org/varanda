'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const rpc = require('@varanda/rpc')
const source = readFileSync(join(__dirname, '../src/screens/Publicar.js'), 'utf8')
const load = () => import('../src/videoCompose.js')
const plan = () => import('../src/media/plan.js')
const deferred = () => {
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  return { promise, resolve }
}

// The preparation boundary supplies stripped bytes; no binary fixture is read.
function clip (overrides = {}) {
  const ftyp = Buffer.alloc(24)
  ftyp.writeUInt32BE(24)
  ftyp.write('ftypisom', 4)
  ftyp.write('isomavc1', 16)
  return {
    bytes: new Uint8Array(ftyp),
    mime: 'video/mp4',
    width: 640,
    height: 360,
    ms: 3000,
    poster: { bytes: new Uint8Array([255, 216, 255, 217]), mime: 'image/jpeg', width: 640, height: 360 },
    ...overrides
  }
}

function descriptor (file, start = 1) {
  const d = {
    core: 'ab'.repeat(32),
    sha256: 'cd'.repeat(32),
    start,
    blocks: Math.ceil(file.bytes.length / 32768),
    bytes: file.bytes.length,
    mime: file.mime,
    width: file.width,
    height: file.height
  }
  if (file.mime === 'video/mp4') d.ms = file.ms
  return d
}

async function stage (draft, file = clip()) {
  await draft.pick({ pickVideo: async () => ({}), prepareVideo: async () => file })
  return file
}

// Evaluate the real screen functions, injecting only their surroundings.
function body (head) {
  const at = source.indexOf(head)
  if (at < 0) throw new Error('Missing function: ' + head)
  const open = source.indexOf('{', source.indexOf(')', at))
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error('Unclosed function: ' + head)
}

function evaluate (head, signature, deps) {
  return new Function(...Object.keys(deps), 'return ' + signature + ' ' + body(head))(...Object.values(deps)) // eslint-disable-line no-new-func
}

function hooks () {
  const slots = []
  let cursor = 0
  let effects = []
  let dirty = false
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const api = {
    useRef (current) {
      const i = cursor++
      if (!slots[i]) slots[i] = { current }
      return slots[i]
    },
    useState (value) {
      const i = cursor++
      if (!slots[i]) slots[i] = { value }
      return [slots[i].value, (next) => {
        const v = typeof next === 'function' ? next(slots[i].value) : next
        if (!Object.is(v, slots[i].value)) { slots[i].value = v; dirty = true }
      }]
    },
    useCallback (fn, deps) {
      const i = cursor++
      if (!slots[i] || !same(deps, slots[i].deps)) slots[i] = { value: fn, deps }
      return slots[i].value
    },
    useEffect (fn, deps) {
      const i = cursor++
      if (!slots[i] || !same(deps, slots[i].deps)) {
        effects.push({ i, fn, cleanup: slots[i]?.cleanup })
        slots[i] = { deps }
      }
    }
  }
  return {
    api,
    render (fn) {
      let value
      do {
        dirty = false
        cursor = 0
        value = fn()
        const pending = effects
        effects = []
        for (const effect of pending) effect.cleanup?.()
        for (const effect of pending) slots[effect.i].cleanup = effect.fn()
      } while (dirty)
      return value
    },
    unmount () { for (const slot of slots) slot.cleanup?.() }
  }
}

async function momentHarness ({ file = null, request = async () => ({}), putMoment, prepareVideo = async () => clip() } = {}) {
  const mod = await load()
  const h = hooks()
  const photo = {
    items: file ? [{ id: 1, file }] : [],
    files: file ? [file] : [],
    ready: !!file,
    remove () { photo.items = []; photo.files = []; photo.ready = false },
    clear () { photo.remove() },
    pick: async () => {}
  }
  const deps = {
    ...h.api,
    ...mod,
    useChatAttachments: () => photo,
    pickVideo: async () => ({}),
    prepareVideo,
    urlFromBytes: () => 'test:poster',
    revokeUrl: () => {},
    MOMENT_TEXT_MAX: 200,
    momentLength: (text) => [...text].length,
    MOMENT_ONE_PHOTO: 'Um momento leva uma foto só.',
    MOMENT_LOCKED: 'locked',
    MOMENT_STALE: 'stale',
    MOMENT_UNCERTAIN: 'uncertain',
    MEDIA_STALE: 'prepare a mídia de novo',
    isLocked: (err) => err.code === 'LOCKED',
    refusalOf: () => '',
    errorText: (err) => err.message,
    momentsChanged: () => {}
  }
  // Destructuring is part of the real functions' signatures.
  deps.momentValid = evaluate('export function momentValid', 'function ({ files, ready, text, video = null, preparing = false })', deps)
  deps.useVideoDraft = evaluate('function useVideoDraft', 'function ({ active, moment = false })', deps)
  const useMomentDraft = evaluate('function useMomentDraft', 'function ({ node, open, active })', deps)
  const calls = []
  const node = {
    online: true,
    media: {
      video: true,
      putMoment: async (arg) => { calls.push(['put', arg]); return putMoment ? putMoment(arg) : { id: 1 } }
    },
    passkey: { status: { unlocked: true } },
    request: async (method, params) => { calls.push([method, params]); return request(method, params) }
  }
  const args = { node, open: true, active: true }
  return { calls, node, args, photo, render: () => h.render(() => useMomentDraft(args)), unmount: h.unmount }
}

async function postHarness ({ request = async () => ({ seq: 1 }), upload, photo = null, quote = null, reply = null } = {}) {
  const mod = await load()
  const draft = mod.createVideoDraft()
  const file = photo || await stage(draft)
  const calls = []
  let error = ''
  let published = false
  let draftText = ''
  const items = photo ? [{ id: 1, encoded: photo }] : []
  const scope = {
    ...mod,
    busy: false,
    uploadingRef: { current: false },
    video: { draft },
    setCheckError: (value) => { error = value },
    pageRetryRef: { current: null },
    refusalOf: () => '',
    asPage: null,
    text: '',
    reply,
    quote,
    countChars: (v) => [...v].length,
    hasVideo: !photo,
    hasMedia: true,
    mediaReady: true,
    mediaOnline: true,
    canVideo: true,
    items,
    media: { upload: async (arg) => { calls.push(['upload', arg]); return upload ? upload(arg) : descriptor(arg, calls.length) } },
    setUploading: () => {},
    offlineQueue: false,
    errorText: (err) => err.message,
    linkDraft: { take: () => { throw new Error('Video must suppress the preview') } },
    withCardFallback: (build, card) => ({ op: build(card) }),
    node: {
      online: true,
      request: async (method, params) => {
        calls.push([method, params])
        return method === 'log.read' ? { entries: [] } : request(method, params)
      }
    },
    action: {
      run: async (fn) => {
        try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, uncertain: err.uncertain === true } }
      }
    },
    confirm: () => {},
    seqOf: (value) => value.seq,
    published: (sent) => { published = true; draftText = sent; draft.clear() },
    canQueue: false,
    setChecking: () => {},
    lastSeqRef: { current: null },
    genRef: { current: 0 },
    liveRef: { current: new Set([1]) },
    patch: () => {},
    validDescriptor: (await import('../src/media/fetch.js')).validDescriptor
  }
  scope.uploadAll = evaluate('const uploadAll = async', 'async function (list, page = null)', scope)
  return {
    draft,
    file,
    calls,
    scope,
    send: () => evaluate('const send = async () => {\n    if (busy ||', 'async function ()', scope)(),
    get error () { return error },
    get published () { return published },
    get text () { return draftText }
  }
}

test('video capability is explicit, online, personal, and needs both functions', async (t) => {
  const { canComposeVideo } = await load()
  const args = { node: { online: true, media: { video: true } }, pickVideo () {}, prepareVideo () {} }
  t.ok(canComposeVideo(args))
  t.absent(canComposeVideo({ ...args, asPage: 'page' }))
  t.absent(canComposeVideo({ ...args, node: { ...args.node, online: false } }))
  t.absent(canComposeVideo({ ...args, node: { media: {} } }))
  t.absent(canComposeVideo({ ...args, pickVideo: null }))
  t.absent(canComposeVideo({ ...args, prepareVideo: null }))
})

test('video excludes photos and link previews without discarding either', async (t) => {
  const mod = await load()
  const draft = mod.createVideoDraft()
  let picks = 0
  for (const selection of [{ photos: 1 }, { preview: true }]) {
    await t.exception(draft.pick({ ...selection, pickVideo: () => { picks++ } }))
    t.is(draft.state.phase, 'empty')
    t.absent(mod.videoPostValid({ file: clip(), ...selection }))
  }
  t.is(picks, 0)
  t.is(mod.videoConflict({ photos: 1 }), 'Um vídeo ou fotos, não os dois.')
  t.is(mod.videoConflict({ photos: 1, moment: true }), 'Um momento leva uma foto ou um vídeo.')
  t.ok(mod.videoPostValid({ file: clip() }))
  t.absent(mod.videoPostValid({ file: clip(), quote: true }))
  t.ok(mod.videoPostValid({ file: clip(), quote: true, text: 'oi' }))
  t.absent(mod.videoPostValid({ file: clip(), text: 'x'.repeat(rpc.MAX_TEXT + 1) }))
})

test('post and moment preparation receive and enforce their own two caps', async (t) => {
  const mod = await load()
  const p = await plan()
  for (const moment of [false, true]) {
    const maxMs = moment ? p.MAX_MOMENT_VIDEO_MS : p.MAX_VIDEO_MS
    const maxBytes = moment ? p.MAX_MOMENT_VIDEO_BYTES : p.MAX_VIDEO_BYTES
    const draft = mod.createVideoDraft({ moment })
    let options
    await draft.pick({ pickVideo: async () => ({}), prepareVideo: async (_, opts) => { options = opts; return clip() } })
    t.is(options.maxMs, maxMs)
    t.is(options.maxBytes, maxBytes)
    t.absent(options.signal.aborted)
    t.ok(mod.readyVideo(clip({ ms: maxMs, bytes: new Uint8Array(maxBytes) }), moment))
    t.absent(mod.readyVideo(clip({ ms: maxMs + 1 }), moment))
    t.absent(mod.readyVideo(clip({ bytes: new Uint8Array(maxBytes + 1) }), moment))
    t.absent(mod.readyVideo(clip({ poster: null }), moment))
  }
})

test('picking uploads nothing, then Publicar uploads poster before video and sends the pair', async (t) => {
  for (const kind of ['create', 'reply', 'quote']) {
    const h = await postHarness({ reply: kind === 'reply' ? { ref: 'reply' } : null, quote: kind === 'quote' ? { ref: 'quote' } : null })
    h.scope.text = kind === 'quote' ? 'citação' : ''
    t.alike(h.calls, [], 'nothing sent before Publicar')
    await h.send()
    t.alike(h.calls.map(([op, arg]) => op === 'upload' ? arg.mime : op), ['image/jpeg', 'video/mp4', 'post.' + kind])
    t.alike(Object.keys(h.calls[0][1]).sort(), ['bytes', 'height', 'mime', 'width'])
    t.is(h.calls[1][1].kind, 'video')
    t.is(h.calls[1][1].ms, 3000)
    t.alike(h.calls[2][1].media, [descriptor(h.file.poster, 1), descriptor(h.file, 2)])
    t.ok(h.published)
  }
})

test('failed video leaves the post unsent, reports full core and reuses its poster on a new press', async (t) => {
  let failed = false
  const h = await postHarness({
    upload: async (arg) => {
      if (arg.kind === 'video' && !failed) { failed = true; throw new Error('espaço de fotos deste aparelho esgotado') }
      return descriptor(arg)
    }
  })
  await h.send()
  t.is(h.error, 'Este aparelho não tem mais espaço para fotos e vídeos.')
  t.absent(h.published)
  t.is(h.calls.length, 2, 'no create or automatic retry')
  t.is(h.draft.state.phase, 'ready')
  await h.send()
  t.alike(h.calls.map(([op, arg]) => op === 'upload' ? arg.mime : op), ['image/jpeg', 'video/mp4', 'video/mp4', 'post.create'])
})

test('invalid upload answers cannot publish and a bad poster prevents uploading the video', async (t) => {
  for (const bad of ['image/jpeg', 'video/mp4']) {
    const h = await postHarness({ upload: async (arg) => arg.mime === bad ? { ...descriptor(arg), ms: -1 } : descriptor(arg) })
    await h.send()
    t.absent(h.published)
    t.ok(h.error.includes('Resposta inválida'))
    t.is(h.calls.length, bad === 'image/jpeg' ? 1 : 2)
  }
})

test('known create failure keeps both descriptors for the next explicit press', async (t) => {
  let attempts = 0
  const h = await postHarness({ request: async () => { if (++attempts === 1) throw new Error('known'); return { seq: 1 } } })
  await h.send()
  t.absent(h.published)
  t.is(h.draft.state.phase, 'ready')
  t.is(attempts, 1)
  await h.send()
  t.alike(h.calls.map(([op]) => op), ['upload', 'upload', 'post.create', 'post.create'])
  t.ok(h.published)
})

test('uncertain post create keeps the draft and checks the diary without resending', async (t) => {
  const h = await postHarness({ request: async () => { throw Object.assign(new Error('uncertain'), { uncertain: true }) } })
  await h.send()
  t.alike(h.calls.map(([op]) => op), ['upload', 'upload', 'post.create', 'log.read'])
  t.absent(h.published)
  t.is(h.draft.state.file, h.file)
})

test('mode switch, removal and unmount abort preparation and discard its late result', async (t) => {
  for (const action of ['switch', 'remove', 'unmount']) {
    const wait = deferred()
    let signal
    const h = await momentHarness({ prepareVideo: async (_, opts) => { signal = opts.signal; return wait.promise } })
    const picking = h.render().pickClip()
    await Promise.resolve()
    t.is(h.render().video.state.phase, 'preparing')
    t.absent(h.render().valid)
    t.absent(await h.render().send())
    if (action === 'switch') { h.args.active = false; h.render() }
    if (action === 'remove') h.render().removeVideo()
    if (action === 'unmount') h.unmount()
    t.ok(signal.aborted)
    wait.resolve(clip())
    await picking
    if (action !== 'unmount') t.is(h.render().video.state.phase, 'empty')
    t.alike(h.calls, [])
  }
})

test('only one preparation runs, and cancel or null leaves no draft', async (t) => {
  const { createVideoDraft } = await load()
  const draft = createVideoDraft()
  const wait = deferred()
  const first = draft.pick({ pickVideo: () => wait.promise, prepareVideo: async () => clip() })
  t.absent(await draft.pick({ pickVideo: () => { throw new Error('second pick') } }))
  t.is(await draft.upload(() => { throw new Error('early upload') }), null)
  draft.clear()
  wait.resolve({})
  t.absent(await first)
  t.is(draft.state.phase, 'empty')
  t.absent(await draft.pick({ pickVideo: async () => null }))
  t.absent(await draft.pick({ pickVideo: async () => ({}), prepareVideo: async () => null }))
  t.is(draft.state.phase, 'empty')
})

test('a draft cleared while the picker is open still hands the pick over, aborted, so its copy is deleted', async (t) => {
  const { createVideoDraft } = await load()
  const draft = createVideoDraft()
  const wait = deferred()
  const picked = { uri: 'file:///cache/ImagePicker/a.mov' }
  const seen = []
  const picking = draft.pick({ pickVideo: () => wait.promise, prepareVideo: async (asset, opts) => { seen.push({ asset, aborted: opts.signal.aborted }); return null } })
  draft.clear()
  wait.resolve(picked)
  t.absent(await picking)
  t.is(seen.length, 1, 'prepareVideo called once')
  t.is(seen[0].asset, picked, 'with the picked asset')
  t.ok(seen[0].aborted, 'and an aborted signal')
  t.is(draft.state.phase, 'empty')
  t.is(draft.state.file, null)
})

test('moment video uses a copy, no poster upload, then moment.create', async (t) => {
  const h = await momentHarness({ putMoment: async (arg) => { arg.bytes.fill(0); return { id: 4 } } })
  await h.render().pickClip()
  const file = h.render().video.state.file
  const before = file.bytes.slice()
  t.ok(h.render().valid)
  t.alike(h.calls, [])
  t.ok(await h.render().send())
  t.alike(h.calls.map(([op]) => op), ['put', 'moment.create'])
  t.is(h.calls[0][1].kind, 'video')
  t.is(h.calls[0][1].ms, file.ms)
  t.not(h.calls[0][1].bytes, file.bytes)
  t.alike(file.bytes, before)
  t.alike(h.calls[1][1], { text: '', media: { id: 4 } })
})

test('uncertain moment holds its video and blocks a second press', async (t) => {
  const h = await momentHarness({ request: async () => { throw Object.assign(new Error('lost'), { uncertain: true }) } })
  await h.render().pickClip()
  t.absent(await h.render().send())
  t.ok(h.render().held)
  t.absent(h.render().valid)
  t.ok(h.render().video.state.file)
  t.absent(await h.render().send())
  t.alike(h.calls.map(([op]) => op), ['put', 'moment.create'])
})

test('moment validity accepts a photo or a video, never both, and bounds its caption', async (t) => {
  const mod = await load()
  const valid = evaluate('export function momentValid', 'function ({ files, ready, text, video = null, preparing = false })', {
    ...mod, momentLength: (text) => [...text].length, MOMENT_TEXT_MAX: 200
  })
  const base = { files: [], ready: false, text: '', video: clip() }
  t.ok(valid(base))
  t.absent(valid({ ...base, preparing: true }))
  t.absent(valid({ ...base, files: [clip().poster], ready: true }))
  t.absent(valid({ ...base, text: '😀'.repeat(201) }))
  t.ok(valid({ ...base, text: '😀'.repeat(200) }))
  t.absent(valid({ ...base, video: clip({ ms: 15001 }) }))
  t.ok(valid({ files: [clip().poster], ready: true, text: '' }))
})

test('photo post and photo moment keep their original payloads', async (t) => {
  const photo = clip().poster
  const post = await postHarness({ photo })
  await post.send()
  t.alike(post.calls.map(([op]) => op), ['upload', 'post.create'])
  t.alike(Object.keys(post.calls[0][1]).sort(), ['bytes', 'height', 'mime', 'onProgress', 'width'])
  t.alike(post.calls[1][1], { text: '', media: [descriptor(photo, 1)] })
  const moment = await momentHarness({ file: photo })
  t.ok(moment.render().valid)
  t.ok(await moment.render().send())
  t.alike(Object.keys(moment.calls[0][1]).sort(), ['bytes', 'height', 'mime', 'width'])
  t.alike(moment.calls[1], ['moment.create', { text: '', media: { id: 1 } }])
})

test('moment lock, stale item and known create failure preserve explicit retry semantics', async (t) => {
  for (const failure of ['locked', 'stale', 'known']) {
    let attempts = 0
    const h = await momentHarness({
      request: async () => {
        if (++attempts > 1) return {}
        if (failure === 'locked') throw Object.assign(new Error('locked'), { code: 'LOCKED' })
        throw new Error(failure === 'stale' ? 'prepare a mídia de novo' : 'known')
      }
    })
    await h.render().pickClip()
    const file = h.render().video.state.file
    t.absent(await h.render().send())
    t.absent(h.render().held)
    t.is(h.render().video.state.file, file)
    t.is(attempts, 1, 'no automatic retry')
    t.ok(h.render().error.includes(failure === 'stale' ? 'vídeo precisa ser preparado' : failure))
    t.ok(await h.render().send())
    t.is(h.calls.filter(([op]) => op === 'put').length, failure === 'stale' ? 2 : 1)
  }
})

test('switching away during putMoment keeps its item but never creates the late moment', async (t) => {
  const wait = deferred()
  const h = await momentHarness({ putMoment: () => wait.promise })
  await h.render().pickClip()
  const sending = h.render().send()
  h.args.active = false
  h.render()
  wait.resolve({ id: 9 })
  t.absent(await sending)
  t.alike(h.calls.map(([op]) => op), ['put'])
  h.args.active = true
  t.ok(await h.render().send())
  t.alike(h.calls.map(([op]) => op), ['put', 'moment.create'])
  t.alike(h.calls[1][1].media, { id: 9 })
})

test('removing a video during upload drops late success and late failure', async (t) => {
  const { createVideoDraft } = await load()
  for (const fail of [false, true]) {
    const draft = createVideoDraft()
    await stage(draft)
    const wait = deferred()
    let uploads = 0
    const sending = draft.upload(async (file) => {
      uploads++
      await wait.promise
      if (fail) throw new Error('late failure')
      return descriptor(file)
    })
    draft.clear()
    wait.resolve()
    t.is(await sending, null)
    t.is(uploads, 1, 'no video after a discarded poster upload')
    t.is(draft.state.phase, 'empty')
  }
})

test('preparation refusals are visible and do not become an uploadable draft', async (t) => {
  const message = 'Escolha um vídeo de até 15 segundos.'
  const h = await momentHarness({ prepareVideo: async () => { throw new Error(message) } })
  await h.render().pickClip()
  t.is(h.render().error, message)
  t.is(h.render().video.state.phase, 'empty')
  t.absent(h.render().valid)
  t.alike(h.calls, [])
})

test('a photo picker that never settles blocks neither the video nor Publicar', async (t) => {
  const h = await momentHarness()
  h.photo.pick = () => new Promise(() => {})
  h.render().pick()
  await h.render().pickClip()
  t.is(h.render().video.state.phase, 'ready', 'Vídeo still works')
  t.ok(h.render().valid)
  t.ok(await h.render().send(), 'Publicar still works')
  const staged = await momentHarness({ file: clip().poster })
  staged.photo.pick = () => new Promise(() => {})
  staged.render().pick()
  t.ok(await staged.render().send(), 'a pending Trocar foto does not block the staged photo')
})

test('a photo that arrives once a video is staged is dropped with the note', async (t) => {
  const { MOMENT_ONE_MEDIA } = await load()
  const h = await momentHarness()
  await h.render().pickClip()
  h.photo.items = [{ id: 9, file: clip().poster }]
  h.photo.files = [clip().poster]
  h.photo.ready = true
  const view = h.render()
  t.alike(h.photo.items, [])
  t.is(view.note, MOMENT_ONE_MEDIA)
  t.is(view.video.state.phase, 'ready')
})

test('two photos in a momento name video only where video is offered', async (t) => {
  const { MOMENT_ONE_MEDIA } = await load()
  for (const video of [true, false]) {
    const h = await momentHarness()
    h.node.media.video = video
    h.photo.items = [{ id: 1, file: clip().poster }, { id: 2, file: clip().poster }]
    const view = h.render()
    t.is(view.note, video ? MOMENT_ONE_MEDIA : 'Um momento leva uma foto só.')
  }
})

test('a picker failure shows a fixed text and leaves no draft', async (t) => {
  const { createVideoDraft, VIDEO_PICK_FAILED } = await load()
  for (const rejection of [new Error('Permission denied'), 'boom', undefined]) {
    const draft = createVideoDraft()
    let err = null
    try {
      await draft.pick({ pickVideo: () => Promise.reject(rejection), prepareVideo: async () => clip() })
    } catch (e) { err = e }
    t.is(err && err.message, VIDEO_PICK_FAILED)
    t.is(draft.state.phase, 'empty')
  }
})

test('a post photo pick is never blocked by an earlier one and adds nothing once a video is staged', (t) => {
  t.absent(/pickingRef/i.test(source), 'no in-flight flag that a pending picker could leave set')
  const attach = body('const attach = async')
  const after = attach.slice(attach.indexOf('await pickImages()'))
  t.ok(after.includes("if (video.draft.state.phase !== 'empty') { setNote(VIDEO_OR_PHOTOS); return }"), 'rechecks the video after the picker')
})

test('a late post success clears only the video that was sent', async (t) => {
  const { createVideoDraft } = await load()
  const draft = createVideoDraft()
  const sent = await stage(draft)
  draft.clear()
  const next = await stage(draft)
  const published = evaluate('const published = (sent,', 'function (sent, sentReply, sentIds = [], sentQuote = null)', {
    video: { draft }, tap: () => {}, setText: () => {}, removeItems: () => {}, onPublished: () => {}
  })
  published('', null, [sent])
  t.is(draft.state.file, next)
  published('', null, [next])
  t.is(draft.state.phase, 'empty')
})

test('a quote cannot send a video without text', async (t) => {
  const h = await postHarness({ quote: { ref: 'quote' } })
  await h.send()
  t.alike(h.calls, [])
  t.absent(h.published)
})
