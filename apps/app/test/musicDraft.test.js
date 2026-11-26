'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const source = fs.readFileSync(path.join(__dirname, '../src/screens/Publicar.js'), 'utf8')
const rules = () => import('../src/musicDraft.js')
const track = { id: 'abc', title: 'Canção', artist: 'Artista', duration: 180, url: 'https://audius.co/artist/song' }
const draft = { ref: { kind: 'track', id: track.id, start: null }, item: track }
const target = { ref: 'b'.repeat(64) + ':1' }

// The send bodies read the description draft (alts, videoAlt) and its helpers.
// No description typed in these drafts, so neither helper has a list to build.
function altScope () {
  return { altParam: () => null, videoAltParam: () => null, alts: {}, videoAlt: '' }
}

test('the sticker names the choice, edits on tap and removes separately', async (t) => {
  const { transformSync } = require('@babel/core')
  const stickerSource = fs.readFileSync(path.join(__dirname, '../src/ui/MusicSticker.js'), 'utf8')
  const colors = { line: 'line', card: 'card', ink: 'ink', soft: 'soft' }
  const deps = {
    rpc: require('@varanda/rpc'),
    ...await import('../src/music.js'),
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) },
    ...Object.fromEntries(['View', 'Text', 'Pressable', 'MusicCover', 'Pill'].map((name) => [name, name])),
    StyleSheet: { create: (styles) => styles },
    useStyles: (make) => make(colors),
    useTheme: () => ({ colors }),
    layout: { hit: 44 },
    radius: { lg: 16 },
    space: { sm: 8 },
    useMusicCover: () => null
  }
  const input = stickerSource.replace(/^import .+\n/gm, '').replace(/\bexport /g, '')
  const { code } = transformSync(input, { configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-react-jsx'] })
  // eslint-disable-next-line no-new-func
  const MusicSticker = new Function(...Object.keys(deps), code + '\nreturn MusicSticker')(...Object.values(deps))
  let edits = 0
  let removals = 0
  const props = { onPress: () => { edits++ }, onRemove: () => { removals++ } }
  const choice = { ref: { kind: 'snippet', id: track.id, start: 72 }, item: { ...track, title: 'Can\u0000ção', artist: 'RIXX' } }
  const tree = MusicSticker({ ...props, choice })
  const [main, remove] = tree.children
  const [cover, words] = main.children
  t.is(tree.type, 'View')
  t.is(main.type, 'Pressable')
  t.is(main.props.accessibilityRole, 'button')
  t.is(main.props.accessibilityLabel, 'Editar música')
  t.is(main.props.accessibilityHint, deps.rpc.displayText(choice.item.title) + ', ' + 'RIXX · 1:12', 'the hint carries the title and the line')
  t.alike(main.props.accessibilityState, { disabled: false })
  t.is(main.props.disabled, false)
  t.is(cover.type, 'MusicCover')
  t.is(cover.props.size, 44)
  t.is(words.children[0].children[0], deps.rpc.displayText(choice.item.title))
  t.is(words.children[1].children[0], 'RIXX · 1:12')
  t.is(words.children[0].props.numberOfLines, 1)
  t.is(words.children[1].props.numberOfLines, 1)
  t.is(words.children[0].props.style.fontWeight, '700')
  t.is(words.children[1].props.style.color, colors.soft)
  t.alike(tree.props.style, { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, minHeight: 44, gap: 8, padding: 8 })
  t.is(remove.type, 'Pill', 'remove is a sibling of the edit control')
  t.is(remove.props.icon, 'fechar')
  t.is(remove.props.accessibilityLabel, 'Remover música')
  remove.props.onPress()
  t.is(removals, 1)
  t.is(edits, 0, 'removing does not edit')
  main.props.onPress()
  t.is(edits, 1)
  for (const [kind, expected] of [['track', 'RIXX · Faixa inteira'], ['playlist', 'Playlist · 3 faixas']]) {
    const card = MusicSticker({ ...props, choice: { ref: { ...choice.ref, kind, start: null }, item: { ...choice.item, count: 3 } } })
    t.is(card.children[0].children[1].children[1].children[0], expected)
  }
  const unsafe = MusicSticker({ ...props, choice: { ...choice, item: { ...choice.item, artist: 'RI\u202eXX' } } })
  t.is(unsafe.children[0].children[1].children[1].children[0], deps.rpc.displayText('RI\u202eXX · 1:12'))
  for (const onRemove of [undefined, null, true]) {
    const card = MusicSticker({ ...props, choice, onRemove })
    t.is(card.children[1], null, 'no remove control without a function')
  }
  for (const overrides of [{ disabled: true }, { onPress: undefined }, { onPress: null }, { onPress: true }]) {
    const card = MusicSticker({ ...props, choice, ...overrides })
    const edit = card.children[0]
    t.is(edit.props.disabled, true)
    t.alike(edit.props.accessibilityState, { disabled: true })
    t.is(edit.props.onPress, undefined)
    t.is(card.children[1].props.disabled, overrides.disabled)
  }
  t.ok(stickerSource.includes('displayText(choice.item.title)'))
  t.ok(stickerSource.includes('displayText(musicStickerLine('))
  t.ok(/card: \{ alignSelf: 'stretch',/.test(stickerSource), 'the sticker fills the width even under a flex-start parent')
  t.absent(stickerSource.includes('\u2014'))
})

test('the sticker asks its cover through the session and stores nothing', async (t) => {
  const { transformSync } = require('@babel/core')
  const stickerSource = fs.readFileSync(path.join(__dirname, '../src/ui/MusicSticker.js'), 'utf8')
  const colors = { line: 'line', card: 'card', ink: 'ink', soft: 'soft' }
  const calls = []
  const uri = 'data:image/png;base64,AAAA'
  const deps = {
    rpc: require('@varanda/rpc'),
    ...await import('../src/music.js'),
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) },
    ...Object.fromEntries(['View', 'Text', 'Pressable', 'MusicCover', 'Pill'].map((name) => [name, name])),
    StyleSheet: { create: (styles) => styles },
    useStyles: (make) => make(colors),
    useTheme: () => ({ colors }),
    layout: { hit: 44 },
    radius: { lg: 16 },
    space: { sm: 8 },
    useMusicCover: (...args) => { calls.push(args); return uri }
  }
  const input = stickerSource.replace(/^import .+\n/gm, '').replace(/\bexport /g, '')
  const { code } = transformSync(input, { configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-react-jsx'] })
  // eslint-disable-next-line no-new-func
  const MusicSticker = new Function(...Object.keys(deps), code + '\nreturn MusicSticker')(...Object.values(deps))
  const session = { member: 'a'.repeat(64), origin: 'https://bora.varanda.app', request: () => {} }
  const item = { ...track, cover: true, count: 3 }
  for (const [kind, asked] of [['snippet', 'track'], ['track', 'track'], ['playlist', 'playlist']]) {
    calls.length = 0
    const tree = MusicSticker({ choice: { ref: { kind, id: track.id, start: kind === 'snippet' ? 72 : null }, item }, session, onPress () {}, onRemove () {} })
    t.is(calls.length, 1, kind + ' asks its cover once')
    t.is(calls[0][0], asked)
    t.is(calls[0][1], item)
    t.is(calls[0][2], session, 'the session reaches the cover hook')
    t.is(tree.children[0].children[0].props.uri, uri, 'the cover gets the in-memory uri')
  }
  calls.length = 0
  MusicSticker({ choice: { ref: { kind: 'track', id: track.id, start: null }, item }, onPress () {} })
  t.alike(calls[0][2], {}, 'without a session the hook gets an empty one')
  const { musicSnapshot } = await rules()
  t.is(musicSnapshot({ ref: { kind: 'track', id: track.id, start: null }, item }).thumb, null, 'the stored card keeps no image')
  t.ok(source.includes('session={{ member, origin: musicOrigin, request: nodeRequest }}'))
  t.ok(source.includes('session={momentMusicSession}'))
})

test('music snapshots are frozen, sanitized and have no thumbnail', async (t) => {
  const { musicSnapshot } = await rules()
  const snapshot = musicSnapshot(draft)
  t.alike(snapshot, { url: track.url + '#varanda-musica=t:abc', host: 'audius.co', title: track.title, desc: track.artist, thumb: null })
  t.ok(Object.isFrozen(snapshot))
  t.is(musicSnapshot(null), null)
  t.is(musicSnapshot({ ...draft, ref: { ...draft.ref, id: 'other' } }), null)
  t.is(musicSnapshot({ ...draft, item: { ...track, url: 'https://example.com/a' } }), null)
  t.is(musicSnapshot({ ...draft, ref: { kind: 'snippet', id: track.id, start: 179 } }), null)
  const unsafe = musicSnapshot({ ...draft, item: { ...track, title: 'a\u0000b', artist: 'a\u202eb' } })
  t.absent(/[\u0000\u202e]/.test(unsafe.title + unsafe.desc)) // eslint-disable-line no-control-regex
  const playlist = musicSnapshot({ ref: { kind: 'playlist', id: 'list', start: null }, item: { id: 'list', title: 'Lista', artist: 'Artista', count: 60, url: 'https://audius.co/artist/playlist/list' } })
  t.is(playlist.desc, 'Artista · 60 faixas', 'resolve playlists need no tracks array')
  t.is(playlist.thumb, null)
})

test('music blocks photos, a video, empty text and offline sends, never a page', async (t) => {
  const { musicBlocks, MUSIC_PHOTOS_TEXT, MUSIC_VIDEO_TEXT } = await rules()
  const { MUSIC_NEEDS_TEXT } = await import('../src/music.js')
  const valid = { hasMedia: false, online: true, textLength: 1 }
  t.is(musicBlocks(valid), '')
  t.is(musicBlocks({ ...valid, hasMedia: true }), MUSIC_PHOTOS_TEXT)
  t.is(musicBlocks({ ...valid, hasMedia: true, hasVideo: true }), MUSIC_VIDEO_TEXT)
  t.is(musicBlocks({ ...valid, textLength: 0 }), MUSIC_NEEDS_TEXT)
  t.is(musicBlocks({ ...valid, online: false }), 'Sem conexão: a música precisa de conexão')
})

test('the composer shows a music sticker that reopens the editor and can be removed', (t) => {
  t.ok(source.includes('<MusicSticker choice={musicDraft} session={{ member, origin: musicOrigin, request: nodeRequest }} onPress={held || musicAvailable !== true ? undefined : () => setMusicPickerOpen(true)} onRemove={held ? undefined : () => setMusicDraft(null)} />'))
  t.ok(source.includes('<MusicSticker choice={momentChoiceOf(moment.music)} session={momentMusicSession} onPress={node.online === false ? undefined : () => moment.setMusicPickerOpen(true)} onRemove={() => moment.removeMusic()} disabled={moment.pending || moment.held} />'))
  t.ok(source.includes('initial={musicDraft}'))
  t.ok(source.includes('initial={momentChoiceOf(moment.music)}'))
  t.ok(source.includes("accessibilityLabel='Música'"))
  t.ok(source.includes("<Icon name='musica' size={24} color={colors.soft} />"))
  t.absent(source.includes("<Pill label='Música'"))
  t.is((source.match(/accessibilityLabel='Música'/g) || []).length, 2)
  t.absent(source.includes('useLine('))
})

test('moment choices adapt the saved reference to a snippet without changing the draft', async (t) => {
  const { momentChoiceOf } = await rules()
  t.is(momentChoiceOf(null), null)
  const music = Object.freeze({ ref: Object.freeze({ id: 'a1', start: 12 }), item: track })
  const choice = momentChoiceOf(music)
  t.alike(choice, { ref: { kind: 'snippet', id: 'a1', start: 12 }, item: track })
  t.is(choice.item, track)
  t.alike(music.ref, { id: 'a1', start: 12 })
})

test('resolve targets skip fragments, lookalike hosts and tried URLs', async (t) => {
  const { resolveTarget } = await rules()
  const other = 'https://audius.co/artist/other'
  const text = 'https://example.com/a ' + track.url + '#varanda-musica=t:abc https://audius.co.evil.test/a/b ' + track.url + ' ' + other
  const tried = new Set()
  t.is(resolveTarget(text, tried), track.url)
  tried.add(track.url)
  t.is(resolveTarget(text, tried), other)
  tried.add(other)
  t.is(resolveTarget(text, tried), null)
  t.is(resolveTarget(null, tried), null)
  t.is(resolveTarget('https://audius.co/artist/song#', new Set()), null)
})

// Execute the composer's actual effect with a manual clock, no network or React.
async function resolution (overrides = {}) {
  const calls = []
  let timer = null
  let epoch = 0
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  const ctx = {
    ...await rules(),
    ...await import('../src/previewPref.js'),
    musicAvailable: true,
    node: { online: true },
    previewPrefStore: () => ({ getItem: () => null }),
    open: true,
    momentMode: false,
    asPage: null,
    hasMedia: false,
    musicDraft: null,
    busy: false,
    frozen: false,
    musicPickerOpen: false,
    shareLinkHeld: false,
    text: track.url,
    musicTried: { current: new Set() },
    playbackEpoch: () => epoch,
    liveRef: { current: new Set() },
    video: { draft: { state: { phase: 'empty' }, clear: () => {} } },
    musicDraftRef: { current: null },
    member: 'a'.repeat(64),
    musicOrigin: 'https://account.example',
    nodeRequest: () => {},
    LINK_DRAFT_DELAY_MS: 600,
    setTimeout: (fn, ms) => { timer = { fn, ms }; return timer },
    clearTimeout: () => { timer = null },
    AbortController,
    audiusResolve: (url, opts) => { calls.push({ url, opts }); return pending },
    setMusicDraft: (value) => { ctx.musicDraft = value; ctx.musicDraftRef.current = value },
    ...overrides
  }
  const gate = source.match(/^ {2}const musicResolve(?:On|Target) = [^\n]+/gm).join('\n')
  const start = source.indexOf('  useEffect(() => {', source.indexOf('  const musicResolveOn ='))
  const end = source.indexOf('\n  useEffect(', start + 1)
  const effect = source.slice(start, end)
  let cleanup
  let previousDeps
  ctx.useEffect = (fn, deps) => {
    if (previousDeps && deps.every((value, i) => Object.is(value, previousDeps[i]))) return
    if (cleanup) cleanup()
    previousDeps = deps
    cleanup = fn()
  }
  // eslint-disable-next-line no-new-func
  const run = () => new Function(...Object.keys(ctx), gate + '\n' + effect)(...Object.values(ctx))
  run()
  return {
    ctx,
    calls,
    run,
    get timer () { return timer },
    cancel: () => { if (cleanup) cleanup() },
    leave: () => { epoch++ },
    finish
  }
}

test('compose-time resolution honors the preview preference and online gate', async (t) => {
  for (const overrides of [
    { previewPrefStore: () => ({ getItem: () => JSON.stringify({ v: 1, enabled: false }) }) },
    { node: { online: false } },
    { musicAvailable: false },
    { musicAvailable: null },
    { open: false },
    { momentMode: true },
    { hasMedia: true },
    { musicDraft: draft },
    { busy: true },
    { musicPickerOpen: true },
    { shareLinkHeld: true }
  ]) {
    const r = await resolution(overrides)
    t.is(r.timer, null)
    t.is(r.calls.length, 0)
  }
  const r = await resolution()
  t.is(r.timer.ms, 600)
  r.cancel()
  t.is(r.calls.length, 0, 'editing before the delay does not consume the URL')
  t.is(r.ctx.musicTried.current.size, 0)
})

test('resolve runs once, carries the session and abort signal, and keeps a full track', async (t) => {
  const recents = []
  const r = await resolution({ noteMusicRecent: (...args) => { recents.push(args) } })
  const work = r.timer.fn()
  t.is(r.calls.length, 1)
  t.is(r.calls[0].url, track.url)
  t.is(r.calls[0].opts.origin, r.ctx.musicOrigin)
  t.is(r.calls[0].opts.member, r.ctx.member)
  t.is(r.calls[0].opts.request, r.ctx.nodeRequest)
  t.ok(r.calls[0].opts.signal instanceof AbortSignal)
  r.finish({ kind: 'track', item: track })
  await work
  t.alike(r.ctx.musicDraftRef.current, draft)
  t.alike(recents, [], 'pasting a link does not record a pick')
  r.cancel()
  r.ctx.setMusicDraft(null)
  r.run()
  t.is(r.timer, null, 'dismissing never resolves that URL again')
})

test('late resolutions are dropped on cancellation, leaving, a photo, a video or a picked music', async (t) => {
  for (const change of [
    (r) => r.cancel(),
    (r) => r.leave(),
    (r) => r.ctx.liveRef.current.add('photo'),
    (r) => { r.ctx.video.draft.state = { phase: 'preparing' } },
    (r) => { r.ctx.musicDraftRef.current = draft }
  ]) {
    const r = await resolution()
    const work = r.timer.fn()
    change(r)
    const before = r.ctx.musicDraftRef.current
    r.finish({ kind: 'track', item: { ...track, id: 'late' } })
    await work
    t.is(r.ctx.musicDraftRef.current, before)
    t.is(r.ctx.musicTried.current.has(track.url), !r.calls[0].opts.signal.aborted, 'only settled attempts without an abort stay tried')
    r.cancel()
  }
  const r = await resolution()
  r.leave()
  await r.timer.fn()
  t.is(r.calls.length, 0, 'leaving before the delay prevents the request')
  r.cancel()
})

test('typing more text keeps the pending resolve and sets the music draft', async (t) => {
  const r = await resolution()
  const work = r.timer.fn()
  r.ctx.text += ' ouça esta música'
  r.run()
  t.absent(r.calls[0].opts.signal.aborted)
  t.is(r.ctx.musicTried.current.size, 0, 'pending is not tried')
  r.finish({ kind: 'track', item: track })
  await work
  t.alike(r.ctx.musicDraftRef.current, draft)
  t.ok(r.ctx.musicTried.current.has(track.url))
  t.is(r.calls.length, 1)
  r.cancel()
})

test('removing the link aborts without consuming the URL, which can be pasted again', async (t) => {
  const r = await resolution()
  const work = r.timer.fn()
  r.ctx.text = 'sem link'
  r.run()
  t.ok(r.calls[0].opts.signal.aborted)
  t.is(r.ctx.musicTried.current.size, 0)
  r.finish({ kind: 'track', item: track })
  await work
  t.is(r.ctx.musicDraftRef.current, null)
  t.is(r.ctx.musicTried.current.size, 0, 'even a late answer after abort is not tried')
  r.ctx.text = track.url
  r.run()
  t.ok(r.timer, 'pasting the removed URL schedules a new attempt')
  if (r.timer) await r.timer.fn()
  t.is(r.calls.length, 2)
  t.alike(r.ctx.musicDraftRef.current, draft)
  r.cancel()
})

test('a failed resolve leaves the ordinary draft alone and does not retry', async (t) => {
  const r = await resolution({ audiusResolve: async () => { throw new Error('indisponivel') } })
  await r.timer.fn()
  t.is(r.ctx.musicDraftRef.current, null)
  r.cancel()
  r.run()
  t.is(r.timer, null)
})

// Run the actual send closure. Pure card builders and text checks stay real.
async function sender (overrides = {}) {
  const state = { errors: [], requests: [], queued: [], published: [], checked: [], recents: [] }
  const { refusalOf, previewRefusal } = await import('../src/wordCheck.js')
  const { sentMatcher } = await import('../src/replySend.js')
  const ctx = {
    ...await rules(),
    ...await import('../src/linkCard.js'),
    ...await import('../src/attach-plan.js'),
    busy: false,
    uploadingRef: { current: false },
    queueingRef: { current: false },
    setCheckError: (e) => { state.errors.push(e) },
    pageRetryRef: { current: null },
    refusalOf: (text) => { state.checked.push(text); return refusalOf(text) },
    previewRefusal,
    text: 'Ouça esta música',
    musicDraft: draft,
    pollDraft: null,
    eventDraft: null,
    eventEditorTexts: () => [],
    pollOk: true,
    hasMedia: false,
    hasVideo: false,
    video: { draft: { state: { phase: 'empty', file: null } } },
    asPage: null,
    len: 16,
    reply: null,
    quote: null,
    countChars: (s) => [...s].length,
    items: [],
    offlineQueue: false,
    canQueue: true,
    queue: (...args) => { state.queued.push(args); return true },
    // The word check reads the card through take, and neither flow has one.
    linkDraft: { take: () => null },
    cardRef: { current: null },
    media: null,
    setUploading: () => {},
    confirm: () => {},
    cacheGeneration: () => 0,
    parseRef: (await import('../src/thread.js')).parseRef,
    seqOf: (value) => value.seq,
    published: (...args) => { state.published.push(args) },
    noteMusicRecent: (...args) => { state.recents.push(args) },
    GATE_MESSAGE: 'gate',
    setChecking: () => {},
    lastSeqRef: { current: null },
    sentMatcher,
    isQuoteRecord: (r) => !!r?.quote,
    sameRef: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    refOf: (ref) => ref || null,
    sameMedia: (a, b) => (a || null) === b,
    MATCH_SLACK_MS: 2000,
    errorText: (e) => e.message,
    action: {
      run: async (fn) => {
        try { return { ok: true, value: await fn() } } catch (err) { state.error = err.message; return { ok: false, uncertain: err.uncertain === true } }
      },
      clearError: () => { state.error = null }
    },
    node: { online: true, request: async (method, params) => { state.requests.push({ method, params }); return { seq: 1 } } },
    webOn: false,
    ...overrides
  }
  const start = source.lastIndexOf('  const send = async () => {')
  const end = source.indexOf('\n  const replyName', start)
  // eslint-disable-next-line no-new-func
  const send = new Function(...Object.keys(ctx), source.slice(start, end) + '\nreturn send')(...Object.values(ctx))
  return { state, send, ctx }
}

test('post, reply and quote send the music card with no image or provider text check', async (t) => {
  for (const [method, extra] of [['post.create', {}], ['post.reply', { reply: target }], ['post.quote', { quote: target }]]) {
    const r = await sender({ ...extra, musicDraft: { ...draft, item: { ...track, title: 'nazismo' } } })
    await r.send()
    t.is(r.state.requests.length, 1)
    const sent = r.state.requests[0]
    t.is(sent.method, method)
    t.is(sent.params.preview.url, track.url + '#varanda-musica=t:abc')
    t.is(sent.params.preview.image, null)
    t.alike(r.state.checked, [r.ctx.text], 'only the author text is checked')
    t.is(r.state.published.length, 1)
    t.is(r.state.queued.length, 0)
    t.alike(r.state.recents, [], 'publishing does not record a pick')
  }
})

test('music is kept offline and after a gate failure, never queued as plain text', async (t) => {
  const offline = await sender({ offlineQueue: true, node: { online: false } })
  await offline.send()
  t.is(offline.state.errors.at(-1), 'Sem conexão: a música precisa de conexão')
  t.is(offline.state.queued.length, 0)
  t.is(offline.state.requests.length, 0)
  const failed = await sender({ node: { online: true, request: async () => { throw new Error('gate') } } })
  await failed.send()
  t.is(failed.state.queued.length, 0)
  t.is(failed.state.published.length, 0)
  t.is(failed.state.error, 'gate')
})

test('a card that does not fit is never sent as plain text', async (t) => {
  const r = await sender({ withPreview: () => { throw new Error('too long') } })
  await r.send()
  t.is(r.state.errors.at(-1), 'A música não coube: encurte o texto')
  t.is(r.state.requests.length, 0)
  t.is(r.state.published.length, 0)
  t.is(r.state.queued.length, 0)
})

test('uncertain music sends require the same preview URL and never resend', async (t) => {
  for (const preview of [null, [], {}, { url: 'https://example.com/a' }, { url: track.url + '#varanda-musica=t:abc' }]) {
    const calls = []
    const r = await sender({
      node: {
        online: true,
        request: async (method) => {
          calls.push(method)
          if (method !== 'log.read') throw Object.assign(new Error('uncertain'), { uncertain: true })
          return { entries: [{ seq: 2, record: { type: 'post', text: 'Ouça esta música', at: new Date().toISOString(), preview } }] }
        }
      }
    })
    await r.send()
    t.alike(calls, ['post.create', 'log.read'])
    t.is(r.state.published.length, preview?.url === track.url + '#varanda-musica=t:abc' ? 1 : 0)
    t.is(r.state.queued.length, 0)
  }
})

function composerFunction (start, end, name, ctx) {
  const at = source.indexOf(start)
  const code = source.slice(at, source.indexOf(end, at))
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(ctx), code + '\nreturn ' + name)(...Object.values(ctx))
}

