'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { compileFunction, runInNewContext } = require('node:vm')
const { displayText } = require('@varanda/rpc')
const read = (file) => readFileSync(join(__dirname, '../src', file), 'utf8')
const source = read('screens/Grupo.js')
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const key = A + ':1'
const secondKey = B + ':2'
const initial = [{ emoji: '❤️', count: 2, mine: true }]
const deferred = () => {
  const result = {}
  const promise = new Promise((resolve, reject) => { result.resolve = resolve; result.reject = reject })
  return { ...result, promise }
}

// Run the actual screen handlers with only their React state and RPC boundary replaced.
async function harness (request, { batchStore = false } = {}) {
  const { toggleOf, applyOptimistic } = await import('../src/reactions.js')
  const { whoOf, UNNAMED } = await import('../src/who.js')
  const { applyPage, EMPTY_PAGES } = await import('../src/groups.js')
  const context = runInNewContext(source.match(/const reactionContext = useMemo\(\(\) => (\(.*\)), \[/)[1])
  const rawItems = [{ writer: A, seq: 1, diary: A, reactions: initial }, { writer: B, seq: 2, diary: B, reactions: [] }]
  const view = { disabled: false, rawById: new Map([[key, rawItems[0]], [secondKey, rawItems[1]]]), overrides: new Map(), picker: null, whoOpen: false }
  const state = { error: '', who: null, store: EMPTY_PAGES, resolved: [], storeUpdates: [] }
  const profiles = new Map([[A, { name: 'Ana\u202e' }]])
  const names = { profileOf: (diary) => profiles.get(diary), resolveMany: (keys) => state.resolved.push(keys) }
  const contextRef = { current: context }
  const deps = {
    reactionContext: context,
    reactionContextRef: contextRef,
    reactionViewRef: { current: view },
    setReactionOverrides: (update) => { view.overrides = update(view.overrides); state.sendingAtRender = context.sending.size },
    setReactionError: (error) => { state.error = error },
    setWhoReacted: (rows) => { state.who = rows },
    setReactionPicker: (key) => { view.picker = key },
    setStore: (update) => { if (batchStore) state.storeUpdates.push(update); else state.store = update(state.store) },
    setMeta: () => {},
    setPageRole: () => {},
    useCallback: (fn) => fn,
    asPage: { page: false },
    node: {},
    applyPage,
    EMPTY_PAGES,
    request,
    group: 'ef'.repeat(32),
    toggleOf,
    applyOptimistic,
    errorText: (err) => displayText(err.message),
    namesRef: { current: names },
    rawItems,
    whoOf,
    UNNAMED,
    displayText
  }
  const readStart = source.indexOf('  const commitRead =')
  const readEnd = source.indexOf('  // The call carries', readStart)
  const start = source.indexOf('  function openReactionPicker (')
  const end = source.indexOf('  if (!hosted) {', start)
  const handlers = compileFunction(source.slice(readStart, readEnd) + source.slice(start, end) + '\nreturn { toggleReaction, showReactors, openReactionPicker, readGroup, commitRead, readNewest }', Object.keys(deps))(...Object.values(deps))
  const renderStart = source.indexOf('  const whoReactedRows =')
  const render = compileFunction(source.slice(renderStart, start) + '\nreturn whoReactedRows', ['whoReacted', 'names', 'rawItems', 'whoOf', 'UNNAMED', 'displayText'])
  const flushStore = () => { for (const update of state.storeUpdates.splice(0)) state.store = update(state.store) }
  return { ...handlers, context, contextRef, state, view, profiles, flushStore, renderWho: () => render(state.who, names, rawItems, whoOf, UNNAMED, displayText) }
}

test('Grupo wires the existing bubble slots and closes the actions sheet before another sheet', (t) => {
  const bubble = read('ui/Bubble.js')
  t.ok(bubble.includes('actionsTitle, actionsHeader, onOpenMention'))
  t.ok(bubble.includes('actions={rows} header={actionsHeader}'))
  t.ok(source.includes('below={<ReactionChips reactions={reactionsFor(row)}'))
  t.ok(source.includes('disabled={reactionsDisabled || reactionContext.sending.has(row.key) || reactionContext.unsure.has(row.key)}'))
  t.ok(source.includes('onToggle={(emoji) => toggleReaction(row.key, emoji)}'))
  t.ok(source.includes('onShowWho={(emoji) => showReactors(row.key, emoji)}'))
  t.ok(source.includes('onShowWho={(emoji) => showReactors(row.key, emoji)} overlap />}'), 'group chips sit on the bubble corner')
  const chipsAt = source.indexOf('below={<ReactionChips')
  t.absent(source.slice(chipsAt, source.indexOf('\n', chipsAt)).includes('labelOf='), 'group chips keep the default wording')
  t.ok(source.includes('actionsHeader={!row.hidden && !reactionsDisabled && !reactionContext.sending.has(row.key) && !reactionContext.unsure.has(row.key)'))
  t.ok(source.includes('({ closeThen }) => <QuickReactions'))
  t.ok(source.includes('onPick={(emoji) => closeThen(() => toggleReaction(row.key, emoji))}'))
  t.ok(source.includes('onMore={() => closeThen(() => openReactionPicker(row.key))}'))
  t.ok(source.includes('setReactionPicker(null); if (key !== null) toggleReaction(key, emoji)'))
  t.ok(source.includes("label: 'Ver quem reagiu', disabled: reactionsDisabled || reactionContext.sending.has(row.key) || reactionContext.unsure.has(row.key), onPress: () => showReactors(row.key)"))
  t.ok(source.includes('open={reactionPicker !== null && !reactionsDisabled && !reactionContext.sending.has(reactionPicker) && !reactionContext.unsure.has(reactionPicker)}'))
  t.ok(source.includes('const reactionsFor = (row) => row.hidden ? []'))
  t.ok(source.includes('<ErrorText>{reactionError}</ErrorText>'))
  t.ok(source.includes('<WhoReacted open={whoReacted !== null && !reactionsDisabled}'))
  t.ok(source.includes('reactionOverrides, reactionsDisabled }}'), 'list updates its slots when capability changes')
})

test('reaction capability disables offline, locked, rekeying and page identities', (t) => {
  const expression = source.match(/const reactionsDisabled = (.+)/)[1]
  const disabled = runInNewContext('(node, meta, asPage, reader, orphan, info, canWriteHere) => ' + expression)
  const node = { online: true, passkey: { status: { unlocked: true } } }
  const check = (n = node, state = 'ok', page = false, reader = true, orphan = false, canWrite = true) => disabled(n, { state }, { page }, reader, orphan, {}, () => canWrite)
  t.is(check(), false)
  t.ok(check({ ...node, online: false }))
  t.ok(check({ ...node, passkey: { status: { unlocked: false } } }))
  t.ok(check(node, 'locked'))
  t.ok(check(node, 'rekey-pending'))
  t.ok(check(node, 'ok', true))
  t.ok(check(node, 'ok', false, false))
  t.ok(check(node, 'ok', false, true, true))
  t.ok(check(node, 'ok', false, true, false, false))
})

test('toggle uses one flight per message and keeps successful overrides without reading', async (t) => {
  const pending = deferred()
  const calls = []
  const canonical = { items: [{ writer: A, seq: 1 }, { writer: B, seq: 2 }] }
  const h = await harness(async (method, params) => {
    calls.push({ method, params })
    return method === 'group.react' ? pending.promise : canonical
  })
  const first = h.toggleReaction(key, '👍')
  t.alike(h.view.overrides.get(key), [{ emoji: '❤️', count: 1, mine: false }, { emoji: '👍', count: 1, mine: true }])
  await h.toggleReaction(key, '😂')
  t.is(calls.length, 1, 'a second tap cannot race the first write')
  const second = h.toggleReaction(secondKey, '😂')
  t.is(calls.length, 2, 'another message is independent')
  t.alike(calls[0], { method: 'group.react', params: { group: 'ef'.repeat(32), target: { writer: A, seq: 1 }, emoji: '👍' } })
  pending.resolve({ ok: true })
  await Promise.all([first, second])
  t.is(calls.filter((c) => c.method === 'group.read').length, 0, 'success never reads or discards loaded pages')
  t.alike(h.state.store.pages, [])
  t.is(h.view.overrides.size, 2, 'successful writes keep this device\'s known summaries')
  t.is(h.context.sending.size, 0)
  t.is(h.state.sendingAtRender, 0, 'settling schedules a render to enable the chips again')
})

test('a failed uncertain toggle without a prior override removes it and reads once without retrying', async (t) => {
  const pending = deferred()
  const calls = []
  const h = await harness((method, params) => {
    calls.push({ method, params })
    return method === 'group.react' ? pending.promise : Promise.resolve({ items: [] })
  })
  const running = h.toggleReaction(key, '❤️')
  t.is(calls[0].params.emoji, '', 'own chip removes the reaction')
  t.alike(h.view.overrides.get(key), [{ emoji: '❤️', count: 1, mine: false }])
  pending.reject(Object.assign(new Error('aguardando nova chave'), { uncertain: true }))
  await running
  t.absent(h.view.overrides.has(key), 'a message without a prior override returns to its read summary')
  t.is(h.state.error, 'aguardando nova chave')
  t.alike(calls.map((c) => c.method), ['group.react', 'group.read'])
  t.is(h.context.sending.size, 0)
  await Promise.resolve()
  t.alike(h.state.store.pages, [{ items: [], next: null }], 'the failure uses the ordinary newest read path')
})

test('a failed tap restores the exact override from a previous successful reaction', async (t) => {
  const calls = []
  const h = await harness(async (method) => {
    calls.push(method)
    if (calls.length === 1) return { ok: true }
    throw new Error(method === 'group.react' ? 'tempo esgotado' : 'sem conexão')
  })
  await h.toggleReaction(key, '👍')
  const before = h.view.overrides.get(key)
  await h.toggleReaction(key, '😂')
  t.is(h.view.overrides.get(key), before, 'the successful override survives the failed replacement')
  t.is(h.state.error, 'tempo esgotado', 'the refresh failure does not replace the refusal')
  t.alike(calls, ['group.react', 'group.react', 'group.read'], 'no write is retried')
})

test('a failed tap waits for its refresh and stays unpressable until a later read commits', async (t) => {
  const refresh = deferred()
  const started = deferred()
  const calls = []
  const h = await harness((method) => {
    calls.push(method)
    if (method === 'group.react') return Promise.reject(new Error('tempo esgotado'))
    started.resolve()
    return refresh.promise
  })
  const running = h.toggleReaction(key, '👍')
  await started.promise
  await Promise.resolve()
  t.ok(h.context.sending.has(key), 'the flight includes the recovery read')
  await h.toggleReaction(key, '❤️')
  h.openReactionPicker(key)
  await h.showReactors(key)
  t.is(h.view.picker, null)
  t.alike(calls, ['group.react', 'group.read'], 'no interaction races the refresh')
  refresh.reject(new Error('sem conexão'))
  await running
  t.absent(h.context.sending.has(key))
  await h.toggleReaction(key, '❤️')
  h.openReactionPicker(key)
  await h.showReactors(key)
  t.is(h.view.picker, null, 'a failed refresh leaves the picker blocked')
  t.alike(calls, ['group.react', 'group.read'], 'a failed refresh leaves all callbacks blocked')
  const chipExpression = source.match(/below=.*?disabled=\{([^}]+)\}/)[1]
  const disabled = compileFunction('return ' + chipExpression, ['reactionsDisabled', 'reactionContext', 'row'])
  t.ok(disabled(false, h.context, { key }), 'chips retain the disabled presentation after sending ends')
  const canonical = { items: [{ writer: A, seq: 1, reactions: [{ emoji: '👍', count: 1, mine: true }] }] }
  h.context.readStarts.set(canonical, ++h.context.read)
  h.commitRead(canonical, null)
  t.absent(disabled(false, h.context, { key }), 'a committed post-failure read enables the chips')
  t.absent(h.view.overrides.has(key))
  h.openReactionPicker(key)
  t.is(h.view.picker, key, 'the picker opens after recovery')
})

test('a read started before failure cannot enable reactions but a later older page can', async (t) => {
  const pending = deferred()
  const calls = []
  let readResult = pending.promise
  const h = await harness((method) => {
    calls.push(method)
    return method === 'group.react' ? Promise.reject(new Error('tempo esgotado')) : readResult
  })
  const earlier = h.readNewest()
  readResult = Promise.reject(new Error('sem conexão'))
  await h.toggleReaction(key, '👍')
  const cursor = { writer: A, seq: 1, at: '2026-11-12T12:00:00.000Z' }
  pending.resolve({ items: [h.view.rawById.get(key)], next: cursor })
  await earlier
  const count = calls.length
  h.openReactionPicker(key)
  t.is(h.view.picker, null, 'an old read cannot clear the unsure guard')
  await h.toggleReaction(key, '❤️')
  t.is(calls.length, count, 'a tap stays blocked after the old read commits')
  readResult = Promise.resolve({ items: [h.view.rawById.get(key)] })
  const later = await h.readGroup(cursor)
  h.openReactionPicker(key)
  t.is(h.view.picker, null, 'receiving a read alone does not release the guard')
  h.commitRead(later, cursor)
  h.openReactionPicker(key)
  t.is(h.view.picker, key, 'a committed older page started after failure releases its message')
})

test('a batched newest commit followed by a stale older page keeps the newest thread', async (t) => {
  const h = await harness(async () => {}, { batchStore: true })
  const cursor = { writer: A, seq: 1, at: '2026-11-12T12:00:00.000Z' }
  h.commitRead({ items: [h.view.rawById.get(key)], next: cursor }, null)
  h.flushStore()
  const prior = h.state.store
  const newest = { items: [h.view.rawById.get(secondKey)], next: { ...cursor, seq: 2 } }
  h.commitRead(newest, null)
  h.commitRead({ items: [h.view.rawById.get(key)] }, cursor)
  t.is(h.state.store, prior, 'both updaters wait for the same render')
  h.flushStore()
  t.alike(h.state.store.pages, [{ items: newest.items, next: newest.next }], 'the newest page survives the obsolete continuation')
  t.is(h.state.store.next, newest.next, 'scrolling can request the new continuation')
  t.is(h.state.store.stale, false)
})

test('disabled, hidden and stale message callbacks send nothing', async (t) => {
  const calls = []
  const h = await harness((...args) => { calls.push(args) })
  h.view.disabled = true
  await h.toggleReaction(key, '👍')
  await h.showReactors(key)
  h.view.disabled = false
  h.view.rawById.get(key).hidden = true
  await h.toggleReaction(key, '👍')
  await h.showReactors(key)
  h.view.rawById.get(key).hidden = false
  h.contextRef.current = {}
  await h.toggleReaction(key, '👍')
  await h.showReactors(key)
  t.alike(calls, [])
})

test('reactors keep keys, resolve unknown profiles and render arriving names with the full count', async (t) => {
  const { whoLines } = await import('../src/reactions.js')
  const pending = deferred()
  const calls = []
  const h = await harness((method, params) => { calls.push({ method, params }); return pending.promise })
  const running = h.showReactors(key, '❤️')
  await h.showReactors(key, '❤️')
  t.is(calls.length, 1)
  t.alike(calls[0], { method: 'group.reactors', params: { group: 'ef'.repeat(32), target: { writer: A, seq: 1 } } })
  pending.resolve({ reactions: [{ emoji: '❤️', count: 5, by: [A, B] }, { emoji: '👍', count: 1, by: [B] }] })
  await running
  t.alike(h.state.who, [{ emoji: '❤️', count: 5, by: [A, B] }])
  t.alike(h.state.resolved, [[B]], 'only unknown keys use the existing names resolver')
  t.alike(whoLines(h.renderWho()[0].names, h.state.who[0].count), ['Ana�', 'Pessoa', 'e mais 3'])
  h.profiles.set(B, { name: 'Bia\u202e' })
  t.alike(h.renderWho()[0].names, ['Ana�', 'Bia�'], 'names are derived again on render')
  t.ok(source.includes('rows={whoReactedRows}'))
  t.is(h.context.reading.size, 0)
})

test('late reactor answers cannot replace the latest message or reopen a closed sheet', async (t) => {
  const first = deferred()
  const second = deferred()
  const h = await harness((method, params) => params.target.writer === A ? first.promise : second.promise)
  const a = h.showReactors(key)
  const b = h.showReactors(secondKey)
  second.resolve({ reactions: [{ emoji: '👍', count: 1, by: [B] }] })
  await b
  first.resolve({ reactions: [{ emoji: '❤️', count: 1, by: [A] }] })
  await a
  t.is(h.state.who[0].emoji, '👍')
  const pending = deferred()
  const closed = await harness(() => pending.promise)
  const c = closed.showReactors(key)
  closed.context.who++
  pending.resolve({ reactions: [{ emoji: '❤️', count: 1, by: [A] }] })
  await c
  t.is(closed.state.who, null)
})

test('reactors for a superseded message stay closed while the current request is pending', async (t) => {
  const first = deferred()
  const second = deferred()
  const h = await harness((method, params) => params.target.writer === A ? first.promise : second.promise)
  const a = h.showReactors(key)
  const b = h.showReactors(secondKey)
  first.resolve({ reactions: [{ emoji: '❤️', count: 1, by: [A] }] })
  await a
  t.is(h.state.who, null)
  second.resolve({ reactions: [{ emoji: '👍', count: 1, by: [B] }] })
  await b
  t.is(h.state.who[0].emoji, '👍')
})

test('a successful toggle preserves older pages and leaves subsequent reads to the normal path', async (t) => {
  const calls = []
  const h = await harness(async (method) => {
    calls.push(method)
    if (method === 'group.read') throw new Error('sem conexão')
    return { ok: true }
  })
  const pages = [{ items: [h.view.rawById.get(secondKey)] }, { items: [h.view.rawById.get(key)] }]
  h.state.store = { pages, next: null }
  await h.toggleReaction(key, '👍')
  t.alike(calls, ['group.react'])
  t.is(h.state.store.pages, pages, 'older pages survive a successful toggle')
  t.ok(h.view.overrides.get(key).some((r) => r.emoji === '👍' && r.mine))
  t.is(h.state.error, '')
  t.is(h.context.sending.size, 0)
})

test('sender drops a spoiler link snapshot before creating or uploading its card', async (t) => {
  const { hasRich, parseRich } = await import('../src/richText.js')
  const rich = read('ui/RichText.js')
  const helper = rich.slice(rich.indexOf('export function cardBesideSpoilers'), rich.indexOf('// blocks: the parse'))
  const cardBesideSpoilers = runInNewContext(helper.replace('export ', '') + '\ncardBesideSpoilers', { URL })
  const start = source.indexOf('    let snapshot = heldCard')
  const end = source.indexOf('    let card =', start)
  t.ok(start >= 0 && end > start)
  const prepare = runInNewContext('(text, heldCard, info, linkDraft, hasRich, parseRich, cardBesideSpoilers) => {\n' + source.slice(start, end) + '\nreturn snapshot\n}')
  const snapshot = { url: 'https://example.org' }
  const take = (text) => prepare(text, undefined, {}, { take: () => snapshot }, hasRich, parseRich, cardBesideSpoilers)
  t.is(take('a ||https://example.org|| b'), null)
  t.is(take('a https://example.org b'), snapshot)
  t.is(take('||segredo|| https://example.org'), snapshot)
  t.ok(source.indexOf('cardBesideSpoilers(blocks, { url: snapshot.url })') < source.indexOf('cardForSend(snapshot,'))
})

test('only a read started after settlement can clear an override, on newest and older pages', async (t) => {
  const pending = deferred()
  const cursor = { writer: A, seq: 1, at: '2026-11-12T12:00:00.000Z' }
  let readResult = pending.promise
  const h = await harness((method) => {
    if (method === 'group.react') return Promise.resolve({ ok: true })
    return readResult
  })
  const earlier = h.readNewest()
  await h.toggleReaction(key, '👍')
  await h.toggleReaction(secondKey, '😂')
  t.is(h.context.settled.get(key), 1, 'the read start counter is captured at settlement')
  pending.resolve({ items: [h.view.rawById.get(key)], next: cursor })
  await earlier
  t.ok(h.view.overrides.has(key), 'a pre-append read landing last cannot clear the override')
  readResult = Promise.resolve({ items: [h.view.rawById.get(key)], next: cursor })
  await h.readNewest()
  t.absent(h.view.overrides.has(key), 'a later newest read clears its override')
  t.ok(h.view.overrides.has(secondKey), 'an absent message keeps its override')
  readResult = Promise.resolve({ items: [h.view.rawById.get(secondKey)] })
  const older = await h.readGroup(cursor)
  h.commitRead(older, cursor)
  t.absent(h.view.overrides.has(secondKey), 'a later older read clears its override')
  t.is(h.state.store.pages.length, 2, 'the ordinary older-page commit appends the page')
  const loadOlder = source.slice(source.indexOf('  const loadOlder ='), source.indexOf('  const rawItems ='))
  t.ok(loadOlder.includes('commitRead(read, before)'), 'older pages use the same commit guard')
})

test('commitRead keeps overrides while their message is sending', async (t) => {
  const h = await harness(async () => ({ items: [{ writer: A, seq: 1 }] }))
  h.view.overrides.set(key, initial)
  h.context.settled.set(key, 0)
  h.context.sending.add(key)
  const read = await h.readGroup()
  h.commitRead(read, null)
  t.ok(h.view.overrides.has(key), 'the real commitRead respects the in-flight guard')
  h.context.sending.delete(key)
  h.commitRead(read, null)
  t.absent(h.view.overrides.has(key))
})

test('late reactors cannot stack over another reaction sheet or open for a missing message', async (t) => {
  for (const change of [
    (h) => h.openReactionPicker(secondKey),
    (h) => { h.openReactionPicker(secondKey); h.view.picker = null },
    (h) => { h.view.picker = secondKey },
    (h) => { h.view.whoOpen = true },
    (h) => h.view.rawById.delete(key),
    (h) => { h.view.rawById.get(key).hidden = true }
  ]) {
    const pending = deferred()
    const h = await harness(() => pending.promise)
    const running = h.showReactors(key)
    change(h)
    pending.resolve({ reactions: [{ emoji: '👍', count: 1, by: [A] }] })
    await running
    t.is(h.state.who, null)
  }
})
