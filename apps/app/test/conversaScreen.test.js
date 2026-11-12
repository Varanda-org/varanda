'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { compileFunction } = require('node:vm')

const src = readFileSync(join(__dirname, '../src/screens/Conversa.js'), 'utf8')
const app = readFileSync(join(__dirname, '../App.js'), 'utf8')

test('Conversa: nested rows use the verified thread gate and reset with the focal ref', (t) => {
  t.ok(src.includes('threadRows({ replies, ...branches, open, more: childMore })'))
  t.ok(src.includes('assembleThread({ focal: parentKey, index, peeked })'))
  t.ok(src.includes('mergeChildren(previous, parentKey, items)'))
  t.ok(src.includes('setOpen(new Set())') && src.includes('setChildren(new Map())'))
  t.ok(src.includes('childLabel(row.count, row.open)'))
  t.ok(src.includes("label='Ver mais respostas'"))
  t.ok(src.includes('row.depth === 1 && row.deeper !== 0'))
  t.ok(src.includes("label='Ver conversa'"))
  t.ok(src.includes('borderLeftWidth: 1, borderLeftColor: colors.line'))
})

test('Conversa: full nodes pin ReplyBar and keep the sheet path elsewhere', (t) => {
  const fallback = src.slice(src.indexOf('  if (!full && !sending) {'), src.indexOf('  const { phase, error, meta'))
  t.ok(fallback.includes('<OfflineNote />'), 'a send in flight keeps the bar mounted through an offline blip')
  t.ok(src.includes('onReply: full ? targetReply : onReply'))
  t.ok(src.includes('<PostRow {...props(seed)} expanded />') && fallback.includes('<PostRow'))
  t.ok(src.includes('<PostRow expanded {...props(post,'))
  t.ok(src.includes('{full || sending\n        ? (') && src.includes('<ReplyBar'))
  t.ok(src.includes('onClearTarget={() => setReplyTarget(null)}'))
  t.ok(src.includes('onSend={sendReply}'))
  t.ok(src.includes('renderItem={({ item: row }) => renderThreadRow(row)}'))
})

test('Conversa: compose signals focus even when the same stack entry is already on top', (t) => {
  t.ok(app.includes('const [composeSignal, setComposeSignal] = useState(null)'))
  t.ok(app.includes("node.hosted && node.online !== false && actingAs.get().kind !== 'page' && r.draft === undefined"))
  t.ok(app.includes("pushScreen({ screen: 'conversa', key: r.ref })"))
  t.ok(app.includes('setComposeSignal((previous) => ({ target: r, n: previous ? previous.n + 1 : 1 }))'))
  t.ok(app.includes('composeSignal={') && src.includes('composeSignal.target.ref === focal'))
  t.ok(src.includes('focusSignal={focusSignal}'))
  const openThread = app.slice(app.indexOf('  const openThread ='), app.indexOf('  const openEngagers ='))
  t.ok(openThread.includes('setComposeSignal(null)'), 'ordinary navigation drops a previous reply focus')
})

test('Conversa: quick sends retain uncertain drafts and delegate expansion acceptance', (t) => {
  t.ok(src.includes('quickReplyPlan({ text, nodeReady: full, actingAsPage: actingPageKey() !== null, hasLink: hasLink(text), refusal })'))
  t.ok(src.includes('const refusal = refusalOf(text)'))
  t.ok(src.includes('if (result.gated) return expandReply(text, target)'))
  t.ok(src.includes('result.error.uncertain === true'))
  t.ok(src.includes('result.refused ||'))
  t.ok(src.includes('withOwnReply(viewRef.current.replies, item)'))
  t.ok(src.includes("onPublished('quick-reply', target.ref)"))
  t.ok(app.includes('onPublished={onPublished}'))
  t.ok(app.includes('onReplyDraft={settleReplyDraft}'))
  t.ok(src.includes('const accepted = await onReply({ ...target, draft })'))
  t.ok(app.includes('return new Promise((resolve) => {'))
})

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const focal = B + ':4'

// Execute the screen's handler, with real planning and sending helpers, without mounting React Native.
function handler (source, start, end, name, context) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error('handler not found: ' + name)
  return compileFunction(source.slice(from, to) + '\nreturn ' + name, Object.keys(context))(...Object.values(context))
}