test('switching identity drops page uploads and the kept video pair, never the music draft', (t) => {
  const end = source.indexOf('  }, [asPage, video.draft])') + '  }, [asPage, video.draft])'.length
  const start = source.lastIndexOf('  useEffect(() => {', end)
  const effect = source.slice(start, end)
  for (const open of [true, false]) {
    for (const pending of ['none', 'retry', 'sending']) {
      let music = draft
      const kept = { page: 'page', file: {}, poster: {}, video: {} }
      const ctx = {
        pagePosterRef: { current: kept },
        open,
        asPage: null,
        pageRetryRef: { current: pending === 'retry' ? { page: 'page' } : null },
        pageSendingRef: { current: pending === 'sending' },
        genRef: { current: 0 },
        liveRef: { current: new Set() },
        removeItems: () => {},
        video: { draft: { clear: () => {} } },
        setMusicDraft: (value) => { music = value },
        useEffect: (fn) => fn()
      }
      // eslint-disable-next-line no-new-func
      const run = () => new Function(...Object.keys(ctx), effect)(...Object.values(ctx))
      ctx.asPage = 'page'
      run()
      t.is(music, draft, 'the music draft is kept: open=' + open + ', pending=' + pending)
      t.is(ctx.pagePosterRef.current, pending === 'none' ? null : kept, 'the video pair goes unless a send holds it')
    }
  }
})

