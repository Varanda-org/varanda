'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { compileFunction } = require('node:vm')

const src = readFileSync(join(__dirname, '../src/screens/Conversa.js'), 'utf8')
const app = readFileSync(join(__dirname, '../App.js'), 'utf8')

const between = (start, end) => {
  const from = src.indexOf(start)
  const to = src.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error('section not found: ' + start)
  return src.slice(from, to)
}

test('Conversa: the root is the only main post and the thread has two levels', (t) => {
  t.absent(src.includes("label='Ver conversa'"), 'no row re-roots the thread')
  t.ok(src.includes("import { SEEK_PAGES, resolveRoot, seekTarget } from '../rodaLoad'"))
  t.ok(src.includes('await resolveRoot({ key: focal }, { fetchPost, fetchRoda, read })'), 'any post resolves to its root')
  t.ok(src.includes('assembleThread({ focal: rootRef, index, peeked })'), 'comments pass the signed gate of the root')
  t.ok(src.includes('const out = assembleRoda({'), 'roda rows pass the signed chain gate')
  t.ok(src.includes('rodaOrder(roda.replies, key)'))
  t.ok(src.includes('const rows = commentRows({'))
  t.ok(src.includes('withAnchor(commentOrder(ownComments.reduce(withOwnReply, page), { follows: followSet, ownKey }), anchor)'), 'own and followed first, anchor first')
  t.ok(src.includes('appendComments(before, commentOrder(page.replies, { follows: followSet, ownKey }))'), 'a later page never reorders what is shown')
  t.absent(/\bthreadRows\(|deeperOf/.test(src), 'the nested layout is gone')
  t.absent(src.includes('loadChildren'), 'no depth walk')
  t.ok(src.includes('setOpen(new Set())') && src.includes('putRodas(new Map())'))
  t.ok(src.includes('borderLeftWidth: 1, borderLeftColor: colors.line'))
})

test('Conversa: no tap inside the thread pushes another Conversa', (t) => {
  t.ok(src.includes('const THREAD_ROW = { onOpen: undefined, onOpenParent: undefined, replyToName: null }'))
  t.ok(src.includes('const SEED_ROW = { onOpen: undefined, onOpenParent: undefined }'))
  const renderer = between('  renderRef.current = (row) => {', '  const notes = []')
  t.absent(renderer.includes('onOpenThread'), 'no thread row builds an onOpenThread')
  t.is(renderer.split('props(row.item, THREAD_ROW, row.key)').length - 1, 2, 'comments and replies both drop the open taps')
  const header = between('  const header = (', '  // The screen pads')
  t.absent(header.includes('onOpenThread'))
  t.is(header.split('props(post, THREAD_ROW)').length - 1, 2, 'the root and the orphan row')
  t.ok(header.includes('props(seed, SEED_ROW)'))
  const rows = src.slice(src.indexOf('export function rowProps'), src.indexOf('export function seedItem'))
  t.ok(rows.includes('onOpen: hasSeq ? () => live.handlers.onOpenThread({ ref, seed: item }) : undefined,'), 'Membro keeps its row tap')
  t.ok(rows.includes('onOpen: () => live.handlers.onOpenThread({ ref: qref, seed: q })'), 'a quoted post still opens its own thread')
  t.ok(rows.indexOf('...extra') > rows.indexOf('onOpenParent:'), 'extra overrides the taps')
})

test('Conversa: levels, the author tag and the reply quote reach PostRow', (t) => {
  const renderer = between('  renderRef.current = (row) => {', '  const notes = []')
  t.ok(src.includes("<PostRow expanded level='post' {...props(post, THREAD_ROW)} />"))
  t.ok(renderer.includes("<PostRow {...props(row.item, THREAD_ROW, row.key)} level='comment' tag={tag} />"))
  t.ok(renderer.includes("<PostRow {...props(row.item, THREAD_ROW, row.key)} level='reply' tag={tag} replyQuote={quoteOf(row)} />"))
  t.ok(renderer.includes('const tag = row.isAuthor ? AUTHOR_TAG : undefined'))
  t.ok(src.includes("postAuthor: view.post && view.status === 'ok' ? view.post.author : null"), 'an orphan top-most message is never tagged as the post author')
  t.ok(between('  const quoteOf =', '  renderRef.current = (row) =>').includes("onPress: () => scrollRef.current('reply:' + ref)"), 'the quote tap jumps to the answered row')
})

test('Conversa: a seed with replyTo is never drawn expanded', (t) => {
  const fallback = between('  if (!full && !sending) {', '  const { phase, error, meta')
  t.ok(fallback.includes("? <PostRow {...props(seed, SEED_ROW)} level='comment' />"), 'offline: the reply keeps its chip at comment level')
  t.ok(fallback.includes(": <PostRow {...props(seed, SEED_ROW)} level='post' expanded />"), 'offline: a root seed paints as the post')
  t.ok(fallback.indexOf('seed.replyTo') < fallback.indexOf('expanded'))
  t.ok(src.includes('const seedIsRoot = seed !== null && (seed.replyTo === null || focus !== null)'), 'focus: the seed is the root and paints at once')
  t.ok(src.includes("const post = view.post || (phase !== 'ready' && seedIsRoot ? seed : null)"), 'only a root seed takes the main row while loading')
  const header = between('  const header = (', '  // The screen pads')
  t.ok(/phase !== 'ready' && seed && !seedIsRoot[\s\S]*\{phase === 'loading' \? <Skeleton rows=\{1\} \/> : null\}\s*<PostRow level='comment' \{\.\.\.props\(seed, SEED_ROW\)\} \/>/.test(header), 'a reply seed waits under a placeholder')
  t.is(header.split('expanded').length - 1, 1, 'only the root row is expanded')
  t.absent(src.includes('styles.connector') || src.includes('styles.parent') || src.includes('parentHeight'), 'no dimmed parent header')
})

test('Conversa: an orphan shows its top-most message at comment level with its replies', (t) => {
  t.ok(src.includes("const PARENT_GONE_NOTE = 'A publicação respondida está indisponível.'"))
  t.ok(src.includes("if (phase === 'ready' && status === 'orphan') notes.push(view.cut ? CUT_NOTE : PARENT_GONE_NOTE)"))
  t.ok(src.includes("{post && phase === 'ready' && status === 'orphan'\n        ? <PostRow level='comment' {...props(post, THREAD_ROW)} />"))
  t.ok(src.includes("{post && (phase !== 'ready' || status === 'ok')"), 'the expanded row is for a real root only')
})

test('Conversa: comment copy', (t) => {
  t.ok(src.includes("const title = 'Comentários'"))
  t.ok(!src.includes('commentsTitle') && !src.includes('repliesTitle'), 'no count line under the main post')
  t.ok(src.includes("phase === 'ready' && notes.length > 0"))
  t.ok(src.includes("unavailable === 1 ? '1 comentário indisponível' : String(unavailable) + ' comentários indisponíveis'"))
  t.ok(src.includes("moreError: 'Não foi possível carregar mais comentários.'"))
  t.ok(src.includes("placeholder={toRoot ? 'Escreva um comentário' : undefined}"), 'the bar default stays for a reply')
  t.ok(src.includes("sendLabel={toRoot ? 'Comentar' : undefined}"), 'send reads Comentar on the post, Responder on a comment')
  t.ok(src.includes("else if ((meta && meta.complete === false) || rodaGaps) notes.push('Algumas respostas podem faltar.')"))
  t.ok(src.includes("roda.loaded && (roda.complete === false || (roda.mode === 'direct' && roda.replies.some("), 'a cut roda, or direct replies with replies of their own')
  t.ok(src.includes('replies: Math.max(index.repliesTotal, comments.length)'), 'the root count keeps the floor of what the screen shows')
  t.ok(src.includes("if (phase === 'ready' && !view.post) notes.push('Esta publicação não pôde ser verificada agora.')"), 'the unverified note sits in the bordered notes block')
  t.ok(!src.includes('<Soft>Esta publicação não pôde ser verificada agora.</Soft>'))
  t.ok(!src.includes('meta.repliesTotal'), 'no count state on the screen meta')
  t.absent(src.includes('\u2014'))
})

test('Conversa: full nodes pin ReplyBar and keep the sheet path elsewhere', (t) => {
  const fallback = between('  if (!full && !sending) {', '  const { phase, error, meta')
  t.ok(fallback.includes('<OfflineNote />'), 'a send in flight keeps the bar mounted through an offline blip')
  t.absent(fallback.includes('<ReplyBar'), 'no bar without a full node')
  t.ok(src.includes('onReply: full ? targetReply : onReply'))
  t.ok(src.includes('{full || sending\n        ? (') && src.includes('<ReplyBar'))
  t.is(src.split('<ReplyBar').length - 1, 1)
  t.ok(src.includes('onClearTarget={() => setReplyTarget(null)}'))
  t.ok(src.includes('onSend={sendReply}'))
  t.ok(src.includes('renderItem={renderItem}'))
})

test('Conversa: thread rows are stable across renders', (t) => {
  t.absent(/renderItem=\{\(/.test(src), 'no inline renderItem')
  t.ok(src.includes('const renderItem = useCallback(({ item: row }) => renderRef.current(row), [])'), 'one renderItem through a ref')
  t.ok(src.includes('renderRef.current = (row) => {'), 'the ref holds the newest row renderer')
  t.ok(src.includes('extraData={extra}') && src.includes('const extra = useMemo(() => ({ eng, follows, now, rodas, rodaBusy, rodaErrors, flashKey, sending, styles, profileOf: names.profileOf }), [eng, follows, now, rodas, rodaBusy, rodaErrors, flashKey, sending, styles, names.profileOf])') && src.includes('return useMemo(() => ({ state, counts, pending, reset, readOwn, readCounts, setCount, toggle }), [state, counts, pending, reset, readOwn, readCounts, setCount, toggle])'), 'extraData is memoized on what rows read')
  t.ok(src.includes('const rowCache = useThreadRowCache(rows.map((row) => row.key), { handlers, eng: full ? eng : null })'), 'the list owns a row props cache')
  t.is(src.split('{...props(row.item, THREAD_ROW, row.key)}').length - 1, 2, 'comment and reply rows take cached props')
  t.ok(src.includes('const shownRodas = useMemo(() => new Map([...rodas].map(([key, roda]) => [key, rodaOrder(roda.replies, key)])), [rodas])'), 'the roda order is kept while the rodas are')
  t.ok(src.includes('return cachedRow(cache, rowKey, inputs, latest, build)'), 'rowProps caches through cachedRow')
  const hooks = src.indexOf('const rowCache = useThreadRowCache(')
  t.ok(hooks !== -1 && hooks < src.indexOf('if (!full && !sending) {'), 'the list hooks run before the offline return')
  const screen = src.slice(src.indexOf('export default function Conversa ('), src.indexOf('export function ReplyDock ('))
  t.absent(screen.includes('useKeyboardOpen()'), 'the keyboard state is not read by the screen')
  t.ok(/export function ReplyDock \([^)]*\) \{\s*const insets = useSafeAreaInsets\(\)\s*const keyboardOpen = useKeyboardOpen\(\)/.test(src), 'the reply dock owns the keyboard state')
})

test('Conversa: compose signals match the opened post and wait for the root', (t) => {
  t.ok(app.includes('const [composeSignal, setComposeSignal] = useState(null)'))
  t.ok(app.includes("node.hosted && node.online !== false && actingAs.get().kind !== 'page' && r.draft === undefined"))
  t.ok(app.includes("pushScreen({ screen: 'conversa', key: r.ref })"))
  t.ok(app.includes('setComposeSignal((previous) => ({ target: r, n: previous ? previous.n + 1 : 1 }))'))
  t.ok(app.includes('composeSignal={') && src.includes('full && root !== null && composeSignal && composeSignal !== lastCompose.current && composeSignal.target.ref === focal'))
  t.ok(src.includes('}, [composeSignal, focal, root, full, targetReply, onComposeSeen])'))
  t.ok(src.includes('focusSignal={focusSignal}'))
  const openThread = app.slice(app.indexOf('  const openThread ='), app.indexOf('  const openEngagers ='))
  t.ok(openThread.includes('setComposeSignal(null)'), 'ordinary navigation drops a previous reply focus')
  t.ok(openThread.includes('({ ref, seed, focus } = {})'))
  t.ok(openThread.includes('params: { seed: seed || null, focus: focus || null }'), 'focus rides in the params')
})

test('Conversa quick sends retain uncertain drafts and delegate expansion acceptance', (t) => {
  t.ok(src.includes('quickReplyPlan({ text, nodeReady: full, actingAsPage: actingPageKey() !== null, hasLink: hasLink(text), refusal })'))
  t.ok(src.includes('const refusal = refusalOf(text)'))
  t.ok(src.includes('if (result.gated) return expandReply(text, target)'))
  t.ok(src.includes('result.error.uncertain === true'))
  t.ok(src.includes('result.refused ||'))
  t.ok(src.includes('sendTextReply({ request, text, replyTo: target.ref })'), 'replyTo is the exact message')
  t.ok(src.includes("onPublished('quick-reply', target.ref)"))
  t.ok(app.includes('onPublished={onPublished}'))
  t.ok(app.includes('onReplyDraft={settleReplyDraft}'))
  t.ok(src.includes('const accepted = await onReply(attach ? { ...target, draft, attach } : { ...target, draft })'))
  t.ok(app.includes('return new Promise((resolve) => {'))
})

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const focal = B + ':4'

// Execute the screen's handler, with real planning and sending helpers, without mounting React Native.
function handler (source, start, end, name, context) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error('handler not found: ' + name)
  return compileFunction(source.slice(from, to) + '\nreturn ' + name, Object.keys(context))(...Object.values(context))
}

const refOf = (author, seq) => author + ':' + seq

async function localReplies (registerLocalCache = () => {}) {
  const { withOwnReply } = await import('../src/threadRows.js')
  return handler(src, 'const ownReplyCache =', 'const INITIAL =', '{ ownFor, cacheOwnReply, ownReplyCache, ownReplyCopies, deletionListeners, announceDeleted, forgetOwnReplies, dropOwnReplies, pruneOwnReplies, refsOf, appendComments, topOf }', {
    withOwnReply,
    registerLocalCache,
    refOf
  })
}

const item = (seq, parent = 4, author = A, parentAuthor = B) => ({ kind: 'post', author, seq, at: '2026-01-01T00:00:0' + (seq % 10) + '.000Z', text: 'resposta ' + seq, replyTo: { author: parentAuthor, seq: parent } })

async function sending (options = {}) {
  const { quickReplyPlan, sendTextReply } = await import('../src/replySend.js')
  const { mergeChildren } = await import('../src/threadRows.js')
  const { parseRef } = await import('../src/thread.js')
  const { refusalOf } = await import('../src/wordCheck.js')
  const { hasLink } = await import('../src/links.js')
  const own = await localReplies()
  const ref = options.target || focal
  const state = { note: '', busy: false, comments: undefined, rodas: options.rodas || new Map(), open: new Set(), published: [], expanded: [], requests: [], loads: [] }
  const context = {
    quickReplyPlan,
    sendTextReply,
    mergeChildren,
    parseRef,
    refusalOf,
    hasLink,
    topOf: own.topOf,
    refOf,
    focal,
    target: { ref, name: 'Pessoa' },
    toRoot: ref === focal,
    full: options.full !== false,
    actingPageKey: () => options.page ? A : null,
    sendingRef: { current: false },
    sessionRef: { current: 0 },
    ownReplies: { current: new Map() },
    names: {},
    identityOf: () => ({ name: 'Eu' }),
    eng: { counts: new Map(options.counts || []) },
    setCount: (key, value) => context.eng.counts.set(key, value),
    viewRef: { current: { root: focal, comments: options.comments || [], resolved: options.resolved || null, meta: options.meta || null } },
    rodasRef: { current: state.rodas },
    putRodas: (next) => { context.rodasRef.current = next; state.rodas = next },
    loadRoda: (...args) => state.loads.push(args),
    replyDraft: { current: { focal, text: 'resposta' } },
    cacheGeneration: options.cacheGeneration || (() => 0),
    cacheOwnReply: (key, value) => { state.cached = { key, item: value } },
    commit: (patch) => { Object.assign(context.viewRef.current, patch); state.comments = patch.comments },
    setNote: (note) => { state.note = note },
    setSending: (busy) => { state.busy = busy },
    setOpen: (update) => { state.open = update(state.open) },
    errorText: (err) => err ? err.message : 'Erro',
    onPublished: (...args) => state.published.push(args),
    expandReply: async (draft, target) => { state.expanded.push({ ...target, draft }); return options.accepted === true },
    request: async (method, params) => {
      state.requests.push({ method, params })
      if (options.request) return options.request(method, params)
      if (method === 'log.read') return { key: A, entries: [], entriesTruncated: 0 }
      return { ref: A + ':8', seq: 8 }
    }
  }
  const send = handler(src, '  const sendReply = async', '  const scrollToKey =', 'sendReply', context)
  return { send, state, context }
}

test('Conversa send handler: uncertain and plain failures keep text, with one mutation per press', async (t) => {
  for (const uncertain of [false, true]) {
    const { send, state } = await sending({
      request: async (method) => {
        if (method === 'log.read') return { key: A, entries: [], entriesTruncated: 0 }
        throw Object.assign(new Error('Falha de conexão'), { uncertain })
      }
    })
    t.is(await send('minha resposta'), false, 'the bar keeps its text')
    t.is(state.requests.filter((r) => r.method === 'post.reply').length, 1, 'no automatic retry')
    t.is(state.note, uncertain ? 'A resposta pode ter sido enviada. Confira a conversa antes de enviar de novo.' : 'Falha de conexão')
    t.is(state.published.length, 0)
    t.is(state.loads.length, 0)
    t.is(state.busy, false)
  }
})

test('Conversa send handler: refusal, link and page plans never mutate', async (t) => {
  const refused = await sending()
  const { BLOCKED_TERMS } = await import('../src/blockedTerms.js')
  t.is(await refused.send(BLOCKED_TERMS[0]), false)
  t.ok(refused.state.note.includes('não permite'))
  t.is(refused.state.requests.length, 0)
  for (const options of [{ page: true }, {}, { full: false }]) {
    const { send, state } = await sending(options)
    t.is(await send('https://example.org'), false, 'a rejected handoff keeps the text')
    t.alike(state.expanded, [{ ref: focal, name: 'Pessoa', draft: 'https://example.org' }])
    t.is(state.requests.length, 0)
  }
  const page = await sending({ page: true, accepted: true })
  t.is(await page.send('texto sem link'), true)
  t.is(page.state.requests.length, 0)
})

test('Conversa send handler: the gate hands off the draft and waits for acceptance', async (t) => {
  const { GATE_MESSAGE } = await import('../src/outbox.js')
  for (const accepted of [false, true]) {
    const { send, state } = await sending({
      accepted,
      request: async (method) => {
        if (method === 'log.read') return { key: A, entries: [], entriesTruncated: 0 }
        throw new Error(GATE_MESSAGE)
      }
    })
    t.is(await send('rascunho'), accepted)
    t.alike(state.expanded, [{ ref: focal, name: 'Pessoa', draft: 'rascunho' }])
    t.is(state.requests.filter((r) => r.method === 'post.reply').length, 1)
    t.is(state.published.length, 0)
  }
})

test('Conversa send handler: concurrent presses send once and put the own comment first', async (t) => {
  let finish
  const waiting = new Promise((resolve) => { finish = resolve })
  const shown = item(2, 4)
  const { send, state, context } = await sending({
    comments: [shown],
    request: async (method) => method === 'log.read' ? { key: A, entries: [], entriesTruncated: 0 } : waiting
  })
  const first = send('resposta')
  t.is(await send('resposta'), false)
  finish({ ref: A + ':8', seq: 8 })
  t.is(await first, true)
  t.is(state.requests.filter((r) => r.method === 'post.reply').length, 1)
  t.alike(state.requests.find((r) => r.method === 'post.reply').params.to, focal, 'replyTo is the root')
  t.alike(state.published, [['quick-reply', focal]])
  t.alike(state.comments.map((c) => c.seq), [8, 2])
  t.is(state.comments[0].text, 'resposta')
  t.alike(state.comments[0].replyTo, { author: B, seq: 4 })
  t.alike(context.ownReplies.current.get(focal).map((c) => c.seq), [8], 'a slow index cannot erase the local comment')
  t.is(state.cached.key, focal)
  t.is(state.loads.length, 0)
  t.is(state.busy, false)
})

test('Conversa send handler: a deep reply lands once, in the roda of its comment', async (t) => {
  const top = A + ':2'
  const comment = item(2, 4)
  const deep = item(5, 2, C, A)
  const rodas = new Map([[top, { replies: [deep], waiting: [], mode: 'roda', complete: true, total: 1, next: null, loaded: true }]])
  const { send, state, context } = await sending({ target: C + ':5', comments: [comment], rodas })
  t.is(await send('resposta funda'), true)
  t.alike(state.requests.find((r) => r.method === 'post.reply').params.to, C + ':5', 'replyTo is the exact message, not its comment')
  t.is(state.comments, undefined, 'the comment list is untouched')
  t.alike(state.rodas.get(top).replies.map((r) => r.seq), [5, 8])
  t.alike(state.rodas.get(top).replies[1].replyTo, { author: C, seq: 5 })
  t.ok(state.open.has(top), 'that roda opens')
  t.absent(state.open.has(C + ':5'))
  t.is(state.loads.length, 0, 'a loaded roda is not fetched again')
  t.alike([...context.ownReplies.current.keys()], [top], 'own copies are keyed by the comment')
  t.is(state.cached.key, top)
  t.is(context.eng.counts.get(C + ':5').replies, 1, 'the direct count of the answered message')
})

test('Conversa send handler: a reply to a comment with a closed roda opens and loads it', async (t) => {
  const top = A + ':2'
  const { send, state } = await sending({ target: top, comments: [item(2, 4)] })
  t.is(await send('resposta'), true)
  const roda = state.rodas.get(top)
  t.alike(roda.replies.map((r) => r.seq), [8], 'shown at once')
  t.is(roda.loaded, false, 'the toggle still loads it')
  t.ok(state.open.has(top))
  t.alike(state.loads, [[top]])
})

test('Conversa keeps bar drafts across offline remounts and clears accepted handoffs', async (t) => {
  t.ok(src.includes("const replyDraft = useRef({ focal, text: '' })"))
  t.ok(src.includes("if (replyDraft.current.focal !== focal) replyDraft.current = { focal, text: '' }"))
  t.ok(src.includes('draft={replyDraft.current.text}'))
  t.ok(src.includes('onDraftChange={(text) => { if (replyDraft.current.focal === focal) replyDraft.current.text = text }}'))
  const sent = await sending()
  await sent.send('resposta')
  t.is(sent.context.replyDraft.current.text, '')
  for (const accepted of [false, true]) {
    const context = { onReply: async () => accepted, replyTarget: null, rootTarget: { ref: focal }, focal, replyDraft: { current: { focal, text: 'rascunho' } } }
    const expand = handler(src, '  const expandReply =', '  const sendReply =', 'expandReply', context)
    t.is(await expand('rascunho'), accepted)
    t.is(context.replyDraft.current.text, accepted ? '' : 'rascunho')
  }
  const none = handler(src, '  const expandReply =', '  const sendReply =', 'expandReply', { onReply: async () => true, replyTarget: null, rootTarget: null, focal, replyDraft: { current: { focal, text: 'x' } } })
  t.is(await none('x'), false, 'nothing to answer before the root is known')
})

test('an own reply finishing after a cache wipe cannot recreate the cache', async (t) => {
  let generation = 0
  const sent = await sending({
    cacheGeneration: () => generation,
    request: async (method) => {
      if (method === 'log.read') return { key: A, entries: [], entriesTruncated: 0 }
      generation++
      return { ref: A + ':8', seq: 8 }
    }
  })
  t.is(await sent.send('resposta'), true)
  t.absent(sent.state.cached)
})

test('Conversa bar respects the safe area and consumes compose intent once', (t) => {
  t.ok(src.includes("import { useSafeAreaInsets } from 'react-native-safe-area-context'"))
  t.ok(src.includes('const insets = useSafeAreaInsets()'))
  t.ok(src.includes('<View ref={barBox} collapsable={false} style={[style, { paddingBottom: keyboardOpen ? 8 : Math.max(8, insets.bottom) }]}>'), 'the inset is dropped while the keyboard is open')
  t.ok(/<ReplyDock barBox=\{barBox\} style=\{styles.barWrap\}>\s*<ReplyBar/.test(src), 'the bar sits in the dock')
  t.ok(src.includes('barWrap: { backgroundColor: colors.bg, paddingHorizontal: space.md, paddingTop: space.sm }'), 'the page shows around the floating pill')
  t.ok(src.includes('me={me}') && /function ConversaList \(\{[^}]*\bme,/.test(src), 'the bar gets the own profile')
  t.ok(app.includes('me: tabMe,'), 'App passes the tab profile to screens')
  t.ok(src.includes("onAttach={(draft) => expandReply(draft, undefined, 'photo')}"), 'the photo button expands with attach')
  t.ok(src.includes('nonFocalTarget={replyTarget !== null && !toRoot}'), 'a reply to another row is flagged')
  t.ok(src.includes('onReply(attach ? { ...target, draft, attach } : { ...target, draft })'), 'attach rides only when given')
  t.ok(/targetReply\(composeSignal.target\)\s*if \(typeof onComposeSeen === 'function'\) onComposeSeen\(\)/.test(src))
  t.ok(app.includes('onComposeSeen={h.handleComposeSeen}') && app.includes('handleComposeSeen: () => setComposeSignal(null)'))
})

test('Conversa ends the player band at the reply bar', (t) => {
  t.ok(src.includes("import { EmbedBandBottom } from '../ui/screenVisible'"), 'imports the band context')
  t.ok(src.includes('const barBox = useRef(null)'), 'the bar wrapper ref')
  t.ok(src.includes('<View ref={barBox} collapsable={false} style={[style,') && src.includes('<ReplyDock barBox={barBox} style={styles.barWrap}>'), 'the bar wrapper is measured')
  t.ok(src.includes('<EmbedBandBottom.Provider value={full || sending ? band : null}>'), 'the list gets the band while the bar shows')
  const opens = src.indexOf('<EmbedBandBottom.Provider')
  const list = src.indexOf('<RefreshableList')
  const closes = src.indexOf('</EmbedBandBottom.Provider>')
  t.ok(opens !== -1 && opens < list && list < closes, 'the list sits inside the band provider')
  t.ok(src.indexOf('const band = useMemo(') !== -1 && src.indexOf('const band = useMemo(') < src.indexOf('if (!full && !sending) {'), 'the band hook runs before the offline early return')
  const start = src.indexOf('const band = useMemo(')
  const memo = start === -1 ? '' : src.slice(start, src.indexOf('}), [])', start))
  t.ok(memo.includes('const node = barBox.current'), 'band.measure reads the bar wrapper')
  t.ok(memo.includes("if (node === null || typeof node.measureInWindow !== 'function') { done(null); return }"), 'no wrapper answers null')
  t.ok(memo.includes('node.measureInWindow('), 'band.measure measures the bar on every check')
  t.absent(/<View ref=\{barBox\}[^>]*onLayout/.test(src), 'no onLayout on the bar wrapper')
})

test('App quick replies refresh feeds without touching a parked composer', (t) => {
  const composer = { open: false, reply: { ref: focal, draft: 'guardado' }, quote: null }
  const state = { composer, version: 3, peekVersion: 6, toast: '' }
  const published = handler(app, '  const onPublished =', '  const startQuote =', 'onPublished', {
    setComposer: (update) => { state.composer = update(state.composer) },
    setVersion: (update) => { state.version = update(state.version) },
    setPeekVersion: (update) => { state.peekVersion = update(state.peekVersion) },
    showToast: (text) => { state.toast = text },
    share: { requeue: () => {} }
  })
  published('quick-reply', focal)
  t.is(state.composer, composer)
  t.is(state.version, 4)
  t.is(state.peekVersion, 7)
  t.is(state.toast, 'publicado', 'the answered level is unknown here')
  published('reply', focal)
  t.is(state.composer.reply, null, 'Publicar still clears its sent context')
  t.is(state.toast, 'publicado', 'a sent reply of either level gets the neutral toast')
})

test('App outbox toast is neutral for a queued post or reply', (t) => {
  const from = app.indexOf('  const lastSent = outbox.lastSent')
  const effect = app.slice(from, app.indexOf('}, [lastSent])', from))
  t.ok(from > 0 && effect.includes("showToast('publicado')"))
  t.absent(app.includes('resposta publicada'), 'no toast names the answered level')
})

test('Conversa local cache survives a fresh instance and holds at most fifty parents', async (t) => {
  const { cacheOwnReply, ownFor, ownReplyCache } = await localReplies()
  const first = item(8)
  cacheOwnReply(focal, first)
  t.alike(ownFor(focal, new Map()), [first])
  t.alike(ownFor(focal, new Map([[focal, [first]]])), [first], 'cache and instance copies do not duplicate')
  for (let i = 1; i <= 50; i++) cacheOwnReply(A + ':' + i, item(i + 100, i))
  t.is(ownReplyCache.size, 50)
  t.is(ownFor(focal, new Map()).length, 0)
  t.ok(src.includes('ownComments.reduce(withOwnReply, page)'))
  t.ok(src.includes('own: ownFor(top, ownReplies.current),'), 'a roda holds own replies under its comment')
  const sent = await sending()
  await sent.send('resposta')
  t.is(sent.state.cached.key, focal)
  t.is(sent.state.cached.item.seq, 8)
})

test('Conversa own reply cache wipes, caps each parent and retires indexed refs', async (t) => {
  let registered
  const own = await localReplies((entry) => { registered = entry })
  for (let seq = 10; seq < 35; seq++) own.cacheOwnReply(focal, { ...item(seq), at: '2026-01-01' })
  t.alike(own.ownFor(focal, new Map()).map((i) => i.seq), Array.from({ length: 20 }, (_, i) => i + 15))
  const local = new Map([[focal, [item(34), item(35)]]])
  own.pruneOwnReplies([A + ':34'], local)
  t.absent(own.ownFor(focal, local).some((i) => i.seq === 34))
  t.ok(own.ownFor(focal, local).some((i) => i.seq === 35))
  registered.wipe()
  t.is(own.ownReplyCache.size, 0)
  for (const [start, end, line] of [
    ['  const load = useCallback', '  const loadMore =', 'pruneOwnReplies(index.replies, ownReplies.current)'],
    ['  const loadMore =', '  const loadRoda = async', 'pruneOwnReplies(index.replies, ownReplies.current)'],
    ['  const loadRoda = async', '  loadRodaRef.current = loadRoda', 'pruneOwnReplies(page.items, ownReplies.current)']
  ]) {
    const code = src.slice(src.indexOf(start), src.indexOf(end))
    t.ok(code.includes(line), start)
  }
})

test('shared deletion evicts cached replies before success or uncertain recheck', async (t) => {
  for (const result of [{ ok: true }, { uncertain: true }, { ok: false }]) {
    const own = await localReplies()
    const reply = item(8)
    own.cacheOwnReply(focal, reply)
    const local = new Map([[focal, [reply]]])
    let rechecked = false
    let deleted = false
    const context = {
      ...own,
      useAction: () => ({ run: async () => result }),
      useRef: (value) => ({ current: value }),
      useState: (value) => [value === null ? { ref: A + ':8' } : value, () => {}],
      actingPageKey: () => null,
      isPageRef: () => false,
      UNCERTAIN: 'Confira a conversa',
      onUncertain: (target) => own.dropOwnReplies(local, new Set([target.ref]))
    }
    const useDelete = handler(src.replace('export function useDelete', 'function useDelete'), 'function useDelete', 'export function DeletePrompt', 'useDelete', context)
    const del = useDelete({
      request: async () => {},
      onUncertain: context.onUncertain,
      onDeleted: async () => { deleted = true; t.is(own.ownReplyCache.size, 0) },
      recheck: async () => { rechecked = true; t.alike(own.ownFor(focal, local), []) }
    })
    await del.confirm()
    t.is(deleted, result.ok === true)
    t.is(rechecked, result.uncertain === true)
    t.is(own.ownReplyCache.size, result.ok || result.uncertain ? 0 : 1)
  }
  const own = await localReplies()
  const local = new Map([[focal, [item(8)]]])
  const context = { ...own, request: () => {}, node: {}, onToast: () => {}, load: () => {}, useDelete: (opts) => opts, ownReplies: { current: local } }
  const del = handler(src, '  const del = useDelete({', '  const handlers =', 'del', context)
  del.onUncertain({ ref: A + ':8' })
  t.is(local.size, 0, 'the screen drops its own copy before recheck')
})

test('a deletion anywhere drops the reply from every mounted Conversa copy', async (t) => {
  for (const result of [{ ok: true }, { uncertain: true }, { ok: false }]) {
    const own = await localReplies()
    const reply = item(8)
    own.cacheOwnReply(focal, reply)
    // Another Conversa, still mounted under the one that deletes.
    const other = { current: new Map([[focal, [reply]]]) }
    own.ownReplyCopies.add(other)
    const context = {
      ...own,
      useAction: () => ({ run: async () => result }),
      useRef: (value) => ({ current: value }),
      useState: (value) => [value === null ? { ref: A + ':8' } : value, () => {}],
      actingPageKey: () => null,
      isPageRef: () => false,
      UNCERTAIN: 'Confira a conversa'
    }
    const useDelete = handler(src.replace('export function useDelete', 'function useDelete'), 'function useDelete', 'export function DeletePrompt', 'useDelete', context)
    let seen = null
    const del = useDelete({ request: async () => {}, onUncertain: () => {}, onDeleted: async () => { seen = own.ownFor(focal, other.current).map((row) => row.seq) }, recheck: async () => {} })
    await del.confirm()
    if (result.ok) t.alike(seen, [8], 'the deleting screen still finds the parent to lower its count')
    const gone = result.ok || result.uncertain
    t.alike(own.ownFor(focal, other.current).map((row) => row.seq), gone ? [] : [8])
  }
  t.ok(src.includes('ownReplyCopies.add(ownReplies)\n    return () => { ownReplyCopies.delete(ownReplies) }'), 'each screen registers its copy while mounted')
})

test('the refresh reset and the focal reset retire roda pages in flight', (t) => {
  t.is(src.split('branchGen.current += 1').length - 1, 3, 'focal reset, refresh and the anchor recovery')
  t.ok(src.includes('rodaRequests.current.clear()\n        branchGen.current += 1'))
  t.ok(between('  const showAnchor = async', '  useEffect(() => {\n    if (full) load(false)').includes('rodaRequests.current.clear()\n      branchGen.current += 1'))
  t.ok(src.includes('const alive = () => mine === genRef.current && branch === branchGen.current'))
})

test('Conversa roda failures have their own retry and cannot overwrite send warnings', (t) => {
  const roda = between('  const loadRoda = async', '  loadRodaRef.current = loadRoda')
  t.absent(roda.includes('setNote('))
  t.ok(roda.includes('setRodaErrors((previous) => new Map(previous).set(top, { text: errorText(err), cursor }))'))
  t.ok(roda.includes('next.delete(top)'))
  t.ok(src.includes("label='Tentar de novo' onPress={() => loadRoda(key, failure ? failure.cursor : null)}"))
  t.ok(src.includes('displayText(failure ? failure.text : RODA_ERROR)'))
})

test('Conversa: roda controls are slim text links, not filled pills', (t) => {
  const link = readFileSync(join(__dirname, '../src/ui/BranchLink.js'), 'utf8')
  const rowsSrc = between('  renderRef.current = (row) => {', '  const notes = []')
  t.absent(rowsSrc.includes('<Btn'), 'roda controls use no filled buttons')
  t.is(rowsSrc.split('<BranchLink ').length - 1, 3, 'toggle, retry and more use links')
  t.is(rowsSrc.split('expanded={').length - 1, 1, 'only the toggle has expanded state')
  t.ok(rowsSrc.includes('<BranchLink label={row.label} expanded={row.open} onPress={() => toggleRoda(row)}'), 'the label comes from commentRows (rodaLabel)')
  t.ok(rowsSrc.includes("label='Tentar de novo'"))
  t.ok(rowsSrc.includes("label='Ver mais respostas' onPress={() => loadRoda(key, rodas.has(key) && rodas.get(key).loaded ? rodas.get(key).next : null)}"), 'a roda whose first load never landed starts again from its first page')
  t.ok(rowsSrc.includes("[styles.child, styles.branchAction, row.kind === 'error' && styles.branchError]"), 'more rows continue the roda line')
  t.ok(src.includes("import { BranchLink } from '../ui/BranchLink'"))
  t.ok(src.includes("branchAction: { paddingLeft: 68, paddingRight: space.lg, alignItems: 'flex-start' }"))
  t.ok(src.includes('branchError: { paddingTop: space.sm }'))
  t.ok(src.includes("<Btn label='Apagar' danger"), 'delete keeps its button')
  t.ok(link.includes("accessibilityRole='button'"))
  t.ok(link.includes('accessibilityState={{ disabled: off, expanded }}'))
  t.ok(link.includes('aria-expanded={expanded}'))
  t.ok(link.includes("const shown = pending ? label + '…' : label"))
  t.ok(link.includes('accessibilityLabel={shown}'), 'accessible name matches visible text')
  t.ok(link.includes("typeof expanded === 'boolean'"))
  t.ok(link.includes("name='escolher'"))
  t.ok(link.includes('text: { ...type.more, color: colors.accent'))
  t.ok(link.includes('opacity: 0.45'))
  t.ok(link.includes('opacity: 0.6'))
  t.ok(link.includes("rotate: '180deg'"))
  t.ok(link.includes('(colors) => StyleSheet.create'))
  const hit = link.match(/hit: \{([^}]*)\}/)
  t.ok(hit !== null, 'hit style is present')
  t.ok(hit[1].includes('minHeight: layout.hit'))
  t.ok(hit[1].includes('minWidth: layout.hit'))
  t.absent(/backgroundColor|borderWidth|padding|margin/.test(hit[1]), 'hit box has no visible container or extra spacing')
  t.absent(/outlineStyle|outlineWidth|webInputReset|backgroundColor|borderWidth|Platform/.test(link), 'focus ring and shared platform behavior stay intact')
  t.absent(/\bhitSlop\s*=/.test(link), 'no hitSlop prop; the comment may name it')
  t.absent(link.includes('\u2014'))
})

test('Conversa reply quotes keep one object per row while unchanged', (t) => {
  const quotes = { current: new Map() }
  const jumps = []
  const quoteOf = handler(src, '  const quoteOf =', '  renderRef.current = (row) =>', 'quoteOf', {
    quotes,
    scrollRef: { current: (key) => jumps.push(key) },
    names: {},
    identityOf: (_names, _key, q) => ({ name: q.name }),
    whoOf: (who) => ({ title: who.name || 'Alguém' }),
    MISSING_QUOTE: 'Mensagem indisponível'
  })
  const row = { key: 'r1', quote: { ref: B + ':5', author: B, name: 'Bia', text: 'oi' } }
  const plain = ({ onPress, ...rest }) => rest
  const first = quoteOf(row)
  t.alike(plain(first), { name: 'Bia', text: 'oi', senderKey: B, ref: B + ':5' })
  t.is(quoteOf({ ...row, quote: { ...row.quote } }), first, 'same content, same object for the memoized row')
  first.onPress()
  t.alike(jumps, ['reply:' + B + ':5'], 'the tap jumps to the answered reply row')
  const changed = quoteOf({ ...row, quote: { ...row.quote, text: 'editado' } })
  t.not(changed, first)
  t.is(changed.text, 'editado')
  const missing = quoteOf({ key: 'r2', quote: { ref: B + ':6', missing: true } })
  t.alike(plain(missing), { name: null, text: 'Mensagem indisponível', senderKey: undefined, ref: B + ':6' })
  missing.onPress()
  t.is(jumps[1], 'reply:' + B + ':6', 'a quote not loaded still asks, and the helper announces the miss')
  t.is(quoteOf({ key: 'r3', quote: null }), undefined, 'a reply to the comment itself has no quote')
})

const D = 'd'.repeat(64)
const R = A + ':1'

function world (posts) {
  const peeks = new Map()
  for (const [ref, parent] of posts) {
    const [author, seqText] = ref.split(':')
    if (!peeks.has(author)) peeks.set(author, { key: author, entries: [] })
    const seq = Number(seqText)
    const replyTo = parent === null ? null : { author: parent.split(':')[0], seq: Number(parent.split(':')[1]) }
    peeks.get(author).entries.push({ seq, record: { type: 'post', at: '2026-01-01T00:00:0' + (seq % 10) + '.000Z', text: 'texto ' + seq, replyTo } })
  }
  return peeks
}

// Answers only the asked seqs, as diary.peek does.
function fakePeekAll (peeks, calls = []) {
  return async (_request, plan, peeked, alive = () => true) => {
    for (const chunk of plan) {
      if (!alive()) return peeked
      calls.push(chunk)
      const source = peeks.get(chunk.author)
      if (!source) continue
      const held = peeked.get(chunk.author) || { key: chunk.author, entries: [] }
      const have = new Set(held.entries.map((e) => e.seq))
      peeked.set(chunk.author, { ...held, entries: held.entries.concat(source.entries.filter((e) => chunk.seqs.includes(e.seq) && !have.has(e.seq))) })
    }
    return peeked
  }
}

const postIndex = (ref, { parent = null, replies = [], next = null } = {}) => ({ ref, parent, replies, next, repliesTotal: replies.length, authors: {}, indexing: false, complete: true, likes: 0, reposts: 0, quotesTotal: 0 })
// `to` points at the root on purpose: the screen must never use it.
const rodaPage = (key, top, items, next = null) => ({ ok: true, value: { ref: key, root: R, top, items: items.map((ref) => ({ ref, to: R })), next, total: items.length, authors: {}, indexing: false, complete: true } })
const refsIn = (items) => items.map((i) => i.author + ':' + i.seq)

async function loading (options) {
  const thread = await import('../src/thread.js')
  const { withOwnReply } = await import('../src/threadRows.js')
  const { commentOrder, withAnchor } = await import('../src/roda.js')
  const { resolveRoot } = await import('../src/rodaLoad.js')
  const own = await localReplies()
  const postAt = handler(src.replace('export function postAt', 'function postAt'), 'function postAt', '// Names learned from the peeks', 'postAt', { parseRef: thread.parseRef, assembleMember: thread.assembleMember, postsByPeek: new WeakMap() })
  const anchorOfFn = await anchorOfLoaded()
  const state = { resolves: 0, opened: [], rodaResets: 0, fetchPost: [], fetchRoda: [], peeks: [], resets: 0, undos: 0 }
  const context = {
    ownFor: own.ownFor,
    pruneOwnReplies: own.pruneOwnReplies,
    refsOf: own.refsOf,
    appendComments: own.appendComments,
    useCallback: (fn) => fn,
    genRef: { current: 0 },
    INITIAL: { phase: 'loading', error: '', meta: null, resolved: null, root: null, status: null, cut: false, post: null, comments: [], unavailable: 0, next: null, loadingMore: false, moreError: '', refreshing: false },
    viewRef: { current: {} },
    commit: (patch) => { context.viewRef.current = { ...context.viewRef.current, ...patch } },
    peekAll: fakePeekAll(world(options.posts), state.peeks),
    planPeeks: thread.planPeeks,
    postAt,
    request: async () => {},
    resolvedRef: { current: null },
    anchorRef: { current: null },
    anchorOf: anchorOfFn,
    focusRef: options.focusRef || null,
    focal: options.key,
    resolveRoot: (...args) => { state.resolves++; return resolveRoot(...args) },
    fetchPost: async (ref, cursor = null) => {
      state.fetchPost.push([ref, cursor])
      const failure = options.failPost ? options.failPost(ref, cursor) : false
      if (failure === 'throw') throw new Error('falhou')
      if (failure) return { ok: false, reason: 'network' }
      const index = options.indexes[ref + '|' + cursor]
      return index ? { ok: true, value: index } : { ok: false, reason: 'not-found' }
    },
    fetchRoda: async (ref, cursor = null) => {
      state.fetchRoda.push([ref, cursor])
      return (options.rodas || {})[ref] || { ok: false, reason: 'not-found' }
    },
    sleep: async () => {},
    SEEDER_RETRY_MS: 0,
    focusTop: options.focusTop || null,
    reset: () => { state.resets++; return () => { state.undos++ } },
    readOwn: async () => { if (options.readOwnFails && options.readOwnFails()) throw new Error('falhou') },
    loadFollows: async () => new Set(),
    followsRef: { current: Promise.resolve(new Set()) },
    assembleThread: thread.assembleThread,
    refOf,
    quotePlan: async () => [],
    ownReplies: { current: new Map() },
    knownAuthors: () => [],
    ownKey: D,
    peekedRef: { current: new Map() },
    learnPeeked: () => {},
    learnMany: () => {},
    resolveMany: () => {},
    setCount: () => {},
    putRodas: () => { state.rodaResets++ },
    setRodaErrors: () => {},
    rodaRequests: { current: new Map() },
    branchGen: { current: 0 },
    setRodaBusy: () => {},
    withAnchor,
    commentOrder,
    withOwnReply,
    rodaSeed: { current: null },
    openRef: { current: new Set() },
    loadRodaRef: { current: (key) => state.opened.push(key) },
    readCounts: () => {},
    isSeederDown: () => false,
    errorText: (err) => err.message
  }
  const load = handler(src, '  const load = useCallback(async (refreshing', '  const loadMore =', 'load', context)
  const loadMore = handler(src, '  const loadMore =', '  // One page of the roda', 'loadMore', context)
  return { load, loadMore, state, context }
}

const deepThread = () => ({
  key: C + ':6',
  posts: [[R, null], [B + ':2', R], [C + ':3', R], [B + ':5', B + ':2'], [C + ':6', B + ':5'], [B + ':8', R]],
  indexes: {
    [C + ':6|null']: postIndex(C + ':6', { parent: B + ':5' }),
    [R + '|null']: postIndex(R, { replies: [C + ':3'], next: 'p2' }),
    [R + '|p2']: postIndex(R, { replies: [B + ':2', B + ':8'] })
  },
  rodas: { [C + ':6']: rodaPage(C + ':6', B + ':2', [B + ':5', C + ':6']) }
})

test('Conversa load: a deep key opens its root, anchor comment first even off the first page', async (t) => {
  const { load, loadMore, state, context } = await loading(deepThread())
  await load(false)
  const view = context.viewRef.current
  t.is(view.phase, 'ready')
  t.is(view.root, R, 'the root is the only main post')
  t.is(view.post.seq, 1)
  t.is(view.status, 'ok')
  t.is(view.resolved.top, B + ':2', 'the whole resolution is kept for the next task')
  t.is(typeof view.resolved.proven, 'boolean')
  t.alike(refsIn(view.comments), [B + ':2', C + ':3'], 'the anchor comment is read, checked and placed first')
  t.ok(state.peeks.some((chunk) => chunk.author === B && chunk.seqs.includes(2)))
  t.is(context.rodaSeed.current.top, B + ':2', 'the roda page resolveRoot fetched is kept for the comment')
  t.alike(context.anchorRef.current, { top: B + ':2', target: C + ':6', proven: false }, 'the seeder pairing alone is not proof')
  t.is(view.next, 'p2')
  await loadMore()
  t.alike(refsIn(context.viewRef.current.comments), [B + ':2', C + ':3', B + ':8'], 'no duplicate when the anchor page arrives')
  t.is(context.viewRef.current.next, null)
})

test('Conversa load: the root key reuses its index and an anchor with another parent is rejected', async (t) => {
  for (const [focusTop, expected] of [[B + ':2', [B + ':2', C + ':3']], [B + ':5', [C + ':3']], [null, [C + ':3']]]) {
    const thread = deepThread()
    const { load, state, context } = await loading({ ...thread, key: R, focusTop })
    await load(false)
    t.alike(refsIn(context.viewRef.current.comments), expected, String(focusTop))
    t.alike(state.fetchPost, [[R, null]], 'the index resolveRoot fetched is reused')
    t.is(state.fetchRoda.length, 0)
    t.is(context.rodaSeed.current, null)
  }
})

test('Conversa load: an unreadable key is not available', async (t) => {
  const { load, context } = await loading({ ...deepThread(), key: B + ':99' })
  await load(false)
  t.is(context.viewRef.current.phase, 'error')
  t.is(context.viewRef.current.error, 'Esta conversa não está disponível.')
})

test('Conversa load: an orphan keeps its top-most message and its replies', async (t) => {
  const { load, context } = await loading({
    key: C + ':6',
    posts: [[R, null], [B + ':2', R], [C + ':6', B + ':5'], [D + ':9', C + ':6']],
    indexes: { [C + ':6|null']: postIndex(C + ':6', { parent: B + ':5', replies: [D + ':9'] }) }
  })
  await load(false)
  const view = context.viewRef.current
  t.is(view.phase, 'ready')
  t.is(view.status, 'orphan')
  t.is(view.cut, false)
  t.is(view.root, C + ':6')
  t.is(view.post.seq, 6)
  t.alike(refsIn(view.comments), [D + ':9'])
  t.is(view.unavailable, 0, 'the missing parent is the note, not an unavailable comment')
})

test('Conversa load: an own deep reply cached under a comment that became an orphan root stays out of the comments', async (t) => {
  const { load, context } = await loading({
    key: C + ':6',
    posts: [[R, null], [B + ':2', R], [C + ':6', B + ':5'], [D + ':9', C + ':6']],
    indexes: { [C + ':6|null']: postIndex(C + ':6', { parent: B + ':5', replies: [D + ':9'] }) }
  })
  context.ownReplies.current = new Map([[C + ':6', [item(12, 9, D, D), item(13, 6, D, C)]]])
  await load(false)
  const view = context.viewRef.current
  t.is(view.status, 'orphan')
  t.ok(refsIn(view.comments).includes(D + ':13'), 'an own reply to the root is a comment')
  t.absent(refsIn(view.comments).includes(D + ':12'), 'an own reply to a reply is not')
})

test('Conversa refresh reuses the resolution, drops the rodas and reloads the open ones', async (t) => {
  const { load, state, context } = await loading(deepThread())
  await load(false)
  t.ok(context.rodaSeed.current, 'the first load kept the seed page')
  context.openRef.current = new Set([B + ':2'])
  const gen = context.branchGen.current
  // As showAnchor leaves a confirmed root.
  const held = context.resolvedRef.current
  context.resolvedRef.current = { ...held, res: { ...held.res, proven: true } }
  context.viewRef.current = { ...context.viewRef.current, proven: true }
  context.anchorRef.current = null
  await load(true)
  t.is(context.anchorRef.current, null, 'a refresh of a confirmed root never jumps again')
  t.is(context.viewRef.current.proven, true)
  t.is(state.resolves, 1, 'no second climb')
  t.is(state.rodaResets, 1)
  t.is(context.branchGen.current, gen + 1)
  t.alike(state.opened, [B + ':2'])
  t.is(context.rodaSeed.current, null, 'an old seed page never comes back')
  t.is(context.viewRef.current.refreshing, false)
})

test('Conversa refresh: an unconfirmed root runs its check again', async (t) => {
  const { load, state, context } = await loading(deepThread())
  await load(false)
  t.is(context.viewRef.current.proven, false, 'the seeder pairing alone is not proof')
  context.anchorRef.current = null
  await load(true)
  t.alike(context.anchorRef.current, { top: B + ':2', target: C + ':6', proven: false }, 'a held unproven result is checked again')
  t.is(state.resolves, 1, 'from the held result, no second resolve')
  t.is(context.viewRef.current.proven, false)
})

test('Conversa refresh failure keeps the rodas and releases the flags', async (t) => {
  for (const mode of ['network', 'throws']) {
    let failing = false
    const { load, state, context } = await loading({ ...deepThread(), failPost: (ref) => failing && ref === R && (mode === 'throws' ? 'throw' : true) })
    await load(false)
    failing = true
    context.viewRef.current = { ...context.viewRef.current, loadingMore: true }
    const gen = context.branchGen.current
    await load(true)
    const view = context.viewRef.current
    t.is(view.phase, 'ready', mode)
    t.is(view.error, 'Não foi possível atualizar a conversa.')
    t.is(view.refreshing, false)
    t.is(view.loadingMore, false)
    t.is(state.rodaResets, 0)
    t.is(context.branchGen.current, gen)
    t.alike(state.opened, [])
    t.alike(refsIn(view.comments), [B + ':2', C + ':3'])
  }
  const first = await loading({ ...deepThread(), key: R, failPost: () => 'throw' })
  await first.load(false)
  t.is(first.context.viewRef.current.phase, 'error', 'a first load that fails is an error, not a stale ready')
  t.is(first.context.viewRef.current.error, 'Não foi possível abrir a conversa.')
})

const rodaPosts = [[R, null], [B + ':2', R], [C + ':3', R], [B + ':5', B + ':2'], [C + ':6', B + ':5'], [C + ':7', A + ':3'], [C + ':12', C + ':6'], [B + ':13', B + ':2']]

async function rodaLoading (options = {}) {
  const thread = await import('../src/thread.js')
  const roda = await import('../src/roda.js')
  const own = await localReplies()
  const state = { rodas: options.rodas || new Map(), busy: new Set(), errors: new Map(), fetchRoda: [], fetchPost: [], inputs: [], counted: [], resolved: [] }
  const context = {
    full: true,
    genRef: { current: 1 },
    branchGen: { current: 0 },
    rodaRequests: { current: new Map() },
    setRodaBusy: (update) => { state.busy = update(state.busy) },
    setRodaErrors: (update) => { state.errors = update(state.errors) },
    rodasRef: { current: state.rodas },
    putRodas: (next) => { context.rodasRef.current = next; state.rodas = next },
    rodaSeed: { current: options.seed || null },
    fetchRoda: (ref, cursor) => { state.fetchRoda.push([ref, cursor]); return options.fetchRoda(ref, cursor, context) },
    fetchPost: (ref, cursor) => { state.fetchPost.push([ref, cursor]); return options.fetchPost(ref, cursor, context) },
    RODA_ERROR: 'Não foi possível carregar as respostas.',
    readOwn: async () => {},
    peekedRef: { current: new Map() },
    peekAll: fakePeekAll(world(rodaPosts)),
    request: async () => {},
    planPeeks: thread.planPeeks,
    assembleRoda: (input) => { state.inputs.push(input); return roda.assembleRoda(input) },
    ownFor: own.ownFor,
    ownReplies: { current: options.own || new Map() },
    followsRef: { current: Promise.resolve(new Set()) },
    quotePlan: async () => [],
    knownAuthors: () => [],
    ownKey: D,
    learnPeeked: () => {},
    learnMany: () => {},
    resolveMany: (keys) => state.resolved.push(keys),
    pruneOwnReplies: own.pruneOwnReplies,
    refsOf: own.refsOf,
    refOf,
    readCounts: (refs) => state.counted.push(refs),
    errorText: (err) => err.message
  }
  const load = handler(src, '  const loadRoda = async', '  loadRodaRef.current = loadRoda', 'loadRoda', context)
  return { load, state, context }
}

const TOP = B + ':2'
const RODA_ERROR = 'Não foi possível carregar as respostas.'

test('Conversa roda: only rows whose signed chain reaches the comment show, and pages merge', async (t) => {
  const mine = item(20, 5, D, B)
  const { load, state } = await rodaLoading({
    own: new Map([[TOP, [mine]]]),
    fetchRoda: async (ref, cursor) => cursor === null ? rodaPage(ref, ref, [B + ':5', C + ':6', C + ':7'], 'c2') : rodaPage(ref, ref, [C + ':12'])
  })
  await load(TOP)
  let roda = state.rodas.get(TOP)
  t.alike(refsIn(roda.replies).sort(), [B + ':5', C + ':6', D + ':20'].sort(), 'another thread\'s reply is excluded; the own reply joins')
  t.is(roda.mode, 'roda')
  t.is(roda.loaded, true)
  t.is(roda.next, 'c2')
  t.is(state.inputs[0].last, false)
  t.alike(state.inputs[0].index, { items: [B + ':5', C + ':6', C + ':7'] }, 'only refs reach the gate, never `to`')
  await load(TOP, 'c2')
  roda = state.rodas.get(TOP)
  t.ok(refsIn(roda.replies).includes(C + ':12'))
  t.absent(refsIn(roda.replies).includes(C + ':7'))
  t.is(roda.next, null)
  t.is(state.inputs[1].last, true, 'the last page folds leftovers into unavailable')
  t.is(state.inputs[1].held.length, 3)
  t.alike(state.counted[1], [C + ':12'], 'a later page asks counts only for its new rows')
  t.alike(state.resolved[1], [C], 'and names only for them')
  t.alike(state.fetchRoda, [[TOP, null], [TOP, 'c2']])
  t.is(state.busy.size, 0)
  t.is(state.errors.size, 0)
})

test('Conversa roda: a stale load cannot commit', async (t) => {
  const { load, state } = await rodaLoading({
    fetchRoda: async (ref, cursor, context) => { context.genRef.current++; return rodaPage(ref, ref, [B + ':5']) }
  })
  await load(TOP)
  t.is(state.rodas.size, 0)
  t.is(state.busy.size, 0)
  t.is(state.errors.size, 0)
})

test('Conversa roda: an older seeder gives direct replies only, paged by the post index', async (t) => {
  for (const answer of [{ ok: false, reason: 'not-found' }, rodaPage(TOP, C + ':3', [C + ':12'])]) {
    const { load, state } = await rodaLoading({
      fetchRoda: async () => answer,
      fetchPost: async (ref, cursor) => ({ ok: true, value: postIndex(ref, cursor === null ? { parent: R, replies: [B + ':5'], next: 'd2' } : { parent: R, replies: [B + ':13'] }) })
    })
    await load(TOP)
    let roda = state.rodas.get(TOP)
    t.is(roda.mode, 'direct', answer.ok ? 'another top' : 'not-found')
    t.alike(refsIn(roda.replies), [B + ':5'])
    t.is(roda.next, 'd2')
    await load(TOP, 'd2')
    roda = state.rodas.get(TOP)
    t.alike(refsIn(roda.replies).sort(), [B + ':13', B + ':5'])
    t.alike(state.fetchRoda, [[TOP, null]], 'no roda request once direct')
    t.alike(state.fetchPost, [[TOP, null], [TOP, 'd2']], 'no walk below the direct replies')
  }
})

test('Conversa roda: a failed page keeps its cursor for the retry', async (t) => {
  for (const reason of ['network', 'not-found']) {
    let fail = true
    const first = { replies: [], waiting: [], mode: 'roda', complete: true, total: 1, next: 'c2', loaded: true }
    const { load, state } = await rodaLoading({
      rodas: new Map([[TOP, first]]),
      fetchRoda: async (ref, cursor) => fail ? { ok: false, reason } : rodaPage(ref, ref, [B + ':5']),
      fetchPost: async () => { throw new Error('no fallback after the first page') }
    })
    await load(TOP, 'c2')
    t.alike(state.errors.get(TOP), { text: RODA_ERROR, cursor: 'c2' }, reason)
    t.is(state.rodas.get(TOP), first, 'the shown roda stays')
    t.is(state.fetchPost.length, 0)
    t.is(state.busy.size, 0)
    fail = false
    await load(TOP, state.errors.get(TOP).cursor)
    t.alike(state.fetchRoda, [[TOP, 'c2'], [TOP, 'c2']])
    t.is(state.errors.size, 0)
    t.alike(refsIn(state.rodas.get(TOP).replies), [B + ':5'])
  }
})

test('Conversa roda: the page resolveRoot fetched seeds the first load once', async (t) => {
  const seed = { top: TOP, page: rodaPage(C + ':6', TOP, [B + ':5', C + ':6']).value }
  const { load, state, context } = await rodaLoading({ seed, fetchRoda: async (ref) => rodaPage(ref, ref, []) })
  await load(C + ':3')
  t.alike(state.fetchRoda, [[C + ':3', null]], 'another comment does not take the seed')
  await load(TOP)
  t.is(state.fetchRoda.length, 1)
  t.is(context.rodaSeed.current, null)
  t.alike(refsIn(state.rodas.get(TOP).replies).sort(), [B + ':5', C + ':6'])
})

test('a roda page in flight across a refresh cannot land in or release the restarted roda', async (t) => {
  const gates = []
  const pages = { c2: [C + ':12'], null: [B + ':5'] }
  const { load, state, context } = await rodaLoading({
    fetchRoda: (ref, cursor) => new Promise((resolve) => gates.push(() => resolve(rodaPage(ref, ref, pages[cursor], cursor === null ? 'c2' : 'c3'))))
  })
  const older = load(TOP, 'c2')
  context.rodaRequests.current.clear()
  context.branchGen.current += 1
  context.putRodas(new Map())
  state.busy = new Set()
  const restarted = load(TOP)
  t.is(gates.length, 2, 'the restarted roda is not mistaken for the request in flight')
  gates[1]()
  await restarted
  gates[0]()
  await older
  t.alike(refsIn(state.rodas.get(TOP).replies), [B + ':5'])
  t.is(state.rodas.get(TOP).next, 'c2', 'the next page is not skipped')
  const again = load(TOP, 'c2')
  t.is(gates.length, 3, 'the older page did not leave the roda marked as loading')
  gates[2]()
  await again
})

const rodaOf = (replies, total) => ({ replies, waiting: [], mode: 'roda', complete: true, total, next: null, loaded: true })

async function deleting (options) {
  const roda = await import('../src/roda.js')
  const own = await localReplies()
  const state = { rodas: options.rodas, open: options.open || new Set(), back: 0, commits: 0 }
  const comments = options.comments || []
  const context = {
    ...own,
    useDelete: (opts) => opts,
    request: () => {},
    node: {},
    onToast: () => {},
    load: () => {},
    genRef: { current: 1 },
    onDeletedPost: options.onDeletedPost || (() => {}),
    revokeDeletedMedia: () => {},
    onBack: () => { state.back++ },
    focal: options.focal || R,
    viewRef: { current: { root: R, comments, meta: { indexing: false, complete: true } } },
    peekedRef: { current: options.peeked || new Map() },
    rodasRef: { current: state.rodas },
    putRodas: (next) => { context.rodasRef.current = next; state.rodas = next },
    setOpen: (update) => { state.open = update(state.open) },
    eng: { counts: new Map(options.counts || []) },
    setCount: (key, value) => context.eng.counts.set(key, value),
    assembleRoda: roda.assembleRoda,
    ownReplies: { current: new Map() },
    commit: (patch) => { state.commits++; context.viewRef.current = { ...context.viewRef.current, ...patch } },
    refOf,
    useRef: (value) => ({ current: value }),
    useEffect: (fn) => fn(),
    deletionListeners: new Set(),
    focalRef: { current: options.focal || R }
  }
  const del = handler(src, '  const dropDeleted = useRef(null)', '  const handlers =', 'del', context)
  return { del, state, context, own, listener: [...context.deletionListeners][0] }
}

test('Conversa delete drops the reply and its descendants from the roda, as the server does', async (t) => {
  const comment = item(2, 1, B, A)
  const r5 = item(5, 2, B, B)
  const r6 = item(6, 5, C, B)
  const r7 = item(7, 2, C, B)
  const { del, state, context, own } = await deleting({
    comments: [comment],
    rodas: new Map([[TOP, rodaOf([r5, r6, r7], 3)]]),
    open: new Set([TOP]),
    counts: [[TOP, { replies: 2, likes: 1 }]]
  })
  own.cacheOwnReply(TOP, r5)
  await del.onDeleted({ ref: B + ':5', seq: 5 })
  t.alike(refsIn(state.rodas.get(TOP).replies), [C + ':7'])
  t.is(state.rodas.get(TOP).total, 1)
  t.alike(context.eng.counts.get(TOP), { replies: 1, likes: 1 }, 'the direct count of the parent, once')
  t.ok(state.open.has(TOP))
  t.is(own.ownFor(TOP, context.ownReplies.current).length, 0)
  t.alike(refsIn(context.viewRef.current.comments), [TOP])
})

test('Conversa delete closes an emptied roda and a deleted comment takes its roda', async (t) => {
  const r5 = item(5, 2, B, B)
  const emptied = await deleting({ comments: [item(2, 1, B, A)], rodas: new Map([[TOP, rodaOf([r5], 1)]]), open: new Set([TOP]), counts: [[TOP, { replies: 1 }]] })
  await emptied.del.onDeleted({ ref: B + ':5', seq: 5 })
  t.is(emptied.state.rodas.get(TOP).replies.length, 0)
  t.absent(emptied.state.open.has(TOP))
  const comment = await deleting({ comments: [item(2, 1, B, A), item(3, 1, C, A)], rodas: new Map([[TOP, rodaOf([r5], 1)]]), counts: [[R, { replies: 2 }]] })
  await comment.del.onDeleted({ ref: TOP, seq: 2 })
  t.absent(comment.state.rodas.has(TOP))
  t.alike(refsIn(comment.context.viewRef.current.comments), [C + ':3'])
  t.is(comment.context.eng.counts.get(R).replies, 1)
  const root = await deleting({ comments: [item(2, 1, B, A)], rodas: new Map() })
  await root.del.onDeleted({ ref: R, seq: 1 })
  t.is(root.state.back, 1, 'deleting the root leaves the screen')
})

test('a refresh that fails after the clear gives the counts and own likes back', async (t) => {
  let failing = false
  const failed = await loading({ ...deepThread(), readOwnFails: () => failing })
  await failed.load(false)
  failing = true
  await failed.load(true)
  t.is(failed.state.resets, 1)
  t.is(failed.state.undos, 1, 'the cleared engagement is restored')
  t.is(failed.context.viewRef.current.phase, 'ready')
  t.is(failed.context.viewRef.current.error, 'Não foi possível atualizar a conversa.')
  const ok = await loading(deepThread())
  await ok.load(false)
  await ok.load(true)
  t.is(ok.state.resets, 1)
  t.is(ok.state.undos, 0, 'a refresh that lands keeps the new engagement')
  let superseded = false
  const stale = await loading({ ...deepThread(), readOwnFails: () => { if (!superseded) return false; stale.context.genRef.current++; return true } })
  await stale.load(false)
  superseded = true
  await stale.load(true)
  t.is(stale.state.undos, 0, 'a load superseded meanwhile leaves the engagement to the newer one')

  const stateRef = { current: { liked: new Set(['a:1', 'a:2']), reposted: new Set(['a:1']) } }
  const countsRef = { current: new Map([['a:1', { likes: 3 }], ['a:2', { likes: 1 }]]) }
  const touchedRef = { current: new Map() }
  const counts = { current: countsRef.current }
  const { emptyState } = await import('../src/engagement.js')
  let current = stateRef.current
  const reset = handler(src, '  const reset = useCallback(() => {', '  // engagement.read for', 'reset', {
    useCallback: (fn) => fn,
    stateRef,
    countsRef,
    clockRef: { current: 0 },
    touchedRef,
    pendingRef: { current: new Map() },
    emptyState,
    setState: (update) => { current = typeof update === 'function' ? update(current) : update },
    setCounts: (update) => { counts.current = typeof update === 'function' ? update(counts.current) : update }
  })
  const undo = reset()
  t.is(current.liked.size, 0)
  t.is(counts.current.size, 0)
  // Read after the clear, and a like toggled after it.
  counts.current = new Map([['a:1', { likes: 9 }]])
  touchedRef.current.set('liked|a:2', 99)
  undo()
  t.alike([...current.liked], ['a:1'], 'a field touched since the clear is not brought back')
  t.alike([...current.reposted], ['a:1'])
  t.alike(counts.current.get('a:1'), { likes: 9 }, 'a fresher count wins')
  t.alike(counts.current.get('a:2'), { likes: 1 }, 'the old count of a row still on screen returns')
})

test('Conversa decides Apagar with the postActions rule and carries no copy', async (t) => {
  t.absent(/from '\.\.\/deletion'/.test(src) && /import \{[^}]*\bcanDelete\b[^}]*\} from '\.\.\/deletion'/.test(src), 'no canDelete import')
  t.absent(/(^|[^\w.])canDelete\(/m.test(src), 'no call to the deletion rule')
  t.ok(src.includes("import { canDeletePost } from '../postActions'"))
  const { canDeletePost } = await import('../src/postActions.js')
  let page = null
  const here = handler(src.replace('export function canDeleteHere', 'function canDeleteHere'), 'function canDeleteHere', 'export function refOf', 'canDeleteHere', { canDeletePost, actingPageKey: () => page })
  const mine = { kind: 'post', author: A, seq: 3 }
  t.is(here(mine, A), true)
  t.is(here(mine, B), false)
  t.is(here({ ...mine, author: A.toUpperCase() }, A), true, 'the rule lowercases the author')
  t.is(here({ ...mine, seq: 0 }, A), false)
  t.is(here({ ...mine, repostedBy: B }, A), false, 'a repost row never offers Apagar')
  page = B
  t.is(here({ kind: 'post', author: B, seq: 2 }, A), true, 'the page acted as owns its posts')
})

test('Conversa: thread rows offer the quotes list on the same gate as likes and reposts', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Conversa.js'), 'utf8')
  t.ok(/onOpenQuotes: eng && hasSeq && has\('onOpenQuotes'\) \? \(\) => live\.handlers\.onOpenQuotes\(\{ ref \}\)/.test(src), 'row prop gated on engagement and a seq')
  t.ok(/const handlers = \{[^}]*onOpenQuotes/.test(src), 'the screen hands its handler to the rows')
  t.ok(/function ConversaList \(\{[^}]*onOpenQuotes/.test(src), 'the screen receives it from App')
})

test('the undo of a failed refresh never brings back a like a read since the clear cleared', async (t) => {
  const src = readFileSync(join(__dirname, '..', 'src', 'screens', 'Conversa.js'), 'utf8')
  const { emptyState, fromRead } = await import('../src/engagement.js')
  let current = { liked: new Set(['a:1', 'a:2']), reposted: new Set() }
  const clockRef = { current: 0 }
  const touchedRef = { current: new Map() }
  const context = {
    useCallback: (fn) => fn,
    stateRef: { get current () { return current } },
    countsRef: { current: new Map() },
    clockRef,
    touchedRef,
    touch: (field, ref) => touchedRef.current.set(field + '|' + ref, ++clockRef.current),
    pendingRef: { current: new Map() },
    readRefs: { current: new Set() },
    sourceRef: { current: null },
    request: null,
    emptyState,
    fromRead,
    chunks: (list, size) => [list.slice(0, size)],
    ENGAGEMENT_MAX: 62,
    actingPageKey: () => null,
    readEngagement: async () => ({ liked: ['a:2'], reposted: [] }),
    setState: (update) => { current = typeof update === 'function' ? update(current) : update },
    setCounts: () => {}
  }
  const reset = handler(src, '  const reset = useCallback(() => {', '  // engagement.read for', 'reset', context)
  const readOwn = handler(src, '  const readOwn = useCallback(async', '  // Index counts for', 'readOwn', context)
  const undo = reset()
  await readOwn(['a:1'])
  undo()
  t.absent(current.liked.has('a:1'), 'a like removed elsewhere and read since stays off')
  t.ok(current.liked.has('a:2'), 'a ref not read since comes back')
})

test('Conversa: a deletion made on another screen reaches the Conversas still open below it', (t) => {
  t.ok(src.includes('const deletionListeners = new Set()'))
  t.ok(src.includes('function announceDeleted (refs) {\n  for (const listener of deletionListeners) listener(refs)\n}'))
  t.ok(src.includes('announceDeleted(refs)\n        forgetOwnReplies(refs)'), 'the Conversas below still find the reply in their own copy')
  t.ok(src.includes('deletionListeners.add(listener)') && src.includes('deletionListeners.delete(listener)'), 'a Conversa listens while mounted')
  t.ok(src.includes('if (ref !== (viewRef.current.root || focalRef.current)) dropDeleted.current(ref)'), 'the main post of an older screen is left to its own flow')
  t.ok(src.includes('dropDeleted.current(t.ref, true)'), 'the screen that deleted always clears its flags')
  t.ok(src.includes('if (!force && !held && !quoted && !wasComment) return'), 'a screen that does not show the post stays as it is')
})

test('Conversa: an older screen drops a reply deleted above it, with its descendants, and lowers the parent count', async (t) => {
  const r5 = item(5, 2, B, B)
  const r6 = item(6, 5, C, B)
  const r7 = item(7, 2, C, B)
  const { listener, state, context } = await deleting({
    comments: [item(2, 1, B, A)],
    rodas: new Map([[TOP, rodaOf([r5, r6, r7], 3)]]),
    open: new Set([TOP]),
    counts: [[TOP, { replies: 2 }]],
    onDeletedPost: () => { throw new Error('only the screen that deleted counts it') }
  })
  listener(new Set([B + ':5']))
  t.is(context.eng.counts.get(TOP).replies, 1)
  t.alike(refsIn(state.rodas.get(TOP).replies), [C + ':7'])
  t.is(state.back, 0)
  const commits = state.commits
  listener(new Set([A + ':77']))
  t.is(context.eng.counts.get(TOP).replies, 1, 'a post this screen does not hold changes nothing')
  t.is(state.commits, commits)
  listener(new Set([R]))
  t.is(state.commits, commits, 'the root is left alone')
  t.is(state.back, 0)
})

test('Conversa: an older screen opened on a reply still drops that reply: only the root is its main post', async (t) => {
  const r5 = item(5, 2, B, B)
  const { listener, state } = await deleting({
    focal: B + ':5',
    comments: [item(2, 1, B, A)],
    rodas: new Map([[TOP, rodaOf([r5, item(7, 2, C, B)], 2)]]),
    open: new Set([TOP]),
    counts: [[TOP, { replies: 2 }]]
  })
  listener(new Set([B + ':5']))
  t.alike(refsIn(state.rodas.get(TOP).replies), [C + ':7'])
})

test('Conversa: an older screen that only quotes the deleted post clears the quote', async (t) => {
  const peeked = new Map([[A, { key: A, entries: [{ seq: 8 }, { seq: 9 }] }]])
  const { listener, state } = await deleting({ comments: [], rodas: new Map(), peeked })
  listener(new Set([A + ':8']))
  t.alike(peeked.get(A).entries.map((e) => e.seq), [9])
  t.is(state.commits, 1, 'the screen renders again')
  listener(new Set([A + ':77']))
  t.is(state.commits, 1, 'a post that is neither shown nor quoted changes nothing')
})

test('Conversa: an older screen lowers the root count for a comment it only showed', async (t) => {
  const { listener, context } = await deleting({
    comments: [item(8, 1, B, A), item(9, 1, C, A)],
    rodas: new Map(),
    counts: [[R, { replies: 3, likes: 1 }]]
  })
  listener(new Set([B + ':8']))
  t.alike(context.eng.counts.get(R), { replies: 2, likes: 1 })
  t.alike(refsIn(context.viewRef.current.comments), [C + ':9'])
})

async function anchorOfLoaded () {
  const { isRef } = await import('../src/nav.js')
  return handler(src.replace('export function anchorOf', 'function anchorOf'), 'function anchorOf', '// Only posts just signed', 'anchorOf', { isRef })
}

test('Conversa anchor: a resolved target or the opener focus, never an orphan', async (t) => {
  const anchorOf = await anchorOfLoaded()
  const ok = (top, target, proven) => ({ status: 'ok', root: R, top, target, index: null, page: null, proven })
  t.alike(anchorOf(ok(TOP, C + ':6', true), null, null), { top: TOP, target: C + ':6', proven: true })
  t.alike(anchorOf(ok(TOP, C + ':6', undefined), null, null), { top: TOP, target: C + ':6', proven: false }, 'a missing proven is not proof')
  t.alike(anchorOf(ok(TOP, TOP, true), null, null), { top: TOP, target: TOP, proven: true }, 'a comment key')
  t.is(anchorOf(ok(null, null, true), null, null), null, 'the root key has nothing to show')
  t.alike(anchorOf(ok(null, null, true), C + ':6', TOP), { top: TOP, target: C + ':6', proven: false }, 'the opener focus is unproven')
  t.alike(anchorOf(ok(TOP, C + ':6', true), B + ':5', C + ':3'), { top: TOP, target: C + ':6', proven: true }, 'the resolution wins over a focus')
  t.is(anchorOf(ok(null, null, true), 'x', TOP), null)
  t.is(anchorOf({ status: 'orphan', root: C + ':6', top: null, target: C + ':6' }, C + ':6', TOP), null)
  t.is(anchorOf({ status: 'error', reason: 'network' }, C + ':6', TOP), null)
  t.is(anchorOf(null, null, null), null)
})

function scrolling (rows, options = {}) {
  const timers = []
  const state = { calls: [], flash: [], announced: [], toasts: [], cleared: 0 }
  const list = {
    scrollToIndex: (args) => {
      state.calls.push(args)
      if (options.fail && options.fail(state.calls.length, args)) throw new Error('cannot place')
    }
  }
  const context = {
    jumpTimer: { current: null },
    flashTimer: { current: null },
    setFlashKey: (key) => state.flash.push(key),
    AccessibilityInfo: { announceForAccessibility: (text) => state.announced.push(text) },
    onToast: (text) => state.toasts.push(text),
    OUTSIDE_NOTE: 'Mensagem fora do trecho carregado',
    rowsRef: { current: rows },
    listRef: { current: options.noList ? null : list },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => { state.cleared++ },
    JUMP_RETRY_MS: 120,
    ANCHOR_TRIES: 4,
    FLASH_MS: 900
  }
  const scrollToKey = handler(src, '  const scrollToKey = (key', '  rowsRef.current = rows', 'scrollToKey', context)
  return { scrollToKey, state, timers, context }
}

test('Conversa quote jump: centered scroll, a second try after 120 ms, then a 900 ms flash', (t) => {
  const rows = [{ key: 'comment:' + TOP }, { key: 'toggle:' + TOP }, { key: 'reply:' + B + ':5' }]
  const { scrollToKey, state, timers } = scrolling(rows)
  scrollToKey('reply:' + B + ':5')
  t.alike(state.calls, [{ index: 2, animated: false, viewPosition: 0.5 }])
  t.alike(state.flash, [null], 'no flash before the second try')
  t.is(timers[0].ms, 120)
  rows.unshift({ key: 'comment:' + C + ':3' })
  timers[0].fn()
  t.alike(state.calls[1], { index: 3, animated: false, viewPosition: 0.5 }, 'the index is read again: a page may have landed')
  t.alike(state.flash, [null, 'reply:' + B + ':5'])
  t.is(timers[1].ms, 900)
  timers[1].fn()
  t.is(state.flash[2], null, 'the flash ends')
  t.alike(state.announced, [])
})

test('Conversa quote jump: a row outside the loaded part is announced and nothing else happens', (t) => {
  const outside = scrolling([{ key: 'comment:' + TOP }])
  outside.scrollToKey('reply:' + B + ':9')
  t.is(outside.state.calls.length, 0, 'no scroll')
  t.alike(outside.state.announced, ['Mensagem fora do trecho carregado'])
  t.alike(outside.state.toasts, ['Mensagem fora do trecho carregado'])
  t.is(outside.timers.length, 0)

  const throws = scrolling([{ key: 'reply:' + B + ':5' }], { fail: (n) => n === 1 })
  throws.scrollToKey('reply:' + B + ':5')
  t.is(throws.state.announced.length, 1, 'a scroll that throws is a miss')
  t.is(throws.timers.length, 0, 'and no second try')

  const late = scrolling([{ key: 'reply:' + B + ':5' }], { fail: (n) => n === 2 })
  late.scrollToKey('reply:' + B + ':5')
  late.timers[0].fn()
  t.is(late.state.announced.length, 1, 'the second try throwing is a miss too')
  t.absent(late.state.flash.includes('reply:' + B + ':5'), 'and no flash')

  const quiet = scrolling([{ key: 'comment:' + TOP }])
  quiet.scrollToKey('reply:' + B + ':9', true)
  t.alike(quiet.state.announced, [], 'the anchor misses quietly')
  t.alike(quiet.state.toasts, [])

  const noList = scrolling([{ key: 'reply:' + B + ':5' }], { noList: true })
  noList.scrollToKey('reply:' + B + ':5')
  t.is(noList.state.announced.length, 1)
})

test('Conversa anchor jump: a row the list has not measured yet is tried again, then flashed', (t) => {
  const key = 'reply:' + B + ':5'
  const rows = [{ key: 'comment:' + TOP }, { key: 'toggle:' + TOP }, { key }]
  let throws = 2
  const { scrollToKey, state, timers } = scrolling(rows, { fail: (n, args) => args.index === 2 && throws-- > 0 })
  scrollToKey(key, true)
  t.alike(state.calls[1], { index: 1, animated: false, viewPosition: 1 }, 'the last row it can place comes into view first')
  t.is(timers.length, 1)
  t.is(timers[0].ms, 120)
  timers[0].fn()
  t.is(timers.length, 2, 'a second throw arms another try')
  timers[1].fn()
  t.alike(state.calls[state.calls.length - 1], { index: 2, animated: false, viewPosition: 0.5 })
  t.is(timers[2].ms, 120, 'then the usual second try')
  timers[2].fn()
  t.ok(state.flash.includes(key), 'the row flashes')
  t.alike(state.announced, [])

  const never = scrolling(rows, { fail: (n, args) => args.index === 2 })
  never.scrollToKey(key, true)
  for (let i = 0; i < never.timers.length; i++) never.timers[i].fn()
  t.is(never.timers.length, 3, 'four tries in all')
  t.is(never.state.calls.filter((args) => args.index === 2).length, 4)
  t.alike(never.state.announced, [], 'then a quiet miss')
  t.ok(src.includes('const ANCHOR_TRIES = 4'), 'the harness count is the screen count')
  t.absent(never.state.flash.includes(key))
})

test('Conversa reply bar: an unconfirmed root is not the default target', (t) => {
  const make = (root, proven, rootKey = root) => handler(src, '  const rootTarget =', '  const target = replyTarget', 'rootTarget', {
    rootKey,
    root,
    view: { proven },
    post: { author: A, text: 'raiz' },
    identityOf: () => ({ name: 'Ana' }),
    names: {}
  })
  t.is(make(R, false), null, 'unproven: no root target')
  t.alike(make(R, true), { ref: R, name: 'Ana', text: 'raiz' })
  t.is(make(null, false, R).ref, R, 'a root seed before the load is the root itself')
  t.is(make(null, false, null), null)
  const bar = between('            <ReplyBar', '            />')
  t.ok(bar.includes('target={target}') && src.includes('  const target = replyTarget || rootTarget'), 'a row tapped for a reply still answers')
})

test('Conversa quote jump: the chat pattern without onScrollToIndexFailed', (t) => {
  const helper = between('  const scrollToKey = (key', '  rowsRef.current = rows')
  t.absent(src.includes('onScrollToIndexFailed'), 'never relied on')
  t.ok(/try \{\n\s+list\.scrollToIndex\(\{ index, animated: false, viewPosition: 0\.5 \}\)\n\s+\} catch \{/.test(helper), 'the first scroll is in try/catch')
  t.ok(helper.includes('}, JUMP_RETRY_MS)'), 'the second attempt')
  t.ok(src.includes('const JUMP_RETRY_MS = 120') && src.includes('const FLASH_MS = 900'))
  t.ok(src.includes('listRef={listRef}'), 'the list hands its ref')
  t.ok(src.includes('extraData={extra}') && /const extra = useMemo\(\(\) => \(\{[^}]*\bflashKey, sending\b[^}]*\}\), \[[^\]]*\bflashKey, sending\b/.test(src), 'the flash and the send state re-render the rows')
  t.ok(src.includes("flash: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: colors.accent, opacity: 0.12 }"), 'the flash is drawn over the opaque row')
  t.ok(src.includes('useEffect(() => () => {\n    clearTimeout(jumpTimer.current)\n    clearTimeout(flashTimer.current)\n  }, [])'), 'no timer outlives the screen')
})

test('Conversa swipe: comment and reply rows answer by swipe, off when it cannot reply', async (t) => {
  const renderer = between('  renderRef.current = (row) => {', '  const notes = []')
  t.is(renderer.split('<SwipeReply disabled={swipeOff(row.item)} onReply={swipeTo(row.item)}>').length - 1, 2, 'comments and replies')
  t.ok(src.includes("import { SwipeReply } from '../ui/SwipeReply'"))
  t.ok(src.includes('const swipeOff = (item) => !full || sending || !canSwipeReply(item)'), 'the three disable conditions')
  const { canSwipeReply } = await import('../src/roda.js')
  const targets = []
  const names = { profileOf: () => ({ name: 'Bia', username: 'bia' }) }
  const make = (full, sending) => handler(src, '  const swipeOff = (item)', '  const flashOf =', '{ swipeOff, swipeTo }', {
    full,
    sending,
    canSwipeReply,
    identityOf: (n, author, item) => ({ name: item.name || n.profileOf(author).name, username: n.profileOf(author).username }),
    names,
    targetReply: (target) => targets.push(target),
    refOf
  })
  const reply = item(5, 2, B, B)
  const open = make(true, false)
  t.absent(open.swipeOff(reply))
  t.ok(make(false, false).swipeOff(reply), 'off without the full node')
  t.ok(make(true, true).swipeOff(reply), 'off while sending')
  t.ok(open.swipeOff({ ...reply, media: [{}, {}] }), 'off over a carousel')
  t.ok(open.swipeOff({ ...reply, seq: undefined }), 'off for a row still being sent')
  open.swipeTo(reply)()
  t.alike(targets, [{ ref: B + ':5', name: 'Bia', username: 'bia', text: 'resposta 5' }], 'the swipe targets that message, as its reply icon does')
  const rows = src.slice(src.indexOf('export function rowProps'), src.indexOf('export function seedItem'))
  t.ok(rows.includes('onReply: hasSeq && has(\'onReply\') ? () => live.handlers.onReply({ ref, name: who.name, username: who.username, text: item.text }) : undefined,'), 'the reply icon stays')
})

async function anchoring (options) {
  const thread = await import('../src/thread.js')
  const { seekTarget, SEEK_PAGES } = await import('../src/rodaLoad.js')
  const postAt = handler(src.replace('export function postAt', 'function postAt'), 'function postAt', '// Names learned from the peeks', 'postAt', { parseRef: thread.parseRef, assembleMember: thread.assembleMember, postsByPeek: new WeakMap() })
  const pages = options.pages || {}
  const state = { open: new Set(), loads: [], climbs: [], reloads: 0, ticks: 0, rodaResets: 0 }
  const context = {
    genRef: { current: 1 },
    rodasRef: { current: new Map() },
    viewRef: { current: { root: options.root || R, comments: (options.comments || [TOP]).map((ref) => ({ author: ref.split(':')[0], seq: Number(ref.split(':')[1]) })) } },
    setOpen: (update) => { state.open = typeof update === 'function' ? update(state.open) : update },
    // A page lands its rows in the roda, as loadRoda does after the gate.
    loadRoda: async (top, cursor = null) => {
      state.loads.push([top, cursor])
      if (options.onLoad) options.onLoad(context, cursor)
      const page = pages[String(cursor)]
      if (!page) return null
      const held = context.rodasRef.current.get(top)
      const replies = (held ? held.replies : []).concat(page.items.map((ref) => ({ author: ref.split(':')[0], seq: Number(ref.split(':')[1]) })))
      context.rodasRef.current = new Map(context.rodasRef.current).set(top, { replies, next: page.next })
      return { next: page.next }
    },
    seekTarget,
    SEEK_PAGES,
    pendingJump: { current: null },
    setJumpTick: (update) => { state.ticks = update(state.ticks) },
    peekedRef: { current: new Map() },
    peekAll: fakePeekAll(world(options.posts || [])),
    request: async () => {},
    planPeeks: thread.planPeeks,
    postAt,
    resolveRoot: options.resolveRoot || (async (args) => { state.climbs.push(args); return options.climb || { status: 'error', reason: 'network' } }),
    fetchPost: async () => ({ ok: false, reason: 'not-found' }),
    fetchRoda: async () => { throw new Error('a climb never asks for a roda') },
    resolvedRef: { current: { focal: options.focal || C + ':6', res: null } },
    focal: options.focal || C + ':6',
    putRodas: () => { state.rodaResets++ },
    setRodaErrors: () => {},
    setRodaBusy: () => {},
    rodaRequests: { current: new Map([[TOP, {}]]) },
    branchGen: { current: 0 },
    rodaSeed: { current: { top: TOP } },
    load: (refreshing) => { state.reloads++; state.reloadedFresh = refreshing },
    commit: (patch) => { context.viewRef.current = { ...context.viewRef.current, ...patch } },
    sessionRef: { current: 0 },
    anchorRef: { current: null },
    INITIAL: { phase: 'loading', error: '', root: null, post: null, comments: [], proven: false },
    refOf
  }
  const showAnchor = handler(src, '  const showAnchor = async', '  useEffect(() => {\n    if (full) load(false)', 'showAnchor', context)
  return { showAnchor, state, context }
}

test('Conversa anchor: the roda of its comment opens and the target is scrolled to and flashed', async (t) => {
  const first = await anchoring({ pages: { null: { items: [B + ':5', C + ':6'], next: 'c2' } } })
  await first.showAnchor({ top: TOP, target: C + ':6', proven: false })
  t.ok(first.state.open.has(TOP), 'the roda opens by itself')
  t.alike(first.state.loads, [[TOP, null]], 'its first page only, the one resolveRoot already fetched')
  t.is(first.context.pendingJump.current, 'reply:' + C + ':6')
  t.is(first.state.ticks, 1, 'a render follows, and the jump runs after it')
  t.alike(first.state.climbs, [], 'found in the verified roda: proven')
  t.is(first.context.viewRef.current.proven, true, 'the screen knows the root is confirmed')

  const deep = await anchoring({
    pages: { null: { items: [B + ':5'], next: 'c2' }, c2: { items: [C + ':7'], next: 'c3' }, c3: { items: [C + ':6'], next: 'c4' } }
  })
  await deep.showAnchor({ top: TOP, target: C + ':6', proven: true })
  t.alike(deep.state.loads, [[TOP, null], [TOP, 'c2'], [TOP, 'c3']], 'seekTarget starts from the cursor after the first page')
  t.is(deep.context.pendingJump.current, 'reply:' + C + ':6')

  const comment = await anchoring({})
  await comment.showAnchor({ top: TOP, target: TOP, proven: true })
  t.alike(comment.state.loads, [], 'a comment target needs no roda')
  t.is(comment.context.pendingJump.current, 'comment:' + TOP)
})

test('Conversa anchor: not found, the roda stays open with more to load', async (t) => {
  const pages = { null: { items: [B + ':5'], next: 'c2' } }
  for (const cursor of ['c2', 'c3', 'c4', 'c5']) pages[cursor] = { items: [], next: 'c' + (Number(cursor.slice(1)) + 1) }
  const { showAnchor, state, context } = await anchoring({ pages })
  await showAnchor({ top: TOP, target: C + ':6', proven: true })
  t.is(state.loads.length, 5, 'the first page and at most four more')
  t.ok(state.open.has(TOP))
  t.is(context.pendingJump.current, null)
  t.alike(state.climbs, [], 'a proven root is not climbed again')
  t.is(state.reloads, 0)

  const lastPage = await anchoring({ pages: { null: { items: [B + ':5'], next: null } } })
  await lastPage.showAnchor({ top: TOP, target: C + ':6', proven: true })
  t.alike(lastPage.state.loads, [[TOP, null]], 'a roda with no next page is not asked for its first page again')
})

test('Conversa anchor: an unproven root the target is not under is replaced by its signed climb', async (t) => {
  const elsewhere = { status: 'ok', root: A + ':1', top: B + ':2', target: C + ':6', index: null, page: null, proven: true }
  const moved = await anchoring({ root: D + ':1', pages: { null: { items: [B + ':5'], next: null } }, climb: elsewhere })
  await moved.showAnchor({ top: TOP, target: C + ':6', proven: false })
  t.alike(moved.state.climbs, [{ key: C + ':6', climbOnly: true }], 'one signed climb, no roda')
  t.is(moved.context.resolvedRef.current.res, elsewhere, 'the next load is built from the climb')
  t.is(moved.state.reloads, 1)
  t.is(moved.state.reloadedFresh, false)
  t.is(moved.state.rodaResets, 1)
  t.is(moved.context.branchGen.current, 1, 'pages of the old rodas cannot land')
  t.is(moved.context.rodaSeed.current, null)
  t.is(moved.context.rodaRequests.current.size, 0)
  t.is(moved.state.open.size, 0)

  const same = await anchoring({ root: D + ':1', pages: { null: { items: [B + ':5'], next: null } }, climb: { ...elsewhere, root: D + ':1' } })
  same.context.resolvedRef.current = { focal: C + ':6', res: { status: 'ok', root: D + ':1', top: TOP, target: C + ':6', proven: false } }
  await same.showAnchor({ top: TOP, target: C + ':6', proven: false })
  t.is(same.state.climbs.length, 1)
  t.is(same.state.reloads, 0, 'a climb to the same root: the shown conversation stays')
  t.ok(same.state.open.has(TOP))
  t.is(same.context.viewRef.current.proven, true, 'and is confirmed')
  t.is(same.context.resolvedRef.current.res.proven, true, 'a refresh does not check it again')

  const failed = await anchoring({ root: D + ':1', pages: {}, climb: elsewhere })
  await failed.showAnchor({ top: TOP, target: C + ':6', proven: false })
  t.is(failed.state.reloads, 1, 'a roda that cannot load proves nothing either')

  const notShown = await anchoring({ comments: [C + ':3'], pages: { null: { items: [C + ':6'], next: null } }, climb: elsewhere })
  await notShown.showAnchor({ top: TOP, target: C + ':6', proven: false })
  t.alike(notShown.state.loads, [], 'no roda under a comment that is not shown')
  t.is(notShown.state.climbs.length, 1)
})

test('Conversa anchor: a climb that fails leaves no unconfirmed root on screen', async (t) => {
  for (const reason of ['network', 'unavailable']) {
    const failed = await anchoring({ root: D + ':1', pages: { null: { items: [B + ':5'], next: null } }, climb: { status: 'error', reason } })
    failed.context.viewRef.current = { ...failed.context.viewRef.current, phase: 'ready', post: { author: D, seq: 1 }, proven: false }
    await failed.showAnchor({ top: TOP, target: C + ':6', proven: false })
    const view = failed.context.viewRef.current
    t.is(view.phase, 'error', reason + ': the error state, whose retry opens it again')
    t.is(view.error, reason === 'network' ? 'Não foi possível abrir a conversa.' : 'Esta conversa não está disponível.')
    t.is(view.post, null, 'the seeder root is not shown')
    t.is(view.root, null)
    t.is(failed.context.resolvedRef.current, null, 'the retry resolves again from the start')
    t.is(failed.state.reloads, 0, 'never retried by itself')
    t.is(failed.state.climbs.length, 1)
    t.is(failed.state.open.size, 0, 'the rodas are dropped')
    t.is(failed.context.branchGen.current, 1)
  }
})

test('Conversa anchor: a climb cut at its limit keeps a conversation whose verified roda holds the ancestor', async (t) => {
  const pages = { null: { items: [B + ':5', C + ':7'], next: null } }
  for (const at of [B + ':5', TOP]) {
    const kept = await anchoring({ root: D + ':1', pages, climb: { status: 'orphan', root: at, top: null, target: C + ':6', index: null, page: null, cut: true } })
    await kept.showAnchor({ top: TOP, target: C + ':6', proven: false })
    t.is(kept.state.reloads, 0, at + ': the shown conversation stays')
    t.is(kept.context.viewRef.current.proven, true, 'and is confirmed')
    t.ok(kept.state.open.has(TOP))
  }
  const outside = await anchoring({ root: D + ':1', pages, climb: { status: 'orphan', root: A + ':40', top: null, target: C + ':6', index: null, page: null, cut: true } })
  await outside.showAnchor({ top: TOP, target: C + ':6', proven: false })
  t.is(outside.state.reloads, 1, 'an ancestor the roda does not hold: the cut view')
  t.is(outside.context.resolvedRef.current.res.cut, true)
  const gone = await anchoring({ root: D + ':1', pages, climb: { status: 'orphan', root: B + ':5', top: null, target: C + ':6', index: null, page: null, cut: false } })
  await gone.showAnchor({ top: TOP, target: C + ':6', proven: false })
  t.is(gone.state.reloads, 1, 'a missing parent, not a cut: the orphan view')
  const unshown = await anchoring({ root: D + ':1', comments: [C + ':3'], pages, climb: { status: 'orphan', root: TOP, top: null, target: C + ':6', index: null, page: null, cut: true } })
  await unshown.showAnchor({ top: TOP, target: C + ':6', proven: false })
  t.is(unshown.state.reloads, 1, 'a top that is only the opener word proves nothing')
})

test('Conversa anchor: a run ended by a load or a delete hands an unproven check to the next ready load', async (t) => {
  const anchor = { top: TOP, target: C + ':6', proven: false }
  const cut = await anchoring({ pages: { null: { items: [B + ':5'], next: null } }, onLoad: (ctx) => { ctx.genRef.current++ } })
  await cut.showAnchor(anchor)
  t.is(cut.context.anchorRef.current, anchor, 'stale after its roda page')
  t.is(cut.state.climbs.length, 0)

  const late = await anchoring({
    pages: { null: { items: [B + ':5'], next: null } },
    resolveRoot: async (args) => { late.state.climbs.push(args); late.context.genRef.current++; return { status: 'error', reason: 'network' } }
  })
  await late.showAnchor(anchor)
  t.is(late.context.anchorRef.current, anchor, 'stale after the climb: no verdict, so no error either')
  t.is(late.context.viewRef.current.phase, undefined)

  const proven = await anchoring({ pages: { null: { items: [B + ':5'], next: null } }, onLoad: (ctx) => { ctx.genRef.current++ } })
  await proven.showAnchor({ ...anchor, proven: true })
  t.is(proven.context.anchorRef.current, null, 'a confirmed root needs no second run')

  const other = await anchoring({ pages: { null: { items: [B + ':5'], next: null } }, onLoad: (ctx) => { ctx.genRef.current++; ctx.sessionRef.current++ } })
  await other.showAnchor(anchor)
  t.is(other.context.anchorRef.current, null, 'another post opened meanwhile: dropped')

  const newer = { top: TOP, target: C + ':7', proven: false }
  const replaced = await anchoring({ pages: { null: { items: [B + ':5'], next: null } }, onLoad: (ctx) => { ctx.genRef.current++; ctx.anchorRef.current = newer } })
  await replaced.showAnchor(anchor)
  t.is(replaced.context.anchorRef.current, newer, 'a newer load anchor wins')
})

test('Conversa anchor: the real signed climb finds the root a lying seeder hid', async (t) => {
  const { resolveRoot } = await import('../src/rodaLoad.js')
  const posts = [[R, null], [B + ':2', R], [B + ':5', B + ':2'], [C + ':6', B + ':5']]
  const { showAnchor, state, context } = await anchoring({ root: D + ':1', posts, pages: { null: { items: [], next: null } }, resolveRoot })
  await showAnchor({ top: TOP, target: C + ':6', proven: false })
  const res = context.resolvedRef.current.res
  t.is(res.status, 'ok')
  t.is(res.root, R)
  t.is(res.top, B + ':2')
  t.is(res.proven, true, 'the next anchor never climbs again')
  t.is(state.reloads, 1)
})

test('Conversa anchor: a load or refresh meanwhile stops it', async (t) => {
  const { showAnchor, state, context } = await anchoring({
    pages: { null: { items: [C + ':6'], next: null } },
    onLoad: (ctx) => { ctx.genRef.current++ },
    climb: { status: 'ok', root: A + ':1', top: B + ':2', target: C + ':6', proven: true }
  })
  await showAnchor({ top: TOP, target: C + ':6', proven: false })
  t.is(context.pendingJump.current, null)
  t.is(state.climbs.length, 0)
  t.is(state.reloads, 0)
})

test('Conversa anchor: runs once after the ready render, and the jump after the next one', (t) => {
  t.ok(src.includes('if (!refreshing || viewRef.current.proven !== true) anchorRef.current = anchorOf(res, focusRef, focusTop)'), 'set by a first load, or a refresh of an unconfirmed root')
  t.ok(src.includes("if (view.phase !== 'ready' || view.refreshing || anchorRef.current === null) return\n    const anchor = anchorRef.current\n    anchorRef.current = null\n    showAnchor(anchor)\n  }, [view])"))
  t.ok(src.includes("if (typeof scrollRef.current === 'function') scrollRef.current(key, true)\n  }, [jumpTick])"), 'quiet: a miss leaves the roda open')
  const reset = between('    sessionRef.current += 1\n    setOpen(new Set())', '  }, [focal, putRodas])')
  t.ok(reset.includes('anchorRef.current = null') && reset.includes('pendingJump.current = null') && reset.includes('setFlashKey(null)'), 'another post drops the pending anchor and flash')
  const roda = between('  const loadRoda = async', '  loadRodaRef.current = loadRoda')
  t.ok(roda.includes('return { next }') && roda.includes('return null\n    } finally {'), 'loadRoda tells seekTarget whether the page landed')
  t.absent(/if \(!alive\(\)\) return\n/.test(roda), 'every early exit answers null')
})

test('Conversa send handler: a deep target no loaded roda holds goes to its resolved comment, or nowhere', async (t) => {
  const top = A + ':2'
  const resolved = { status: 'ok', root: focal, top, target: C + ':5', proven: false }
  const known = await sending({ target: C + ':5', comments: [item(2, 4)], resolved })
  t.is(await known.send('resposta funda'), true)
  t.alike(known.state.rodas.get(top).replies.map((r) => r.seq), [8], 'shown in the roda of the comment resolveRoot found')
  t.ok(known.state.open.has(top))
  t.absent(known.state.open.has(C + ':5'), 'no open key that is not a comment')
  t.alike(known.state.loads, [[top]])
  t.is(known.state.cached.key, top)

  for (const options of [{ resolved: null }, { resolved }, { resolved: { ...resolved, target: C + ':9' } }]) {
    const unknown = await sending({ target: C + ':5', comments: options.resolved ? [item(3, 4)] : [item(2, 4)], ...options })
    t.is(await unknown.send('resposta funda'), true, 'the send itself succeeds')
    t.is(unknown.state.rodas.size, 0, 'no roda that would never be drawn')
    t.is(unknown.state.open.size, 0)
    t.alike(unknown.state.loads, [], 'no request for a roda of a deep reply')
    t.is(unknown.state.cached, undefined, 'no cache keyed by a deep ref')
    t.is(unknown.context.ownReplies.current.size, 0)
    t.is(unknown.context.eng.counts.get(C + ':5').replies, 1, 'the answered message still counts it')
  }
})

test('Conversa send handler: an own comment raises the root count, a failed one does not', async (t) => {
  const meta = { indexing: false, complete: true }
  const old = item(4, 1, B, A)
  const sent = await sending({ meta, comments: [old], counts: [[focal, { replies: 3 }]] })
  t.is(await sent.send('comentário'), true)
  t.is(sent.context.eng.counts.get(focal).replies, 4)
  t.is(sent.context.viewRef.current.comments.length, 2)
  t.is(sent.context.viewRef.current.comments[1], old, 'the own comment goes first')
  const failed = await sending({
    meta,
    comments: [old],
    counts: [[focal, { replies: 3 }]],
    request: async (method) => {
      if (method === 'log.read') return { key: A, entries: [], entriesTruncated: 0 }
      const err = new Error('talvez')
      err.uncertain = true
      throw err
    }
  })
  t.is(await failed.send('comentário'), false)
  t.is(failed.context.eng.counts.get(focal).replies, 3, 'an uncertain send leaves the count')
  t.alike(failed.context.viewRef.current.comments, [old])
})

test('Conversa load: the first open tries once more after a lost connection', async (t) => {
  let fails = 1
  const once = await loading({ ...deepThread(), key: R, failPost: () => fails-- > 0 })
  await once.load(false)
  t.is(once.state.resolves, 2)
  t.is(once.context.viewRef.current.phase, 'ready')
  const down = await loading({ ...deepThread(), key: R, failPost: () => true })
  await down.load(false)
  t.is(down.state.resolves, 2, 'once only')
  t.is(down.context.viewRef.current.phase, 'error')
  const gone = await loading({ ...deepThread(), key: B + ':99' })
  await gone.load(false)
  t.is(gone.state.resolves, 1, 'an unavailable post is not asked again')
})

test('Conversa roda: an open roda whose first load never landed offers to load again', (t) => {
  const rodaMore = handler(src, 'function rodaMore', '// The row the screen was opened for', 'rodaMore', {})
  const loaded = (next) => ({ replies: [], loaded: true, next })
  const more = rodaMore({
    open: new Set(['a', 'b', 'c', 'd', 'e', 'f']),
    rodas: new Map([['a', loaded('c2')], ['b', loaded(null)], ['c', { replies: [{}], loaded: false, next: null }], ['f', loaded('c2')]]),
    errors: new Map([['f', { text: 'x', cursor: 'c2' }]]),
    busy: new Set(['e'])
  })
  t.alike([...more.keys()].sort(), ['a', 'c', 'd'], 'a next page, an own reply waiting for its roda, a roda never loaded; not while loading or failed')
  t.is(rodaMore({ open: new Set(), rodas: new Map([['a', loaded('c2')]]), errors: new Map(), busy: new Set() }).size, 0, 'closed rodas get nothing')
  t.ok(src.includes('more: rodaMore({ open, rodas, errors: rodaErrors, busy: rodaBusy }),'))
})

test('Conversa: the seed row stops its skeleton when the load fails', (t) => {
  const header = between('  const header = (', '  // The screen pads')
  t.ok(header.includes("{phase === 'loading' ? <Skeleton rows={1} /> : null}"))
  t.absent(header.includes('            <Skeleton rows={1} />\n'), 'never drawn in the error phase')
})