async function sending (options = {}) {
  const { quickReplyPlan, sendTextReply } = await import('../src/replySend.js')
  const { mergeChildren, withOwnReply } = await import('../src/threadRows.js')
  const { parseRef } = await import('../src/thread.js')
  const { refusalOf } = await import('../src/wordCheck.js')
  const { hasLink } = await import('../src/links.js')
  const state = { note: '', busy: false, replies: [], children: options.children || new Map(), open: new Set(), published: [], expanded: [], requests: [], reloads: 0 }
  const context = {
    quickReplyPlan,
    sendTextReply,
    mergeChildren,
    withOwnReply,
    parseRef,
    refusalOf,
    hasLink,
    focal,
    target: { ref: options.target || focal, name: 'Pessoa' },
    full: options.full !== false,
    actingPageKey: () => options.page ? A : null,
    sendingRef: { current: false },
    sessionRef: { current: 0 },
    ownReplies: { current: new Map() },
    names: {},
    identityOf: () => ({ name: 'Eu' }),
    eng: { counts: new Map() },
    setCount: (key, value) => context.eng.counts.set(key, value),
    viewRef: { current: { replies: options.replies || [], next: options.next || null } },
    childrenRef: { current: state.children },
    branchView: (await localReplies()).branchView,
    refOf: (author, seq) => author + ':' + seq,
    replyDraft: { current: { focal, text: 'resposta' } },
    cacheGeneration: options.cacheGeneration || (() => 0),
    cacheOwnReply: (key, item) => { state.cached = { key, item } },
    commit: (patch) => { Object.assign(context.viewRef.current, patch); state.replies = patch.replies },
    setNote: (note) => { state.note = note },
    setSending: (busy) => { state.busy = busy },
    setChildren: (update) => { state.children = update(state.children) },
    setOpen: (update) => { state.open = update(state.open) },
    errorText: (err) => err ? err.message : 'Erro',
    onPublished: (...args) => state.published.push(args),
    load: (...args) => { state.reloads++; state.loadArgs = args },
    expandReply: async (draft, target) => { state.expanded.push({ ...target, draft }); return options.accepted === true },
    request: async (method, params) => {
      state.requests.push({ method, params })
      if (options.request) return options.request(method, params)
      if (method === 'log.read') return { key: A, entries: [], entriesTruncated: 0 }
      return { ref: A + ':8', seq: 8 }
    }
  }
  const send = handler(src, '  const sendReply = async', '  const childMore =', 'sendReply', context)
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
    t.is(state.reloads, 0)
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

test('Conversa send handler: concurrent presses send once and insert the acknowledged reply', async (t) => {
  let finish
  const waiting = new Promise((resolve) => { finish = resolve })
  const { send, state, context } = await sending({
    request: async (method) => method === 'log.read' ? { key: A, entries: [], entriesTruncated: 0 } : waiting
  })
  const first = send('resposta')
  t.is(await send('resposta'), false)
  finish({ ref: A + ':8', seq: 8 })
  t.is(await first, true)
  t.is(state.requests.filter((r) => r.method === 'post.reply').length, 1)
  t.alike(state.published, [['quick-reply', focal]])
  t.is(state.reloads, 1)
  t.is(state.replies.length, 1)
  t.is(state.replies[0].text, 'resposta')
  t.alike(state.replies[0].replyTo, { author: B, seq: 4 })
  t.alike(context.ownReplies.current.get(focal), state.replies, 'a slow index cannot erase the local reply')
  t.is(state.busy, false)
})

test('Conversa send handler: replies to a loaded row open that branch', async (t) => {
  const target = A + ':2'
  const { send, state } = await sending({ target })
  t.is(await send('resposta ao filho'), true)
  t.is(state.replies.length, 0)
  t.is(state.children.get(target)[0].text, 'resposta ao filho')
  t.ok(state.open.has(target))
})

test('Conversa children handler: wrong-parent hints are excluded and stale loads cannot commit', async (t) => {
  const { assembleThread, planPeeks } = await import('../src/thread.js')
  const { mergeChildren, withOwnReply } = await import('../src/threadRows.js')
  const parentKey = A + ':2'
  for (const stale of [false, true]) {
    const state = { children: new Map(), next: new Map(), busy: new Set(), calls: [] }
    const context = {
      full: true,
      genRef: { current: 1 },
      branchGen: { current: 0 },
      childRequests: { current: new Map() },
      setChildBusy: (update) => { state.busy = update(state.busy) },
      setChildren: (update) => { state.children = update(state.children) },
      setChildNext: (update) => { state.next = update(state.next) },
      fetchPost: async (...args) => {
        state.calls.push(args)
        if (stale) context.genRef.current++
        return { ok: true, value: { ref: parentKey, parent: null, replies: [B + ':5', B + ':6'], next: 'cursor', repliesTotal: 2 } }
      },
      assembleThread,
      planPeeks,
      mergeChildren,
      withOwnReply,
      ownFor: (key, own) => own.get(key) || [],
      pruneOwnReplies: () => {},
      loadChildrenRef: { current: null },
      setChildErrors: (update) => { state.errors = update(state.errors || new Map()) },
      peekedRef: { current: new Map() },
      followsRef: { current: Promise.resolve(new Set()) },
      ownReplies: { current: new Map() },
      request: async () => {},
      readOwn: async () => {},
      peekAll: async (_request, _plan, peeked) => {
        peeked.set(B, {
          key: B,
          entries: [
            { seq: 5, record: { type: 'post', at: '2026-01-01', text: 'filho', replyTo: { author: A, seq: 2 } } },
            { seq: 6, record: { type: 'post', at: '2026-01-01', text: 'outra conversa', replyTo: { author: A, seq: 3 } } }
          ]
        })
      },
      quotePlan: async () => [],
      knownAuthors: () => [],
      ownKey: A,
      learnPeeked: () => {},
      learnMany: () => {},
      resolveMany: () => {},
      setCount: () => {},
      readCounts: () => {},
      refOf: (author, seq) => author + ':' + seq,
      setNote: (note) => { state.note = note },
      errorText: (err) => err.message
    }
    const load = handler(src, '  const loadChildren = async', '  const toggleChildren =', 'loadChildren', context)
    await load(parentKey)
    t.alike(state.calls, [[parentKey, null]])
    t.is(state.busy.size, 0)
    if (stale) {
      t.is(state.children.size, 0)
      t.is(state.next.size, 0)
    } else {
      t.alike(state.children.get(parentKey).map((item) => item.seq), [5])
      t.is(state.next.get(parentKey), 'cursor')
    }
  }
})

test('Conversa reply chips hide the focal parent only at depth zero', (t) => {
  t.ok(src.includes('props(row.item, row.depth === 0 ? { replyToName: null, onOpenParent: undefined } : undefined)'))
})

test('Conversa bar respects the safe area and consumes compose intent once', (t) => {
  t.ok(src.includes("import { useSafeAreaInsets } from 'react-native-safe-area-context'"))
  t.ok(src.includes('const insets = useSafeAreaInsets()'))
  t.ok(/<View style=\{\[styles.barWrap, \{ paddingBottom: keyboardOpen \? 8 : Math.max\(8, insets.bottom\) \}\]\}>\s*<ReplyBar/.test(src), 'the inset is dropped while the keyboard is open')
  t.ok(src.includes('barWrap: { backgroundColor: colors.card }'), 'the padding under the bar is the bar colour, not the page')
  t.ok(/targetReply\(composeSignal.target\)\s*if \(typeof onComposeSeen === 'function'\) onComposeSeen\(\)/.test(src))
  t.ok(app.includes('onComposeSeen={() => setComposeSignal(null)}'))
})

test('Conversa quick send uses a quiet read only without pending pages', async (t) => {
  for (const next of [null, 'page-two']) {
    const { send, state } = await sending({ next })
    await send('resposta')
    t.is(state.reloads, next === null ? 1 : 0)
    if (next === null) t.alike(state.loadArgs, [false, true])
  }
  const success = src.slice(src.indexOf('  const sendReply ='), src.indexOf('  const childMore ='))
  t.absent(success.includes('load(true)'))
  t.absent(success.includes('reset()'))
})

async function localReplies (registerLocalCache = () => {}) {
  const { withOwnReply } = await import('../src/threadRows.js')
  return handler(src.replace('export function branchView', 'function branchView'), 'const ownReplyCache =', 'const INITIAL =', '{ branchView, ownFor, cacheOwnReply, ownReplyCache, dropOwnReplies, pruneOwnReplies }', {
    withOwnReply,
    registerLocalCache,
    refOf: (author, seq) => author + ':' + seq
  })
}

const item = (seq, parent = 4) => ({ kind: 'post', author: A, seq, at: '2026-01-01', text: 'resposta', replyTo: { author: A, seq: parent } })

test('Conversa branch view inserts own deeper replies after their parent and floors counts', async (t) => {
  const { branchView, cacheOwnReply } = await localReplies()
  const { threadRows } = await import('../src/threadRows.js')
  const parent = item(1)
  const child = item(2, 1)
  const own = item(8, 2)
  const sibling = item(3, 1)
  const key = A + ':1'
  cacheOwnReply(A + ':2', own)
  const children = new Map([[key, [child, sibling]]])
  const counts = new Map([[key, { replies: 0, likes: 5 }]])
  const inputs = branchView([parent], counts, children, new Map())
  const rows = threadRows({ replies: [parent], ...inputs, open: new Set([key]) })
  t.alike(rows.filter((r) => r.kind === 'reply').map((r) => [r.item.seq, r.depth]), [[1, 0], [2, 1], [8, 1], [3, 1]])
  const localRow = rows.find((r) => r.item === own)
  t.alike(localRow && localRow.item.replyTo, { author: A, seq: 2 })
  t.is(inputs.counts.get(key).replies, 3)
  t.is(inputs.counts.get(key).likes, 5)
  t.is(counts.get(key).replies, 0, 'source counts stay untouched')
  t.is(children.get(key).length, 2)
  t.ok(threadRows({ replies: [parent], ...inputs, open: new Set() }).some((r) => r.kind === 'expander'), 'collapse keeps a way to reopen')
  counts.set(key, { replies: 20 })
  t.is(branchView([parent], counts, children, new Map()).counts.get(key).replies, 20)
  const directOwn = new Map([[key, [child]]])
  t.is(branchView([parent], new Map(), new Map(), directOwn).counts.get(key).replies, 2)
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
  t.ok(src.includes('ownFor(focal, ownReplies.current).reduce(withOwnReply,'))
  t.ok(src.includes('ownFor(parentKey, ownReplies.current).reduce(withOwnReply, page.replies)'))
  const sent = await sending()
  await sent.send('resposta')
  t.is(sent.state.cached.key, focal)
  t.is(sent.state.cached.item.seq, 8)
})

test('App quick replies refresh feeds without touching a parked composer', (t) => {
  const composer = { open: false, reply: { ref: focal, draft: 'guardado' }, quote: null }
  const state = { composer, version: 3, peekVersion: 6, toast: '' }
  const published = handler(app, '  const onPublished =', '  const startQuote =', 'onPublished', {
    setComposer: (update) => { state.composer = update(state.composer) },
    setVersion: (update) => { state.version = update(state.version) },
    setPeekVersion: (update) => { state.peekVersion = update(state.peekVersion) },
    showToast: (text) => { state.toast = text }
  })
  published('quick-reply', focal)
  t.is(state.composer, composer)
  t.is(state.version, 4)
  t.is(state.peekVersion, 7)
  t.is(state.toast, 'resposta publicada')
  published('reply', focal)
  t.is(state.composer.reply, null, 'Publicar still clears its sent context')
})

async function loading (options = {}) {
  const { withOwnReply } = await import('../src/threadRows.js')
  const own = await localReplies()
  const child = item(3, 2)
  child.quote = { author: B, seq: 6 }
  const state = { resets: 0, patches: [], quotes: [], calls: [], opened: [], children: new Map([[A + ':2', [child]]]), next: new Map([[A + ':2', 'old']]) }
  const context = {
    ...own,
    withOwnReply,
    useCallback: (fn) => fn,
    focal,
    request: async () => {},
    ownKey: A,
    genRef: { current: 0 },
    childrenRef: { current: state.children },
    childRequests: { current: new Map() },
    branchGen: { current: 0 },
    setChildBusy: () => {},
    setChildErrors: () => {},
    setChildren: (value) => { state.children = value },
    setChildNext: (value) => { state.next = value },
    openRef: { current: new Set([A + ':2']) },
    loadChildrenRef: { current: (key) => { state.opened.push(key) } },
    viewRef: { current: { phase: 'ready', next: null, replies: [item(1), item(9)], loadingMore: false, refreshing: false, ...options.view } },
    commit: (patch) => { state.patches.push(patch); Object.assign(context.viewRef.current, patch) },
    fetchPost: async (...args) => {
      state.calls.push(args)
      if (options.fetch) return options.fetch(...args)
      if (options.throws) throw new Error('falhou')
      return options.failure ? { ok: false, reason: 'not-found' } : { ok: true, value: { parent: null, replies: [], next: 'first-page', repliesTotal: 1 } }
    },
    reset: () => { state.resets++ },
    readOwn: async () => {},
    readCounts: () => {},
    loadFollows: async () => new Set(),
    followsRef: { current: Promise.resolve(new Set()) },
    peekedRef: { current: new Map() },
    peekAll: async () => {},
    planPeeks: () => [],
    assembleThread: () => ({ parent: null, post: item(4), replies: [item(1)], unavailable: 0 }),
    quotePlan: async (items) => { state.quotes = items; return [] },
    knownAuthors: () => [],
    learnPeeked: () => {},
    learnMany: () => {},
    resolveMany: () => {},
    setCount: () => {},
    ownReplies: { current: new Map() },
    refOf: (author, seq) => author + ':' + seq,
    isSeederDown: () => false,
    errorText: (err) => err.message
  }
  const load = handler(src, '  const load = useCallback(async (refreshing', '  const loadMore =', 'load', context)
  return { load, state, context, child }
}

test('Conversa quiet load preserves exhausted pages, engagement and branch state', async (t) => {
  const { load, state, context } = await loading()
  await load(false, true)
  t.is(state.resets, 0)
  t.absent(state.patches.some((p) => p.refreshing === true || p.phase === 'loading'))
  t.alike(context.viewRef.current.replies.map((i) => i.seq), [1, 9])
  t.is(context.viewRef.current.next, null)
  t.is(state.children.size, 1)
  t.is(state.next.get(A + ':2'), 'old')
  t.is(state.opened.length, 0)
  for (const view of [{ next: 'pending' }, { loadingMore: true }, { refreshing: true }]) {
    const held = await loading({ view })
    await held.load(false, true)
    t.is(held.state.calls.length, 0)
  }
})

test('Conversa pull refresh peeks child quotes and reloads every open branch from scratch', async (t) => {
  const { load, state, child } = await loading()
  await load(true)
  t.is(state.resets, 1)
  t.ok(state.quotes.includes(child))
  t.is(state.children.size, 0)
  t.is(state.next.size, 0)
  t.alike(state.opened, [A + ':2'])
})

test('Conversa both refresh failures release pagination flags', async (t) => {
  for (const options of [{ failure: true }, { throws: true }]) {
    const { load, context } = await loading({ ...options, view: { loadingMore: true } })
    await load(true)
    t.is(context.viewRef.current.loadingMore, false)
    t.is(context.viewRef.current.refreshing, false)
    t.is(context.viewRef.current.phase, 'ready')
  }
})

test('Conversa branch failures have their own retry and cannot overwrite send warnings', (t) => {
  const branch = src.slice(src.indexOf('  const loadChildren ='), src.indexOf('  const toggleChildren ='))
  t.absent(branch.includes('setNote('))
  t.ok(branch.includes('setChildErrors((previous) => new Map(previous).set(parentKey, errorText(err)))'))
  t.ok(branch.includes('next.delete(parentKey)'))
  t.ok(src.includes("label='Tentar de novo' onPress={() => loadChildren(key)}"))
  t.ok(src.includes('displayText(childErrors.get(key))'))
})

test('Conversa delete lowers the actual parent count once and removes cached copies', async (t) => {
  const own = await localReplies()
  for (const count of [0, 1, 3]) {
    const parent = A + ':2'
    const deleted = item(8, 2)
    own.cacheOwnReply(parent, deleted)
    const state = { children: new Map([[parent, [deleted]]]), open: new Set([parent]) }
    const context = {
      ...own,
      useDelete: (options) => options,
      request: () => {},
      node: {},
      onToast: () => {},
      load: () => {},
      genRef: { current: 1 },
      onDeletedPost: () => {},
      revokeDeletedMedia: () => {},
      focal,
      peekedRef: { current: new Map() },
      childrenRef: { current: state.children },
      ownReplies: { current: new Map([[parent, [deleted]]]) },
      eng: { counts: new Map([[parent, { replies: count, likes: 4 }]]) },
      setCount: (key, value) => context.eng.counts.set(key, value),
      setChildren: (update) => { state.children = update(state.children) },
      setOpen: (update) => { state.open = update(state.open) },
      viewRef: { current: { replies: [], parent: null, meta: null } },
      commit: () => {},
      refOf: (author, seq) => author + ':' + seq
    }
    const del = handler(src, '  const del = useDelete({', '  const handlers =', 'del', context)
    await del.onDeleted({ ref: A + ':8', seq: 8 })
    t.is(context.eng.counts.get(parent).replies, Math.max(0, count - 1))
    t.is(context.eng.counts.get(parent).likes, 4)
    t.is(state.children.get(parent).length, 0)
    t.is(own.ownFor(parent, context.ownReplies.current).length, 0)
    t.is(state.open.has(parent), count > 1)
  }
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
    const context = { onReply: async () => accepted, replyTarget: null, focalTarget: { ref: focal }, focal, replyDraft: { current: { focal, text: 'rascunho' } } }
    const expand = handler(src, '  const expandReply =', '  const sendReply =', 'expandReply', context)
    t.is(await expand('rascunho'), accepted)
    t.is(context.replyDraft.current.text, accepted ? '' : 'rascunho')
  }
})