test('picking music records only accepted choices, under the person even when acting as a Page', async (t) => {
  const { musicSnapshot, MUSIC_PHOTOS_TEXT, MUSIC_VIDEO_TEXT } = await rules()
  const member = 'a'.repeat(64)
  const recents = []
  const liveRef = { current: new Set(['photo']) }
  const video = { draft: { state: { phase: 'empty' } } }
  let fail = false
  let note = ''
  let picked = null
  const handler = (overrides = {}) => composerFunction('  const pickMusic = (draft) => {', '\n  const cardRef', 'pickMusic', {
    busy: false,
    frozen: false,
    member,
    asPage: 'b'.repeat(64),
    liveRef,
    video,
    musicSnapshot,
    MUSIC_PHOTOS_TEXT,
    MUSIC_VIDEO_TEXT,
    setNote: (value) => { note = value },
    setMusicDraft: (value) => { picked = value },
    noteMusicRecent: (...args) => {
      recents.push(args)
      if (fail) throw new Error('recent write')
    },
    ...overrides
  })
  const pick = handler()
  pick(draft)
  t.is(picked, null)
  t.is(note, MUSIC_PHOTOS_TEXT)
  liveRef.current.clear()
  for (const phase of ['preparing', 'ready']) {
    video.draft.state = { phase }
    note = ''
    pick(draft)
    t.is(picked, null, phase)
    t.is(note, MUSIC_VIDEO_TEXT, phase)
  }
  video.draft.state = { phase: 'empty' }
  handler({ busy: true })(draft)
  handler({ frozen: true })(draft)
  pick({ ...draft, item: null })
  t.is(picked, null)
  t.alike(recents, [])

  const item = { ...track, genre: 'Rock' }
  const snippet = { ref: { ...draft.ref, kind: 'snippet', start: 75 }, item }
  const playlistItem = { id: 'def', title: 'Seleção', artist: 'Artista', count: 2, url: 'https://audius.co/artist/playlist/selection' }
  const playlist = { ref: { kind: 'playlist', id: playlistItem.id, start: null }, item: playlistItem }
  for (const [choice, kind] of [[snippet, 'track'], [{ ...draft, item }, 'track'], [playlist, 'playlist']]) {
    recents.length = 0
    pick(choice)
    t.is(picked, choice)
    t.is(note, '')
    t.alike(recents, [[member, kind, choice.item]])
    t.is(recents[0]?.[2], choice.item, 'the store gets the original item')
  }

  fail = true
  t.exception(() => pick(snippet), /recent write/)
  t.is(picked, snippet, 'the draft is attached before the store is called')
})

