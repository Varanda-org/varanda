// The share seams in the shell hook, Publicar and App.js have no React test
// renderer here, so they are pinned as source text: each pin guards a rule
// that keeps shared files alive while Publicar is still reading them.
'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')

const APP = join(__dirname, '..')
const read = (rel) => readFileSync(join(APP, rel), 'utf8')

test('the hook never peeks or sweeps while Publicar holds a share', (t) => {
  const hook = read('src/useSharedIntent.js')
  t.ok(/const blocked = \(\) => \{[\s\S]*?if \(stateRef\.current\.taken\) \{\s*pendingRead\.current = true\s*return true/.test(hook), 'a read while taken is deferred, not run')
  t.ok(/const read = \(\) => \{\s*if \(blocked\(\)\) return\s*return shareIntake\.peek\(\)/.test(hook), 'peek runs only past the guard')
  t.ok(/if \(!blocked\(\)\) shareIntake\.sweep\(SHARE_TTL_MS\)/.test(hook), 'sweep runs only past the guard')
  t.ok(/if \(wasTaken && !next\.state\.taken && pendingRead\.current\) \{\s*pendingRead\.current = false/.test(hook), 'one deferred read runs once the share is let go')
  t.ok(/return \(\) => \{\s*alive = false/.test(hook), 'an answer after unmount is ignored')
  t.ok(/shareIntake\.listen\(read\)/.test(hook), 'wake-ups go through the same guarded read')
  t.ok(/send\(\{ type: 'tick', ready, locked, ownKey, gone, now: Date\.now\(\) \}\)/.test(hook), 'every tick says whether the account left')
  t.ok(hook.includes("else if (effect.type === 'open') latest.current.onOpen(stateRef.current.held)"), 'onOpen receives the held share after the state transition')
})

test('Publicar claims a share before reading its files and lets go only while mounted', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(/!frozen && !busy && !moment\.pending\)\) return\s*appliedShareRef\.current = shared\.id\s*onSharedTaken\(shared\.id\)/.test(src), 'taken is sent first, outside a frozen or busy post')
  t.ok(/\[open, shared && shared\.id, sharedAs, momentOn, canVideo, frozen, busy, moment\.pending, moment\.held, reframing\]/.test(src), 'eligibility follows the Momento upload and held state')
  t.ok(/const done = \(failed\) => \{\s*if \(!mountedRef\.current\) return[\s\S]{0,200}?const next = holdShare\(shared\.id, failed\.filter\(\(id\) => sourcesRef\.current\.has\(id\)\)\)\s*if \(next\.done !== null\) \{\s*onSharedDone\(shared\.id\)/.test(src), 'done after unmount would drop files the remount needs, and only photos still kept for a retry hold the share')
  t.ok(/addFiles\(shared\.files,/.test(src), 'shared photos take the picker encode path')
  t.is((src.match(/failed: shared\.failed \|\| 0/g) || []).length, 3, 'post intake and fallback notes count the photos that could not be opened')
})

test('Publicar builds no preview for a shared link until the person asks or edits', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(src.includes('const shareLinkHeld = linkHeld(linkHold, text)'), 'the hold is read from the pure helper')
  t.ok(/useLinkDraft\(\{ text, enabled: open === true && !shareLinkHeld[ ,]/.test(src), 'a held link never builds')
  t.ok(src.includes('setLinkHold((hold) => sharedLinkHold(current, merged.text, hold))'), 'applying a share sets the hold, keeping one still in place')
  t.ok(/if \(linkHold !== null && linkHold !== text\) setLinkHold\(null\)/.test(src), 'an edit releases it')
  t.ok(/<Pill label='Mostrar prévia do link'[^>]*onPress=\{\(\) => setLinkHold\(null\)\}/.test(src), 'the tap releases it')
})

test('the shell holds a share off the deleted-account screen and wires taken', (t) => {
  const app = read('App.js')
  t.ok(app.includes('const shareReady = atTabs && atShell && !coveringBoot && !(deletedState !== null && member !== null && passkey !== null)') && app.includes('ready: shareReady,'), 'ready mirrors the ContaExcluida early return')
  t.ok(app.includes('if (deletedState !== null && member !== null && passkey !== null) {'), 'the early return it mirrors is still there')
  t.ok(/: \(pkStatus !== null && pkStatus\.exists === true && \(pkStatus\.signedOut !== true \|\| pkStatus\.unlocked === true\) && typeof pkStatus\.publicKey === 'string' \? pkStatus\.publicKey\.toLowerCase\(\) : null\)/.test(app), 'the share owner is the stored account, known while locked, and the unlocked one behind a sign-out marker')
  t.ok(app.includes('ownKey: shareOwner,\n    gone: passkey !== null && pkStatus !== null && shareOwner === null,'), 'Sair or Recomeçar marks the account as gone')
  t.ok(app.includes('onSharedTaken={(id) => share.taken(id)}'), 'Publicar can claim the share')
  t.ok(/onSharedDone=\{\(id\) => \{\s*share\.done\(id\)\s*settleSharedChoice\(id\)/.test(app), 'Publicar can let it go and drop its choice')
  t.ok(/onSharedLoaded=\{\(id\) => \{\s*share\.loaded\(id\)\s*settleSharedChoice\(id\)/.test(app), 'Publicar can keep it for a retry without keeping its shell choice')
  t.ok(/onSharedFree=\{\(id\) => \{\s*share\.free\(id\)\s*settleSharedChoice\(id\)/.test(app), 'and free it later')
})

test('the shell asks only for eligible media and remembers one choice across a lock', (t) => {
  const app = read('App.js')
  for (const [name, source] of [
    ['momentComposerOn', 'pageMoment'],
    ['canPublishMoment', 'momentSeen'],
    ['canComposeVideo', 'videoCompose'],
    ['pickVideo', 'media/attach'],
    ['prepareVideo', 'media/videoPrep']
  ]) t.ok(app.includes(`import { ${name} } from './src/${source}'`), name + ' uses the same source as Publicar')
  t.ok(app.includes('const [shareChoice, setShareChoice] = useState(null)'), 'one choice, never an accumulating map')
  t.ok(/const canMoment = \(kind\) => momentComposerOn\(\{ canPublish: canPublishMoment\(node\), reply: null, quote: null \}\) &&\s*\(kind !== 'video' \|\| canComposeVideo\(\{ node, pickVideo, prepareVideo \}\)\)/.test(app), 'Momento and video use the composer capabilities')
  t.ok(/onOpen: \(held\) => \{\s*shownShareRef\.current = held\s*if \(shareChoice && shareChoice\.id === held\.id\) openSharedComposer\(shareChoice\.as\)\s*else if \(shareAsks\(\{ share: held, canMoment \}\)\) setShareAsk\(held\.id\)\s*else openSharedComposer\('post'\)/.test(app), 'the same id reuses its choice before asking, other shares open as posts')
  t.ok(/const openSharedComposer = \(as\) => \{\s*if \(as === 'moment'\) openMomentComposer\(\)\s*else openComposer\(\)/.test(app), 'both choices reuse their existing shell open path')
  t.ok(/const openComposer = \(\) => setComposer\(\(c\) => \(\{ \.\.\.c, open: true \}\)\)/.test(app), 'the post preserves the existing draft context')
  t.ok(/const openMomentComposer = \(\) => \{\s*clearStack\(\)\s*setComposer\(\(c\) => \(\{ \.\.\.c, open: true, reply: null, quote: null, moment: \(c\.moment \|\| 0\) \+ 1 \}\)\)/.test(app), 'Momento clears the stack and context and bumps its request')
  t.ok(/const id = shownShareRef\.current\?\.id\s*setShareAsk\(\(ask\) => ask !== id \? null : ask\)\s*setShareChoosing\(\(choosing\) => choosing !== id \? null : choosing\)\s*if \(!locked && \(shareReady \|\| share\.shared\)\) setShareChoice\(\(choice\) => choice && choice\.id !== id \? null : choice\)/.test(app), 'obsolete ids are dropped without losing a choice while locked or waiting to reopen')
  t.ok(app.includes('const settleSharedChoice = (id) => setShareChoice((choice) => choice && choice.id === id ? null : choice)'), 'settling an older share cannot clear a newer choice')
  t.ok(/const chooseShare = \(id, as\) => \{\s*setShareChoosing\(\(choosing\) => choosing === id \? null : choosing\)\s*if \(shownShareRef\.current\?\.id !== id\) return\s*setShareChoice\(\{ id, as \}\)\s*openSharedComposer\(as\)/.test(app), 'a delayed action only records and opens its own still shown share')
  t.ok(app.includes('shownShareRef.current = locked ? null : share.shared'), 'locking invalidates delayed actions')
})

test('the share chooser dismisses without touching a draft and withholds the share until chosen', (t) => {
  const app = read('App.js')
  const sheet = app.slice(app.indexOf('        <ActionsSheet'), app.indexOf('        <BlockSheet'))
  t.ok(app.includes('const askPending = shareAsk !== null && shareAsk === share.shared?.id'), 'visibility follows the shown share id, including replacement, expiry and lock')
  t.ok(sheet.includes('open={askPending}') && sheet.includes("title='Compartilhar como'"))
  t.ok(sheet.includes("{ icon: 'lapis', label: 'Publicação', description: 'fica no seu Diário', onPress: () => chooseShare(shareAsk, 'post') }"))
  t.ok(app.includes('const shareKind = shareMomentKind(share.shared)'))
  t.ok(sheet.includes("{ icon: 'relogio', label: 'Momento', description: shareKind === 'video' ? 'vídeo de até 15 segundos, some em 24 horas' : 'some em 24 horas', onPress: () => chooseShare(shareAsk, 'moment') }"))
  t.ok(/onClose=\{\(why\) => \{\s*if \(why === 'action'\) setShareChoosing\(shareAsk\)\s*else share\.done\(shareAsk\)\s*setShareAsk\(null\)\s*\}\}/.test(sheet), 'only dismissal discards the share; both close paths clear the ask and neither touches a draft')
  t.ok(app.includes('shared={shareWithheld ? null : share.shared}'), 'Publicar cannot claim the share while asking')
  t.ok(app.includes('const shareWithheld = askPending || (shareChoosing !== null && shareChoosing === share.shared?.id)'), 'nor during the slide out before the tapped row runs')
  t.ok(/const chooseShare = \(id, as\) => \{\s*setShareChoosing\(\(choosing\) => choosing === id \? null : choosing\)/.test(app), 'the choice ends the wait')
  t.ok(app.includes('sharedAs={shareChoice && share.shared && shareChoice.id === share.shared.id ? shareChoice.as : null}'), 'a choice reaches only its own share')
  t.ok(app.includes('const sheetOpen = composer.open || shareAsk !== null || report !== null || ajustes !== null'), 'back, Escape and other sheets see the chooser')
})

test('a share choice survives a delayed unlock and is cleared when no share reopens', (t) => {
  const app = read('App.js')
  if (!app.includes('onOpen: (held) => {')) {
    t.fail('onOpen must receive the held share')
    return
  }
  const open = app.slice(app.indexOf('    onOpen: (held) => {') + '    onOpen: '.length, app.indexOf(',\n    onToast: showToast', app.indexOf('    onOpen: (held) => {')))
  const cleanup = app.slice(app.indexOf('    const id = shownShareRef.current?.id'), app.indexOf('  }, [share.shared, locked, shareReady])'))
  const calls = []
  const scope = {
    locked: true,
    shareReady: false,
    share: { shared: null },
    shareChoice: { id: 'held', as: 'moment' },
    shareAsk: null,
    shownShareRef: { current: null },
    canMoment: () => true,
    shareAsks: () => { calls.push('ask'); return true },
    openSharedComposer: (as) => calls.push(as),
    setShareAsk: (value) => { scope.shareAsk = typeof value === 'function' ? value(scope.shareAsk) : value },
    setShareChoosing: (value) => { scope.shareChoosing = typeof value === 'function' ? value(scope.shareChoosing) : value },
    setShareChoice: (fn) => { scope.shareChoice = fn(scope.shareChoice) }
  }
  const onOpen = runInNewContext('(' + open + ')', scope)
  const clean = () => runInNewContext('{' + cleanup + '}', scope)
  clean()
  t.alike(scope.shareChoice, { id: 'held', as: 'moment' }, 'lock keeps the choice')
  scope.locked = false
  clean()
  t.alike(scope.shareChoice, { id: 'held', as: 'moment' }, 'unlock can still wait for the shell')
  scope.shareReady = true
  onOpen({ id: 'held' })
  clean()
  t.alike(calls, ['moment'], 'onOpen restores the held id before cleanup without asking again')
  t.alike(scope.shareChoice, { id: 'held', as: 'moment' })
  scope.shownShareRef.current = null
  clean()
  t.is(scope.shareChoice, null, 'a ready shell with no held share drops the choice')
  onOpen({ id: 'next' })
  clean()
  t.is(scope.shareAsk, 'next', 'the next share asks without opening a composer')
  t.alike(calls, ['moment', 'ask'])
})

// A shared photo that failed to open keeps its file for 'tentar de novo'
// without blocking the next share, and is freed once nothing needs it.
test('Publicar keeps a share for a retry and frees it once nothing needs it', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(/holdRef\.current = next\.hold\s*onSharedLoaded\(shared\.id\)/.test(src), 'a failed photo keeps the share, and the shell lets go of it')
  t.ok(/addFiles\(shared\.files, [\s\S]{0,400}?\.then\(done, \(\) => done\(\[\]\)\)/.test(src), 'a failed load still lets the share go')
  t.ok(/const removeItems = \(ids\) => \{[\s\S]*?sourcesRef\.current\.delete\(id\)[\s\S]*?settleShare\(Array\.from\(gone\)\)\s*\}/.test(src), 'removing, publishing or discarding a photo settles the hold')
  t.ok(/sourcesRef\.current\.delete\(id\)\s*readyItem\(id, encoded\)\s*settleShare\(\[id\]\)/.test(src), 'a retry that opens settles it')
  t.ok(/if \(!again\) \{\s*sourcesRef\.current\.delete\(id\)\s*settleShare\(\[id\]\)/.test(src), 'a retry that fails for good settles it')
  t.ok(/if \(holdRef\.current !== null\) freeRef\.current\(holdRef\.current\.id\)\s*holdRef\.current = null\s*\}, \[\]\)/.test(src), 'unmounting (a lock) frees it')
  t.ok(/if \(holdRef\.current !== null\) \{\s*const old = holdRef\.current[\s\S]*?freeRef\.current\(old\.id\)/.test(src), 'a newer share frees the older one')
  t.ok(/if \(source === undefined \|\| !liveRef\.current\.has\(id\) \|\| held \|\| encodingAny\) return/.test(src), 'one decode at a time, never while sending')
  t.ok(/if \(Date\.now\(\) > source\.until\) \{\s*sourcesRef\.current\.delete\(id\)\s*settleShare\(\[id\]\)\s*patch\(id, \{ error: EXPIRED_TEXT, reencode: false \}\)/.test(src), 'past the share expiry the retry ends, since the sweep took the file')
  t.ok(/\}\)\), shared\.at \+ SHARE_TTL_MS\)\.then\(done/.test(src), 'a shared photo expires with its share')
  t.ok(/const again = retryableEncode\(error\) && sourcesRef\.current\.has\(id\)/.test(src), 'a retry that ends after a newer share replaced its files offers no other')
})

// A shared video goes through the gallery's preparation; its file stays
// until that ends, and the shell is never left holding it.
test('Publicar prepares a shared video and frees its file when the preparation ends', (t) => {
  const src = read('src/screens/Publicar.js')
  const effect = src.slice(src.indexOf('const sharedVideo = shared.video || null'))
  t.ok(effect.indexOf('video.draft.pick(') < effect.indexOf('if (shared.files.length === 0 || !canAttach)'), 'the video is handled before the photo path')
  t.ok(/if \(!canVideo\) \{\s*onSharedDone\(shared\.id\)\s*return\s*\}/.test(effect), 'where no video can be attached, the share is let go with the note')
  t.ok(/if \(video\.draft\.state\.phase !== 'empty'\) \{\s*setShareNote\(VIDEO_HELD_TEXT\)\s*onSharedDone\(shared\.id\)\s*return\s*\}/.test(effect), 'a draft that already has a video keeps it and says so')
  t.ok(/const id = shared\.id\s*onSharedLoaded\(id\)\s*video\.draft\.pick\(\{\s*pickVideo: async \(\) => sharedVideo,\s*prepareVideo,/.test(effect), 'the shell lets go before the same preparation as the gallery')
  t.ok(/video\.draft\.pick\(\{[\s\S]{0,300}?\}\)\.catch\(\(err\) => \{\s*if \(mountedRef\.current\) setShareNote\(err\.message\)\s*\}\)\.finally\(\(\) => freeRef\.current\(id\)\)/.test(effect), 'its file is freed however the preparation ends, even unmounted')
})

test('Publicar keeps the plain post text across a web share reload, for the same account', (t) => {
  const src = read('src/screens/Publicar.js')
  t.ok(src.includes("import { dropDraft, takeDraft, watchDraft } from '../draftKeep'"))
  t.ok(src.includes("keptTextRef.current = !replyProp && !quote && asPage === null ? text : ''"), 'never a reply, a quote or a page post')
  t.ok(/const kept = takeDraft\(keepOwner\)/.test(src), 'read for this account only')
  t.ok(/return \(\) => \{\s*stop\(\)\s*dropDraft\(\)\s*\}\s*\}, \[keepOwner\]\)/.test(src), 'a lock or an account change drops it')
  t.ok(src.indexOf('const kept = takeDraft(keepOwner)') < src.indexOf('const merged = mergeDraft(current, shared.text, MAX_TEXT)'), 'restored before a share in the same commit merges into it')
  t.ok(/const current = textRef\.current\s*const merged = mergeDraft\(current, shared\.text, MAX_TEXT\)/.test(src), 'the share merges into the restored text')
})

test('the hook tells once, when the app is ready, that a web share did not fit', (t) => {
  const hook = read('src/useSharedIntent.js')
  t.ok(/if \(shareIntake\.takeLost\(\)\) lostRef\.current = true/.test(hook), 'the marker is read on mount')
  t.ok(/if \(gone === true\) \{\s*lostRef\.current = false\s*return\s*\}\s*if \(ready !== true \|\| locked === true\) return\s*lostRef\.current = false\s*latest\.current\.onToast\(LOST_TEXT\)\s*\}, \[ready, locked, gone\]\)/.test(hook), 'the toast waits for an unlocked, ready app, and never reaches the next account')
})

test('Momento shares choose their draft before post merging and wait for its activation', (t) => {
  const src = read('src/screens/Publicar.js')
  const effect = src.slice(src.indexOf('    const kind = shareMomentKind(shared)'), src.indexOf('  const pickEmoji ='))
  const branch = effect.slice(0, effect.indexOf("    setMode('post')"))
  t.ok(src.includes('sharedAs = null'), 'existing callers still select the post path')
  t.ok(branch.includes("sharedAs === 'moment' && momentOn && !moment.held && (kind === 'photo' || (kind === 'video' && canComposeVideo({ node, pickVideo, prepareVideo })))"), 'kind and capabilities gate Momento')
  t.ok(branch.includes('moment.setNote(moment.takeText(shared.text, shared.clipped))'), 'caption overflow and a share cut to the post limit use the momento notice')
  t.ok(branch.includes("pendingShareRef.current = { shared, kind, as: 'moment', prevText }\n      return"), 'the branch only records work, then returns')
  t.absent(branch.includes('mergeDraft('), 'no post text is touched in the momento branch')
  t.absent(/moment\.stage(?:Photo|Clip)/.test(branch), 'staging waits for a later effect')
  t.ok(effect.indexOf("setMode('moment')") < effect.indexOf('mergeDraft(current, shared.text, MAX_TEXT)'))
  t.ok(effect.includes("const setShareNote = (note) => setNote(sharedAs === 'moment' ? [note, MOMENT_SHARE_BACK].filter(Boolean).join('. ') : note)"), 'ineligible shares keep the post note and explain the destination')
  const stage = effect.slice(effect.indexOf('    const pending = pendingShareRef.current'))
  t.ok(stage.includes('if (!pending || !open || reframing || frozen || busy || moment.pending) return'))
  t.ok(stage.indexOf("if (pending.as === 'moment' ? !momentMode : momentMode) return") < stage.indexOf('moment.stagePhoto('), 'both preparations wait for their active draft')
  t.ok(stage.indexOf('pendingShareRef.current = null') < stage.indexOf('onSharedLoaded(id)'), 'a pending share is consumed once')
  t.ok(stage.includes("pending.as === 'moment' && kind === 'video' && err.code === 'OVER_LIMIT'"), 'only the first attempt can fall back')
  t.ok(stage.includes("pendingShareRef.current = { shared, kind, as: 'post', note, loaded: true }"))
  t.ok(src.includes('if (pendingShareRef.current !== null && pendingShareRef.current.loaded === true) freeRef.current(pendingShareRef.current.shared.id)'), 'unmount frees only a share the shell already let go of; the lock hands an unstaged one back')
  t.ok(stage.includes('momentShareBack(Math.round(err.limitMs / 1000))'))
  t.ok(stage.includes('if (!fallback) freeRef.current(id)'), 'only the last attempt frees the source')
  t.absent(/takeText/.test(stage), 'staging never takes the momento text again')
  t.is(stage.split('mergeDraft(').length, 2, 'the shared text reaches the post once, only in the fallback')
})

async function shareHarness (overrides = {}) {
  const src = read('src/screens/Publicar.js')
  const start = src.lastIndexOf('  useEffect(() => {', src.indexOf('    if (!(open && shared'))
  const effect = src.slice(start, src.indexOf('  const pickEmoji =', start))
  const calls = []
  let note = ''
  let mode = 'post'
  let caption = ''
  const scope = {
    ...(await import('../src/sharedIntent.js')),
    ...(await import('../src/videoCompose.js')),
    open: true,
    shared: { id: 'share', text: 'legenda', files: [{}], video: null, dropped: 0, failed: 0, videoNote: '', clipped: false, at: Date.now() },
    sharedAs: 'moment',
    momentOn: true,
    momentMode: false,
    canVideo: true,
    canAttach: true,
    node: { online: true, media: { video: true } },
    pickVideo: async () => { throw new Error('no picker') },
    prepareVideo: async () => {},
    reframing: false,
    frozen: false,
    busy: false,
    appliedShareRef: { current: null },
    pendingShareRef: { current: null },
    holdRef: { current: null },
    sourcesRef: { current: new Map() },
    mountedRef: { current: true },
    freeRef: { current: (id) => calls.push(['free', id]) },
    liveRef: { current: new Set() },
    linkDraft: { view: null },
    musicDraftRef: { current: null },
    textRef: { current: 'post guardado' },
    MAX_TEXT: 300,
    patch: () => {},
    onSharedTaken: (id) => calls.push(['taken', id]),
    onSharedLoaded: (id) => calls.push(['loaded', id]),
    onSharedDone: (id) => calls.push(['done', id]),
    setMode: (value) => { mode = value },
    setNote: (value) => { note = value },
    setWebShare: () => {},
    setText: (value) => calls.push(['post text', value]),
    setLinkHold: () => {},
    addFiles: async (files, notify) => { calls.push(['post photos', files]); notify(0); return [] },
    moment: {
      pending: false,
      text: 'momento antes',
      setText: (value) => calls.push(['moment text', value]),
      setNote: (value) => calls.push(['moment note', value]),
      takeText: (value) => { caption = value; return '' },
      stagePhoto: async (file) => { calls.push(['moment photo', file]); return true },
      stageClip: async (pick) => { calls.push(['moment video', await pick()]); return true }
    },
    video: { draft: { state: { phase: 'empty' }, pick: async (args) => { calls.push(['post video', await args.pickVideo()]); return true } } },
    ...overrides
  }
  const run = (index) => {
    const effects = []
    const deps = { ...scope, useEffect: (fn) => effects.push(fn) }
    new Function(...Object.keys(deps), effect)(...Object.values(deps)) // eslint-disable-line no-new-func
    effects[index]()
  }
  return {
    scope,
    calls,
    intake: () => run(0),
    stage: () => run(1),
    flush: async () => { for (let i = 0; i < 20; i++) await Promise.resolve() },
    get mode () { return mode },
    get note () { return note },
    get caption () { return caption }
  }
}

test('a shared momento photo waits for activation, stages once and frees after encoding', async (t) => {
  const h = await shareHarness()
  let resolve
  h.scope.moment.stagePhoto = (file) => {
    h.calls.push(['moment photo', file])
    return new Promise((_resolve) => { resolve = _resolve })
  }
  h.intake()
  h.stage()
  t.is(h.mode, 'moment')
  t.is(h.caption, 'legenda')
  t.is(h.scope.textRef.current, 'post guardado')
  t.alike(h.calls.map(([kind]) => kind), ['taken', 'moment note'], 'inactive draft has not read the source')
  h.scope.momentMode = true
  h.stage()
  h.stage()
  t.alike(h.calls.map(([kind]) => kind), ['taken', 'moment note', 'loaded', 'moment photo'])
  t.is(h.calls.at(-1)[1], h.scope.shared.files[0], 'the raw file reaches the photo draft')
  resolve(true)
  await h.flush()
  t.alike(h.calls.at(-1), ['free', 'share'])
  h.intake()
  t.is(h.calls.filter(([kind]) => kind === 'taken').length, 1, 'the same id is never reapplied')
})

test('OVER_LIMIT falls back once after post activation and frees only after the last attempt', async (t) => {
  const h = await shareHarness()
  const error = Object.assign(new Error('too long'), { code: 'OVER_LIMIT', limitMs: 15500 })
  h.scope.shared.files = []
  h.scope.shared.video = { uri: 'test:clip' }
  h.scope.moment.stageClip = async (pick) => { h.calls.push(['moment video', await pick()]); throw error }
  let reject
  h.scope.video.draft.pick = async (args) => {
    h.calls.push(['post video', await args.pickVideo()])
    return new Promise((resolve, _reject) => { reject = _reject })
  }
  h.intake()
  h.scope.momentMode = true
  h.stage()
  await h.flush()
  t.is(h.mode, 'post')
  t.is(h.note, h.scope.momentShareBack(16))
  t.absent(h.calls.some(([kind]) => kind === 'free'))
  h.stage()
  t.absent(h.calls.some(([kind]) => kind === 'post video'), 'the post draft is still inactive')
  h.scope.momentMode = false
  h.stage()
  await h.flush()
  t.is(h.calls.at(-1)[1], h.scope.shared.video, 'both attempts read the same clip')
  t.absent(h.calls.some(([kind]) => kind === 'free'), 'post preparation still owns the file')
  reject(error)
  await h.flush()
  h.stage()
  t.is(h.scope.pendingShareRef.current, null, 'a second OVER_LIMIT never retries')
  t.is(h.calls.filter(([kind]) => kind === 'post video').length, 1)
  t.is(h.calls.filter(([kind]) => kind === 'free').length, 1)
  t.is(h.scope.textRef.current, 'post guardado\nlegenda', 'the shared caption follows the clip into the post')
  t.is(h.caption, 'legenda')
  t.ok(h.calls.some(([kind, value]) => kind === 'moment text' && value === 'momento antes'), 'the momento text is given back')
  t.ok(h.calls.some(([kind, value]) => kind === 'moment note' && value === ''), 'the momento notice is cleared')
})

test('ineligible Momento shares use the original post path and append its explanation', async (t) => {
  for (const reason of ['unavailable', 'kind', 'video', 'held']) {
    const h = await shareHarness()
    if (reason === 'held') h.scope.moment.held = true
    if (reason === 'unavailable') h.scope.momentOn = false
    if (reason === 'kind') h.scope.shared.files = []
    if (reason === 'video') {
      h.scope.shared.files = []
      h.scope.shared.video = {}
      h.scope.node.online = false
      h.scope.canVideo = false
    }
    h.intake()
    await h.flush()
    t.is(h.mode, 'post', reason)
    t.is(h.caption, '', 'momento text is untouched')
    t.ok(h.scope.textRef.current.includes('legenda'))
    t.ok(h.note.endsWith(h.scope.MOMENT_SHARE_BACK))
    t.is(h.scope.pendingShareRef.current, null)
    t.alike(h.calls.at(-1), ['done', 'share'])
  }
  for (const sharedAs of [null, 'post']) {
    const h = await shareHarness({ sharedAs })
    h.intake()
    await h.flush()
    t.is(h.mode, 'post')
    t.is(h.note, '', 'existing post shares gain no extra notice')
    t.is(h.caption, '')
  }
})

test('a share waits while a momento is still sending, as on main', async (t) => {
  const h = await shareHarness()
  h.scope.moment.pending = true
  h.intake()
  await h.flush()
  t.is(h.calls.length, 0, 'nothing is taken during the send')
  t.is(h.scope.appliedShareRef.current, null)
  h.scope.moment.pending = false
  h.intake()
  t.is(h.mode, 'moment', 'taken once the send ends')
})

test('the deferred share keeps every intake guard and the post fallback media guards', async (t) => {
  for (const guard of ['open', 'reframing', 'frozen', 'busy', 'pending']) {
    const h = await shareHarness()
    h.intake()
    h.scope.momentMode = true
    if (guard === 'pending') h.scope.moment.pending = true
    else h.scope[guard] = guard !== 'open'
    h.stage()
    t.absent(h.calls.some(([kind]) => kind === 'loaded'), guard)
    t.ok(h.scope.pendingShareRef.current, 'the blocked share waits')
  }
  for (const outcome of ['ready', 'unavailable', 'held']) {
    const h = await shareHarness()
    h.scope.shared.files = []
    h.scope.shared.video = {}
    h.scope.moment.stageClip = async () => { throw Object.assign(new Error('long'), { code: 'OVER_LIMIT', limitMs: 15000 }) }
    h.intake()
    h.scope.momentMode = true
    h.stage()
    await h.flush()
    h.scope.momentMode = false
    if (outcome === 'unavailable') h.scope.canVideo = false
    if (outcome === 'held') h.scope.video.draft.state.phase = 'ready'
    h.stage()
    await h.flush()
    t.is(h.calls.filter(([kind]) => kind === 'post video').length, outcome === 'ready' ? 1 : 0, outcome)
    t.is(h.calls.filter(([kind]) => kind === 'free').length, 1)
    t.ok(h.note.includes(h.scope.momentShareBack(15)))
    if (outcome === 'held') t.ok(h.note.includes(h.scope.VIDEO_HELD_TEXT))
    t.is(h.scope.textRef.current, 'post guardado\nlegenda', 'the caption follows, as the post path keeps it')
  }
})

test('other clip errors and OVER_LIMIT after unmount never start a post attempt', async (t) => {
  for (const mounted of [true, false]) {
    const h = await shareHarness()
    h.scope.shared.files = []
    h.scope.shared.video = {}
    h.scope.moment.stageClip = async () => { throw Object.assign(new Error('erro'), { code: mounted ? 'DECODE' : 'OVER_LIMIT' }) }
    h.intake()
    h.scope.momentMode = true
    h.stage()
    h.scope.mountedRef.current = mounted
    await h.flush()
    t.is(h.scope.pendingShareRef.current, null)
    t.is(h.mode, 'moment')
    t.alike(h.calls.at(-1), ['free', 'share'])
    t.absent(h.calls.some(([kind]) => kind === 'post video'))
  }
})

test('a staging refusal hands photos or video to the post once and keeps the source until it finishes', async (t) => {
  for (const kind of ['photo', 'video']) {
    const h = await shareHarness()
    if (kind === 'video') { h.scope.shared.files = []; h.scope.shared.video = {} }
    h.scope.moment.stagePhoto = h.scope.moment.stageClip = async () => false
    h.intake()
    h.scope.momentMode = true
    h.stage()
    await h.flush()
    t.is(h.mode, 'post', kind)
    t.is(h.note, h.scope.MOMENT_SHARE_BACK)
    t.ok(h.calls.some(([op, value]) => op === 'moment text' && value === 'momento antes'))
    t.absent(h.calls.some(([op]) => op === 'free'))
    t.is(h.scope.textRef.current, 'post guardado\nlegenda')
    let finish
    const waiting = new Promise((resolve) => { finish = resolve })
    if (kind === 'photo') h.scope.addFiles = async (files) => { h.calls.push(['post photos', files]); await waiting; return [] }
    else h.scope.video.draft.pick = async (args) => { h.calls.push(['post video', await args.pickVideo()]); await waiting; return false }
    h.stage()
    t.absent(h.calls.some(([op]) => op === 'post photos' || op === 'post video'), 'fallback waits for activation')
    h.scope.momentMode = false
    h.stage()
    await h.flush()
    t.absent(h.calls.some(([op]) => op === 'free'), 'the post is still reading')
    finish()
    await h.flush()
    h.stage()
    h.intake()
    t.is(h.calls.filter(([op]) => op === 'post photos' || op === 'post video').length, 1)
    t.is(h.calls.filter(([op]) => op === 'loaded').length, 1)
    t.is(h.calls.filter(([op]) => op === 'free').length, 1)
    t.is(h.scope.pendingShareRef.current, null)
  }
})

test('a photo fallback keeps failed sources for the existing explicit retry', async (t) => {
  const h = await shareHarness()
  h.scope.moment.stagePhoto = async () => false
  h.intake()
  h.scope.momentMode = true
  h.stage()
  await h.flush()
  h.scope.sourcesRef.current.set(42, {})
  h.scope.addFiles = async () => [42, 43]
  h.scope.momentMode = false
  h.stage()
  await h.flush()
  t.alike(h.scope.holdRef.current, { id: 'share', ids: [42] })
  t.absent(h.calls.some(([op]) => op === 'free'))
})