test('Conversa send to a nested row reopens its depth-zero branch after collapse', async (t) => {
  const parentKey = A + ':1'
  const target = A + ':2'
  const children = new Map([[parentKey, [item(2, 1)]]])
  const { send, state } = await sending({ target, children, replies: [item(1)] })
  await send('resposta')
  t.ok(state.open.has(parentKey))
  t.absent(state.open.has(target))
})

test('Conversa failed branch pages keep the send warning and retry at the first cursor', async (t) => {
  const key = A + ':2'
  const warning = 'A resposta pode ter sido enviada.'
  const state = { note: warning, errors: new Map(), next: new Map([[key, 'second-page']]), busy: new Set(), calls: [] }
  const context = {
    full: true,
    genRef: { current: 1 },
    branchGen: { current: 0 },
    childRequests: { current: new Map() },
    loadChildrenRef: { current: null },
    setChildBusy: (update) => { state.busy = update(state.busy) },
    setChildErrors: (update) => { state.errors = update(state.errors) },
    setChildNext: (update) => { state.next = update(state.next) },
    setNote: (note) => { state.note = note },
    errorText: (err) => err.message,
    fetchPost: async (...args) => { state.calls.push(args); throw new Error('Sem conexão') }
  }
  const load = handler(src, '  const loadChildren = async', '  const toggleChildren =', 'loadChildren', context)
  await load(key, state.next.get(key))
  t.is(state.note, warning)
  t.is(state.errors.get(key), 'Sem conexão')
  t.absent(state.next.has(key))
  t.is(state.busy.size, 0)
  await load(key)
  t.alike(state.calls, [[key, 'second-page'], [key, null]])
  t.is(state.note, warning)
})