test('a video waits for the music card to go, like a link preview', async (t) => {
  for (const music of [draft, null]) {
    let note = 'old'
    let seen = null
    const attach = composerFunction('  const attachVideo = async () => {', '\n\n  // Done after unmount', 'attachVideo', {
      canVideo: true,
      busy: false,
      frozen: false,
      pollActive: false,
      eventActive: false,
      setNote: (value) => { note = value },
      video: { draft: { pick: async (selection) => { seen = selection; if (selection.preview) throw new Error('preview') } } },
      pickVideo: () => {},
      prepareVideo: () => {},
      liveRef: { current: new Set() },
      linkDraft: { view: null },
      musicDraftRef: { current: music }
    })
    await attach()
    t.is(seen.preview, music !== null)
    t.is(note, music !== null ? 'preview' : '')
  }
})

test('attaching a photo removes music only after files were picked', async (t) => {
  const { MUSIC_PHOTOS_TEXT } = await rules()
  for (const files of [[], [{}]]) {
    const musicDraftRef = { current: draft }
    let note = ''
    const attach = composerFunction('  const addFiles = async (files, onRoom, until = Infinity) => {', '\n  // Done after unmount', 'attach', {
      canAttach: true,
      mediaOnline: true,
      busy: false,
      frozen: false,
      pollActive: false,
      eventActive: false,
      pickImages: async () => files,
      liveRef: { current: new Set() },
      video: { draft: { state: { phase: 'empty' } } },
      MAX_MEDIA_PER_POST: 4,
      nextItemId: () => 'photo',
      musicDraftRef,
      MUSIC_PHOTOS_TEXT,
      setMusicDraft: (value) => { musicDraftRef.current = value },
      setNote: (value) => { note = value },
      genRef: { current: 0 },
      setItems: () => {},
      encodeFile: async () => { throw new Error('invalid photo') },
      retryableEncode: () => true,
      sourcesRef: { current: new Map() },
      patch: () => {},
      errorText: (err) => err.message,
      thumbsRef: { current: new Map() },
      urlFromBytes: () => null
    })
    await attach()
    t.is(musicDraftRef.current, files.length ? null : draft)
    t.is(note, files.length ? MUSIC_PHOTOS_TEXT : '')
  }
})

