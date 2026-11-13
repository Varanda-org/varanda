'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const source = fs.readFileSync(path.join(__dirname, '../src/screens/Publicar.js'), 'utf8')
const rules = () => import('../src/musicDraft.js')
const track = { id: 'abc', title: 'Canção', artist: 'Artista', duration: 180, url: 'https://audius.co/artist/song' }
const draft = { ref: { kind: 'track', id: track.id, start: null }, item: track }
const target = { ref: 'b'.repeat(64) + ':1' }

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
    space: { sm: 8 }
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

test('music blocks photos, a video, pages, empty text and offline sends', async (t) => {
  const { musicBlocks, MUSIC_PHOTOS_TEXT, MUSIC_VIDEO_TEXT } = await rules()
  const { MUSIC_NEEDS_TEXT } = await import('../src/music.js')
  const valid = { hasMedia: false, asPage: null, online: true, textLength: 1 }
  t.is(musicBlocks(valid), '')
  t.is(musicBlocks({ ...valid, hasMedia: true }), MUSIC_PHOTOS_TEXT)
  t.is(musicBlocks({ ...valid, hasMedia: true, hasVideo: true }), MUSIC_VIDEO_TEXT)
  t.is(musicBlocks({ ...valid, asPage: 'page' }), 'A música não vai em publicações de página')
  t.is(musicBlocks({ ...valid, textLength: 0 }), MUSIC_NEEDS_TEXT)
  t.is(musicBlocks({ ...valid, online: false }), 'Sem conexão: a música precisa de conexão')
})

test('the composer shows a music sticker that reopens the editor and can be removed', (t) => {
  t.ok(source.includes('<MusicSticker choice={musicDraft} onPress={held || musicAvailable !== true ? undefined : () => setMusicPickerOpen(true)} onRemove={held ? undefined : () => setMusicDraft(null)} />'))
  t.ok(source.includes('<MusicSticker choice={momentChoiceOf(moment.music)} onPress={node.online === false ? undefined : () => moment.setMusicPickerOpen(true)} onRemove={() => moment.removeMusic()} disabled={moment.pending || moment.held} />'))
  t.ok(source.includes('initial={musicDraft}'))
  t.ok(source.includes('initial={momentChoiceOf(moment.music)}'))
  t.ok(source.includes("accessibilityLabel='Música'"))
  t.ok(source.includes("<Icon name='musica' size={21} color={colors.soft} />"))
  t.ok(source.includes("<Pill label='Música' icon='musica'"))
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
    { asPage: 'page' },
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
  const r = await resolution()
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
  const state = { errors: [], requests: [], queued: [], published: [], checked: [] }
  const { refusalOf } = await import('../src/wordCheck.js')
  const ctx = {
    ...await rules(),
    ...await import('../src/linkCard.js'),
    ...await import('../src/attach-plan.js'),
    busy: false,
    uploadingRef: { current: false },
    setCheckError: (e) => { state.errors.push(e) },
    pageRetryRef: { current: null },
    refusalOf: (text) => { state.checked.push(text); return refusalOf(text) },
    text: 'Ouça esta música',
    musicDraft: draft,
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
    linkDraft: { take: () => { throw new Error('music must hide the ordinary card') } },
    cardRef: { current: null },
    media: null,
    setUploading: () => {},
    confirm: () => {},
    seqOf: (value) => value.seq,
    published: (...args) => { state.published.push(args) },
    GATE_MESSAGE: 'gate',
    setChecking: () => {},
    lastSeqRef: { current: null },
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

test('switching to a page clears music even while closed or waiting for a page retry', (t) => {
  const end = source.indexOf('  }, [asPage, video.draft])') + '  }, [asPage, video.draft])'.length
  const start = source.lastIndexOf('  useEffect(() => {', end)
  const effect = source.slice(start, end)
  for (const open of [true, false]) {
    for (const pending of ['none', 'retry', 'sending']) {
      let music = draft
      const ctx = {
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
      run()
      t.is(music, draft, 'the person keeps the draft')
      ctx.asPage = 'page'
      run()
      t.is(music, null, 'the page drops music: open=' + open + ', pending=' + pending)
      ctx.asPage = null
      run()
      t.is(music, null, 'switching back does not restore the music')
    }
  }
})

test('picking music refuses staged photos or a video and accepts a valid snippet', async (t) => {
  const { musicSnapshot, MUSIC_PHOTOS_TEXT, MUSIC_VIDEO_TEXT } = await rules()
  const liveRef = { current: new Set(['photo']) }
  const video = { draft: { state: { phase: 'empty' } } }
  let note = ''
  let picked = null
  const pick = composerFunction('  const pickMusic = (draft) => {', '\n  const cardRef', 'pickMusic', {
    busy: false,
    frozen: false,
    asPage: null,
    liveRef,
    video,
    musicSnapshot,
    MUSIC_PHOTOS_TEXT,
    MUSIC_VIDEO_TEXT,
    setNote: (value) => { note = value },
    setMusicDraft: (value) => { picked = value }
  })
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
  const snippet = { ...draft, ref: { ...draft.ref, kind: 'snippet', start: 75 } }
  pick(snippet)
  t.is(picked, snippet)
  t.is(note, '')
})

test('a video waits for the music card to go, like a link preview', async (t) => {
  for (const music of [draft, null]) {
    let note = 'old'
    let seen = null
    const attach = composerFunction('  const attachVideo = async () => {', '\n\n  // Done after unmount', 'attachVideo', {
      canVideo: true,
      busy: false,
      frozen: false,
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
    const attach = composerFunction('  const addFiles = async (files, onRoom) => {', '\n  // Done after unmount', 'attach', {
      canAttach: true,
      mediaOnline: true,
      busy: false,
      frozen: false,
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
    const published = composerFunction('  const published = (sent, sentReply', '\n  // Keeps the post', 'published', {
      tap: () => {},
      setMusicDraft: (value) => { music = value },
      musicTried: { current: new Set([track.url]) },
      setText: () => {},
      video: { draft: { state: { phase: 'empty', file: null } } },
      onPublished: () => {}
    })
    published('text', target, [], quote)
    t.is(music, null)
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
        setText: (update) => { r.ctx.text = update(r.ctx.text) },
        onPublished: () => {}
      })
      published(track.url, null)
      r.run()
    } else {
      r.ctx.open = false
      r.run()
      const start = source.indexOf('  useEffect(() => {', source.indexOf('// Closing the composer discards'))
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