test('Conversa own reply cache wipes, caps each parent and retires indexed refs', async (t) => {
  let registered
  const own = await localReplies((entry) => { registered = entry })
  for (let seq = 10; seq < 35; seq++) own.cacheOwnReply(focal, item(seq))
  t.alike(own.ownFor(focal, new Map()).map((i) => i.seq), Array.from({ length: 20 }, (_, i) => i + 15))
  const local = new Map([[focal, [item(34), item(35)]]])
  own.pruneOwnReplies([A + ':34'], local)
  t.absent(own.ownFor(focal, local).some((i) => i.seq === 34))
  t.ok(own.ownFor(focal, local).some((i) => i.seq === 35))
  registered.wipe()
  t.is(own.ownReplyCache.size, 0)
  for (const [start, end] of [
    ['  const load = useCallback', '  const loadMore ='],
    ['  const loadMore =', '  const loadChildren ='],
    ['  const loadChildren =', '  const toggleChildren =']
  ]) {
    const code = src.slice(src.indexOf(start), src.indexOf(end))
    t.ok(code.includes('pruneOwnReplies(index.replies, ownReplies.current)'), start)
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

test('quiet reads cannot cancel an initial or failed load and hide its cursor', async (t) => {
  for (const phase of ['loading', 'error']) {
    const { load, state, context } = await loading({ view: { phase } })
    await load(false, true)
    t.is(state.calls.length, 0)
    t.is(context.genRef.current, 0)
    t.is(state.patches.length, 0)
  }
})

test('quiet failures commit nothing and failed refreshes preserve branches', async (t) => {
  for (const options of [{ failure: true }, { throws: true }]) {
    const quiet = await loading(options)
    await quiet.load(false, true)
    t.alike(quiet.state.patches, [])
    const refresh = await loading(options)
    await refresh.load(true)
    t.is(refresh.context.viewRef.current.phase, 'ready')
    t.is(refresh.context.viewRef.current.error, 'Não foi possível atualizar a conversa.')
    t.alike(refresh.state.children.get(A + ':2'), [refresh.child])
    t.is(refresh.state.next.get(A + ':2'), 'old')
    t.alike(refresh.state.opened, [])
    const first = await loading({ ...options, view: { phase: 'loading' } })
    await first.load(true)
    t.is(first.context.viewRef.current.phase, 'error')
    t.is(first.context.viewRef.current.error, options.failure ? 'Esta conversa não está disponível.' : 'falhou')
  }
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

test('a branch page in flight across a refresh cannot land in or release the restarted branch', async (t) => {
  const { assembleThread, planPeeks } = await import('../src/thread.js')
  const { mergeChildren, withOwnReply } = await import('../src/threadRows.js')
  const parentKey = A + ':2'
  const state = { children: new Map(), next: new Map(), busy: new Set() }
  const gates = []
  const pages = { 'page-two': [B + ':7'], null: [B + ':5'] }
  const context = {
    full: true,
    genRef: { current: 1 },
    branchGen: { current: 0 },
    childRequests: { current: new Map() },
    setChildBusy: (update) => { state.busy = update(state.busy) },
    setChildren: (update) => { state.children = update(state.children) },
    setChildNext: (update) => { state.next = update(state.next) },
    setChildErrors: (update) => { state.errors = update(state.errors || new Map()) },
    fetchPost: (key, cursor) => new Promise((resolve) => gates.push(() => resolve({ ok: true, value: { ref: key, parent: null, replies: pages[cursor], next: cursor === null ? 'page-two' : 'page-three', repliesTotal: 3 } }))),
    assembleThread,
    planPeeks,
    mergeChildren,
    withOwnReply,
    ownFor: () => [],
    pruneOwnReplies: () => {},
    peekedRef: { current: new Map() },
    followsRef: { current: Promise.resolve(new Set()) },
    ownReplies: { current: new Map() },
    request: async () => {},
    readOwn: async () => {},
    peekAll: async (_request, _plan, peeked) => {
      peeked.set(B, { key: B, entries: [5, 7].map((seq) => ({ seq, record: { type: 'post', at: '2026-01-01', text: 'r' + seq, replyTo: { author: A, seq: 2 } } })) })
    },
    quotePlan: async () => [],
    knownAuthors: () => [],
    ownKey: A,
    learnPeeked: () => {},
    learnMany: () => {},
    resolveMany: () => {},
    setCount: () => {},
    readCounts: () => {},
    refOf: (author, seq) => author + ':' + seq,
    loadChildrenRef: { current: null },
    setNote: () => {},
    errorText: (err) => err.message
  }
  const load = handler(src, '  const loadChildren = async', '  const toggleChildren =', 'loadChildren', context)
  const older = load(parentKey, 'page-two')
  // The refresh succeeds: it drops the branches and restarts the open one.
  context.childRequests.current.clear()
  context.branchGen.current += 1
  state.children = new Map()
  state.next = new Map()
  state.busy = new Set()
  const restarted = load(parentKey)
  t.is(gates.length, 2, 'the restarted branch is not mistaken for the request in flight')
  gates[1]()
  await restarted
  gates[0]()
  await older
  t.alike(state.children.get(parentKey).map((row) => row.seq), [5])
  t.is(state.next.get(parentKey), 'page-two', 'the next page is not skipped')
  const again = load(parentKey, 'page-two')
  t.is(gates.length, 3, 'the older page did not leave the branch marked as loading')
  gates[2]()
  await again
})

test('the refresh reset and the focal reset retire branch pages in flight', (t) => {
  t.is(src.split('branchGen.current += 1').length - 1, 2)
  t.ok(src.includes('childRequests.current.clear()\n        branchGen.current += 1'))
  t.ok(src.includes('const alive = () => mine === genRef.current && branch === branchGen.current'))
})