test('publishing clears the music draft for posts, replies and quotes', (t) => {
  for (const quote of [null, target]) {
    let music = draft
    const ticks = []
    const published = composerFunction('  const published = (sent, sentReply', '\n  // Keeps the post', 'published', {
      tap: () => {},
      setMusicDraft: (value) => { music = value },
      setWebShare: (value) => { ticks.push(value) },
      setPollDraft: () => {},
      setEventDraft: () => {},
      musicTried: { current: new Set([track.url]) },
      setText: () => {},
      video: { draft: { state: { phase: 'empty', file: null } } },
      onPublished: () => {}
    })
    published('text', target, [], quote)
    t.is(music, null)
    t.alike(ticks, [false], 'the web tick never outlives its post')
  }
})

test('a resolved playlist needs no tracks array', async (t) => {
  const r = await resolution()
  const work = r.timer.fn()
  const item = { id: 'list', title: 'Lista', artist: 'Artista', count: 60, url: 'https://audius.co/artist/playlist/list' }
  r.finish({ kind: 'playlist', item })
  await work
  t.alike(r.ctx.musicDraftRef.current, { ref: { kind: 'playlist', id: 'list', start: null }, item })
  r.cancel()
})

test('publishing or closing lets the same URL resolve in the next draft', async (t) => {
  for (const reset of ['publish', 'close']) {
    const r = await resolution()
    const work = r.timer.fn()
    r.finish({ kind: 'track', item: track })
    await work
    t.ok(r.ctx.musicTried.current.has(track.url))
    r.run()
    if (reset === 'publish') {
      const published = composerFunction('  const published = (sent, sentReply', '\n  // Keeps the post', 'published', {
        ...r.ctx,
        tap: () => {},
        setWebShare: () => {},
        setPollDraft: () => {},
        setEventDraft: () => {},
        setText: (update) => { r.ctx.text = update(r.ctx.text) },
        onPublished: () => {}
      })
      published(track.url, null)
      r.run()
    } else {
      r.ctx.open = false
      r.run()
      const start = source.indexOf('  useEffect(() => {', source.indexOf('// Closing the composer (Cancelar'))
      const end = source.indexOf('\n  useEffect(', start + 1)
      const ctx = {
        ...r.ctx,
        open: false,
        useEffect: (fn) => fn(),
        setEmojiOpen: () => {},
        setNote: () => {},
        keepPostOnCloseRef: { current: false },
        pageRetryRef: { current: null },
        pageSendingRef: { current: false },
        genRef: { current: 0 },
        removeItems: () => {}
      }
      // eslint-disable-next-line no-new-func
      new Function(...Object.keys(ctx), source.slice(start, end))(...Object.values(ctx))
    }
    t.is(r.ctx.musicDraftRef.current, null, reset + ' clears the music draft')
    t.is(r.ctx.musicTried.current.size, 0, reset + ' clears settled attempts')
    r.ctx.text = track.url
    r.ctx.open = true
    r.run()
    t.ok(r.timer, reset + ' schedules the same URL again')
    if (r.timer) await r.timer.fn()
    t.is(r.calls.length, 2, reset + ' resolves again')
    t.alike(r.ctx.musicDraftRef.current, draft)
    r.cancel()
  }
})

test('photo-only momento music has its own video refusal note', async (t) => {
  const { MUSIC_MOMENT_VIDEO_TEXT } = await rules()
  t.is(MUSIC_MOMENT_VIDEO_TEXT, 'A música vai só com foto: remova a música')
})

// 'Publicar também na web': the post, then one shareNew, through the real send.
function webSender (overrides = {}) {
  const shares = []
  const order = []
  const answer = { ref: 'a'.repeat(64) + ':1', result: { state: 'on', shareSeq: 2, message: '' } }
  const requests = []
  const node = {
    online: true,
    request: async (method, params) => { order.push(method); requests.push({ method, params }); return { seq: 1 } }
  }
  return sender({
    musicDraft: null,
    text: 'Olá, web',
    len: 8,
    webOn: true,
    self: { publicKey: 'a'.repeat(64) },
    mountedRef: { current: true },
    node,
    shareNew: async (call, author, seq) => { order.push('share'); shares.push([call, author, seq]); return answer },
    ...overrides
  }).then((r) => ({ ...r, shares, order, answer, requests: overrides.node ? null : requests }))
}

test('a ticked post sends one post.create, then one shareNew, and hands its answer to published', async (t) => {
  const r = await webSender()
  await r.send()
  t.alike(r.requests.map((q) => q.method), ['post.create'])
  t.alike(r.order, ['post.create', 'share'])
  t.is(r.shares.length, 1)
  t.is(r.shares[0][0], r.ctx.node.request)
  t.is(r.shares[0][1], 'a'.repeat(64))
  t.is(r.shares[0][2], 1)
  t.is(r.state.published.length, 1)
  t.is(r.state.published[0][4], r.answer)
  t.is(r.state.queued.length, 0)
})

test('a ticked post that hits the write gate is never queued, published or shared', async (t) => {
  const gate = { online: true, request: async () => { throw new Error('gate') } }
  const r = await webSender({ node: gate })
  await r.send()
  t.is(r.state.queued.length, 0)
  t.is(r.state.published.length, 0)
  t.is(r.shares.length, 0)
  t.is(r.state.error, 'gate')
  const plain = await webSender({ node: gate, webOn: false })
  await plain.send()
  t.is(plain.state.queued.length, 1, 'the same failure unticked waits in the outbox')
  t.is(plain.shares.length, 0)
})

test('a share answer that lands after the composer unmounted is dropped', async (t) => {
  const r = await webSender({ mountedRef: { current: false } })
  await r.send()
  t.is(r.shares.length, 1)
  t.is(r.state.published.length, 1)
  t.is(r.state.published[0][4], null)
})

test('an unticked post never shares and passes no web answer', async (t) => {
  const r = await webSender({ webOn: false })
  await r.send()
  t.alike(r.requests.map((q) => q.method), ['post.create'])
  t.is(r.shares.length, 0)
  t.is(r.state.published.length, 1)
  t.is(r.state.published[0][4], null)
})

test('an uncertain ticked post found in the diary is shared once by its seq, never resent', async (t) => {
  const calls = []
  const node = {
    online: true,
    request: async (method) => {
      calls.push(method)
      if (method !== 'log.read') throw Object.assign(new Error('uncertain'), { uncertain: true })
      return { entries: [{ seq: 7, record: { type: 'post', text: 'Olá, web', at: new Date().toISOString() } }] }
    }
  }
  const r = await webSender({ node })
  await r.send()
  t.alike(calls, ['post.create', 'log.read'])
  t.is(r.shares.length, 1)
  t.is(r.shares[0][2], 7)
  t.is(r.state.published.length, 1)
  t.is(r.state.published[0][4], r.answer)
})

test('an uncertain ticked post not found in the diary is neither published nor shared', async (t) => {
  const node = {
    online: true,
    request: async (method) => {
      if (method !== 'log.read') throw Object.assign(new Error('uncertain'), { uncertain: true })
      return { entries: [] }
    }
  }
  const r = await webSender({ node })
  await r.send()
  t.is(r.shares.length, 0)
  t.is(r.state.published.length, 0)
  t.is(r.state.queued.length, 0)
})

test('an uncertain ticked post found without a usable seq shares nothing by guess', async (t) => {
  const node = {
    online: true,
    request: async (method) => {
      if (method !== 'log.read') throw Object.assign(new Error('uncertain'), { uncertain: true })
      return { entries: [{ seq: 'x', record: { type: 'post', text: 'Olá, web', at: new Date().toISOString() } }] }
    }
  }
  const r = await webSender({ node })
  await r.send()
  t.is(r.shares.length, 1)
  t.is(r.shares[0][2], null, 'shareNew gets no seq, so it sends nothing and the shell shows the no-ref toast')
  t.is(r.state.published.length, 1)
})

test('a reply or quote never shares, even while the tick is still set', async (t) => {
  for (const kind of ['reply', 'quote']) {
    const r = await webSender({ [kind]: target })
    await r.send()
    t.is(r.shares.length, 0, kind)
    t.is(r.state.published.length, 1, kind)
    t.is(r.state.published[0][4], null, kind)
  }
})

test('a share call that throws still publishes the post once and never resends', async (t) => {
  const r = await webSender({ shareNew: async () => { throw new Error('boom') } })
  await r.send()
  t.alike(r.requests.map((q) => q.method), ['post.create'])
  t.is(r.state.published.length, 1)
  t.alike(r.state.published[0][4], { ref: null, result: null })
  t.is(r.state.queued.length, 0)
})

const photoD = (over = {}) => ({ blocks: 1, bytes: 10, core: 'ab'.repeat(32), height: 1, mime: 'image/jpeg', sha256: 'cd'.repeat(32), start: 1, width: 1, ...over })
const videoD = (over = {}) => ({ blocks: 1, bytes: 10, core: 'ef'.repeat(32), height: 360, mime: 'video/mp4', ms: 1000, sha256: '12'.repeat(32), start: 2, width: 640, ...over })

// send, then sendAsPage and its helpers, as a page with the service stubbed.
async function pageSender (overrides = {}) {
  const base = await sender()
  const state = { ...base.state, acts: [], uploads: [], preps: [] }
  const { pagePostOp } = await import('../src/pagePost.js')
  const { findTerm } = await import('../src/wordCheck.js')
  const { validDescriptor, validVideoDescriptor } = await import('../src/media/fetch.js')
  const videoFile = { name: 'video' }
  const ctx = {
    ...base.ctx,
    asPage: 'page',
    musicDraft: null,
    text: 'Olá',
    len: 3,
    findTerm,
    validDescriptor,
    validVideoDescriptor,
    pagePostOp,
    prepPageVideo: async ({ poster }) => { state.preps.push(poster); return [poster || photoD(), videoD()] },
    uploadBytesForPage: async (page, f) => { state.uploads.push({ page, mime: f.mime }); return { descriptor: photoD() } },
    uploadAll: async () => [photoD()],
    pagePosterRef: { current: null },
    pageCardRef: { current: null },
    pageSendingRef: { current: false },
    setPageSending: () => {},
    setPageRetry: (v) => { state.retry = v },
    openRef: { current: true },
    asPageRef: { current: 'page' },
    genRef: { current: 0 },
    liveRef: { current: new Set() },
    removeItems: () => {},
    mediaReady: true,
    mediaOnline: true,
    canVideo: true,
    mediaComposeError: () => '',
    nodeRef: { current: {} },
    nodeRequest: async () => ({}),
    memberKeyOf: async () => 'm',
    actAs: async (node, args) => { state.acts.push(args); return { ok: true } },
    published: (...args) => { state.published.push(args) },
    videoFile,
    ...altScope(),
    ...overrides
  }
  if (ctx.hasVideo && !overrides.video) ctx.video = { draft: { state: { phase: 'ready', file: videoFile }, clear: () => {} } }
  const a = source.indexOf('  const settledAsPage = (page) => {')
  const b = source.indexOf('  // A poll post:', a)
  const start = source.lastIndexOf('  const send = async () => {')
  const end = source.indexOf('\n  const replyName', start)
  const code = source.slice(a, b) + source.slice(start, end) + '\nreturn send'
  // eslint-disable-next-line no-new-func
  const send = new Function(...Object.keys(ctx), code)(...Object.values(ctx))
  return { state, send, ctx }
}

test('a page video sends { text, media: [poster, video] } with no preview', async (t) => {
  const r = await pageSender({ hasMedia: true, hasVideo: true, linkDraft: { take: () => ({ url: 'https://exemplo.com/a', title: 'T', desc: 'D', thumb: null }) } })
  await r.send()
  t.is(r.state.acts.length, 1)
  t.alike(r.state.acts[0].op, { text: 'Olá', media: [photoD(), videoD()] })
  t.is(r.state.acts[0].action, 'post')
  t.is(r.state.published.length, 1)
  t.is(r.ctx.pagePosterRef.current, null, 'cleared on success')
})

test('a page reply or quote carries to', async (t) => {
  for (const [extra, action] of [[{ reply: target }, 'reply'], [{ quote: target }, 'quote']]) {
    const r = await pageSender(extra)
    await r.send()
    t.is(r.state.acts[0].action, action)
    t.is(r.state.acts[0].op.to, target.ref)
  }
})

test('a page link card thumbnail goes up as a page item, or the card goes without it', async (t) => {
  const thumb = { bytes: new Uint8Array([1]), mime: 'image/jpeg', width: 320, height: 320 }
  const take = () => ({ url: 'https://exemplo.com/a', host: 'exemplo.com', title: 'Titulo', desc: 'Linha', thumb })
  const ok = await pageSender({ linkDraft: { take } })
  await ok.send()
  t.alike(ok.state.uploads, [{ page: 'page', mime: 'image/jpeg' }])
  t.alike(ok.state.acts[0].op.preview.image, photoD())
  t.absent(ok.state.acts[0].op.media)
  const failed = await pageSender({ linkDraft: { take }, uploadBytesForPage: async () => { throw new Error('falhou') } })
  await failed.send()
  t.is(failed.state.acts[0].op.preview.image, null)
})

test('a refused page post keeps the card and the video pair for the next tap', async (t) => {
  const thumb = { bytes: new Uint8Array([1]), mime: 'image/jpeg', width: 320, height: 320 }
  const take = () => ({ url: 'https://exemplo.com/a', host: 'exemplo.com', title: 'Titulo', desc: 'Linha', thumb })
  const refuse = async () => { throw new Error('recusado') }
  const card = await pageSender({ linkDraft: { take }, actAs: refuse })
  await card.send()
  await card.send()
  t.is(card.state.uploads.length, 1, 'the thumbnail is uploaded once')
  const vid = await pageSender({ hasMedia: true, hasVideo: true, actAs: refuse })
  await vid.send()
  await vid.send()
  t.is(vid.state.preps.length, 1, 'the video is uploaded once')
  t.alike(vid.ctx.pagePosterRef.current.video, videoD())
})

test('a failed page video upload resumes its poster only for the same page and file', async (t) => {
  const poster = photoD({ start: 3 })
  const fail = async () => { throw Object.assign(new Error('falhou'), { poster }) }
  const r = await pageSender({ hasMedia: true, hasVideo: true, prepPageVideo: fail })
  await r.send()
  t.is(r.state.acts.length, 0)
  t.is(r.ctx.pagePosterRef.current.poster, poster)
  const same = await pageSender({ hasMedia: true, hasVideo: true, pagePosterRef: { current: r.ctx.pagePosterRef.current } })
  same.ctx.pagePosterRef.current.file = same.ctx.videoFile
  await same.send()
  t.alike(same.state.preps, [poster], 'the poster is reused')
  t.is(same.ctx.pagePosterRef.current, null)
  const other = await pageSender({ hasMedia: true, hasVideo: true, asPage: 'outra', pagePosterRef: { current: { page: 'page', file: null, poster, video: null } } })
  other.ctx.pagePosterRef.current.file = other.ctx.videoFile
  await other.send()
  t.alike(other.state.preps, [null], 'another page uploads its own poster')
})

test('an uncertain page video upload is resent only by its retry on the next tap', async (t) => {
  const poster = photoD()
  let retried = 0
  const retry = async () => { retried++; return { descriptor: videoD() } }
  const fail = async () => { throw Object.assign(new Error('incerto'), { poster, uncertain: true, retry }) }
  const r = await pageSender({ hasMedia: true, hasVideo: true, prepPageVideo: fail })
  await r.send()
  t.is(retried, 0, 'never automatically')
  const again = await pageSender({ hasMedia: true, hasVideo: true, pagePosterRef: { current: { ...r.ctx.pagePosterRef.current } } })
  again.ctx.pagePosterRef.current.file = again.ctx.videoFile
  await again.send()
  t.is(retried, 1)
  t.alike(again.state.acts[0].op.media, [poster, videoD()])
})

test('page music sends the #varanda-musica card; one that does not fit sends nothing', async (t) => {
  const r = await pageSender({ musicDraft: draft, text: 'Ouça esta música', len: 16 })
  await r.send()
  t.is(r.state.acts[0].op.preview.url, track.url + '#varanda-musica=t:abc')
  t.alike(r.state.recents, [], 'publishing as a Page does not record a pick')
  const big = await pageSender({ musicDraft: draft, text: 'Ouça', len: 4, withPreview: () => { throw new Error('too long') } })
  await big.send()
  t.is(big.state.errors.at(-1), 'A música não coube: encurte o texto')
  t.is(big.state.acts.length, 0)
})

test('retrying a Page music post does not record a pick', async (t) => {
  let retries = 0
  const r = await pageSender({
    musicDraft: draft,
    actAs: async () => {
      throw Object.assign(new Error('incerto'), { uncertain: true, retry: async () => { retries++ } })
    }
  })
  await r.send()
  t.ok(r.state.retry)
  r.ctx.pageRetryRef.current = r.state.retry
  await r.send()
  t.is(retries, 1)
  t.is(r.state.published.length, 1)
  t.alike(r.state.recents, [])
})

test('a page music title with a listed term is refused before any upload or signature', async (t) => {
  const term = require('@varanda/rpc').BLOCKED_TERMS[0]
  const r = await pageSender({ musicDraft: { ...draft, item: { ...track, title: term } }, text: 'Ouça', len: 4 })
  await r.send()
  t.is(r.state.acts.length, 0)
  t.is(r.state.uploads.length, 0)
  t.ok(r.state.errors.at(-1).includes('título ou no artista da música'))
})

test('a page never queues, but polls and builds events like a person', (t) => {
  t.ok(/const offlineQueue = [^\n]*asPage === null/.test(source))
  t.absent(/const pollOk = [^\n]*asPage/.test(source), 'the poll and event gate does not exclude a page')
  const link = source.slice(source.indexOf('const linkDraft = useLinkDraft({'), source.indexOf('\n', source.indexOf('const linkDraft = useLinkDraft({')))
  t.absent(link.includes('asPage'), 'the link card is not gated on the page')
})

test('a page video upload that goes stale sends nothing and shows no error', async (t) => {
  for (const kind of ['gen', 'file']) {
    let r = null
    const prep = async ({ poster }) => {
      if (kind === 'gen') r.ctx.genRef.current++
      else r.ctx.video.draft.state.file = { name: 'outro' }
      return [photoD(), videoD()]
    }
    r = await pageSender({ hasMedia: true, hasVideo: true, prepPageVideo: prep })
    await r.send()
    t.is(r.state.acts.length, 0, kind)
    t.is(r.state.errors.filter(Boolean).length, 0, kind)
  }
})

test('a kept video retry is never called for another page or another file', async (t) => {
  for (const [asPage, sameFile] of [['outra', true], ['page', false]]) {
    let retried = 0
    const r = await pageSender({ hasMedia: true, hasVideo: true, asPage })
    r.ctx.pagePosterRef.current = { page: 'page', file: sameFile ? r.ctx.videoFile : {}, poster: photoD({ start: 3 }), video: null, retry: async () => { retried++; return { descriptor: videoD() } } }
    await r.send()
    t.is(retried, 0)
    t.alike(r.state.preps, [null], 'a fresh upload')
  }
})

test('a resend that fails again keeps the poster; the next tap uploads only the video', async (t) => {
  const poster = photoD({ start: 3 })
  let retried = 0
  const r = await pageSender({ hasMedia: true, hasVideo: true, actAs: async () => { throw new Error('recusado') } })
  r.ctx.pagePosterRef.current = { page: 'page', file: r.ctx.videoFile, poster, video: null, retry: async () => { retried++; throw Object.assign(new Error('incerto'), { uncertain: true, retry: async () => {} }) } }
  await r.send()
  t.is(retried, 1)
  t.is(r.ctx.pagePosterRef.current.poster, poster)
  t.is(r.ctx.pagePosterRef.current.retry, null, 'the retry is dropped')
  await r.send()
  t.is(retried, 1, 'not resent again')
  t.alike(r.state.preps, [poster], 'only the video is uploaded, with the kept poster')
})
