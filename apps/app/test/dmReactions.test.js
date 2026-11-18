'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const load = () => import('../src/dm-screen.js')
const screen = () => readFileSync(join(__dirname, '../src/screens/Mensagem.js'), 'utf8')

function fakeClock () {
  let now = 0
  let id = 0
  const timers = new Map()
  return {
    setTimeout (run, ms) { timers.set(++id, { at: now + ms, run }); return id },
    clearTimeout (id) { timers.delete(id) },
    tick (ms) {
      now += ms
      for (const [id, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.run()
      }
    }
  }
}

// The read-position names the screen's reads use (readPosition.js).
function openNames () {
  return { openLatch: { current: null }, openScope: { current: '' }, latchOpen: (latch) => latch, setOpenFailed () {} }
}

test('DM reactions preserve both people and aggregate through the shared chips', async (t) => {
  const { dmReactions, threadRows } = await load()
  const { reactionChips, applyOptimistic, toggleOf } = await import('../src/reactions.js')
  const reactions = [{ emoji: '❤️', mine: false }, { emoji: '❤️', mine: true }]
  const rows = threadRows([{ from: 'peer', id: 'one', reactions }])
  t.alike(rows[0].reactions, dmReactions(reactions))
  t.alike(reactionChips(rows[0].reactions).map(({ emoji, count, mine }) => ({ emoji, count, mine })), [{ emoji: '❤️', count: 2, mine: true }])
  t.alike(applyOptimistic(rows[0].reactions, toggleOf(rows[0].reactions, '❤️')), [{ emoji: '❤️', count: 1, mine: false }])
  t.alike(dmReactions(null), [])
  t.alike(dmReactions([null, {}, { emoji: '' }]), [])
  t.alike(threadRows([{ id: 'plain' }])[0].reactions, [])
})

test('reaction debounce sends only the last choice after 600 ms per message', async (t) => {
  const { reactDebounce } = await load()
  const clock = fakeClock()
  const debounce = reactDebounce(undefined, clock)
  const sent = []
  debounce.schedule('a', '', '❤️', (emoji) => sent.push(['a', emoji]))
  clock.tick(500)
  debounce.schedule('a', '❤️', '👍', (emoji) => sent.push(['a', emoji]))
  debounce.schedule('b', '', '😂', (emoji) => sent.push(['b', emoji]))
  clock.tick(599)
  t.alike(sent, [])
  t.ok(debounce.has('a'))
  clock.tick(1)
  t.alike(sent, [['a', '👍'], ['b', '😂']])
  t.absent(debounce.has('a'))
  clock.tick(6000)
  t.is(sent.length, 2, 'nothing retries on its own')
})

test('reaction debounce spends nothing on net no-ops and flushes on teardown', async (t) => {
  const { reactDebounce } = await load()
  const clock = fakeClock()
  const debounce = reactDebounce(600, clock)
  let sent = 0
  let cancelled = 0
  const send = () => { sent++ }
  const cancel = () => { cancelled++ }
  for (const [starting, middle] of [['', '❤️'], ['❤️', '👍']]) {
    debounce.schedule('a', starting, middle, send, cancel)
    debounce.schedule('a', middle, starting, send, cancel)
    clock.tick(600)
  }
  t.is(sent, 0)
  t.is(cancelled, 2)
  debounce.schedule('a', '', '❤️', send, cancel)
  debounce.schedule('b', '', '👍', send, cancel)
  debounce.schedule('c', '😂', '👍', send, cancel)
  debounce.schedule('c', '👍', '😂', send, cancel)
  debounce.flush()
  clock.tick(6000)
  t.is(sent, 2)
  t.is(cancelled, 3)
  t.absent(debounce.has('a'))
})

// Execute the screen's handlers themselves, with only their I/O and hook setters supplied.
async function screenReactions (request, reactions = []) {
  const { dmReactions, reactDebounce, messageKey, dmReactable, withFreshReactions, olderPagesToReread, reactionTap, PAGE_REACTION_HELD } = await load()
  const { applyOptimistic, toggleOf } = await import('../src/reactions.js')
  const clock = fakeClock()
  const item = { from: 'peer', id: 'one', reactions }
  const key = messageKey(item)
  const context = { live: true, sending: new Set(), unsure: new Map(), removed: new Map(), retries: new Map(), settled: new Map(), bases: new Map(), overrides: new Map(), read: 0, debounce: reactDebounce(600, clock) }
  const state = { errors: [], reads: 0, painted: new Map() }
  const env = {
    reactionContext: context,
    reactionContextRef: { current: context },
    reactionViewRef: { current: { disabled: false, dispatchDisabled: false, rawById: new Map([[key, item]]) } },
    reactionOverrides: new Map(),
    dmReactions,
    dmReactable,
    withFreshReactions,
    olderPagesToReread,
    reactionTap,
    PAGE_REACTION_HELD,
    applyOptimistic,
    toggleOf,
    messageKey,
    peer: 'peer',
    request,
    dm: request,
    unsureSend: (err) => err.uncertain === true || err.message === 'não deu para confirmar o envio',
    errorText: (err) => err.message,
    setReactionOverrides: (rows) => { state.painted = rows },
    setReactionError: (text) => state.errors.push(text),
    setReactionPicker: () => {},
    readThread: async () => { state.reads++ },
    rawRef: { current: [item] },
    setRaw: (rows) => { env.rawRef.current = rows },
    useCallback: (fn) => fn
  }
  context.view = env.reactionViewRef.current
  const src = screen()
  const handlers = src.slice(src.indexOf('  const reactionRowReady ='), src.indexOf('  const ready = hosted'))
  const commit = src.slice(src.indexOf('  const commitRead ='), src.indexOf('  const readThread ='))
  const run = runInNewContext(handlers + commit + '\n;({ toggleReaction, canReact, commitRead })', env)
  return { ...run, context, clock, state, env, key, item }
}

const settled = () => new Promise((resolve) => setImmediate(resolve))

test('screen collapses taps, blocks in-flight changes and rereads after one send', async (t) => {
  const sent = []
  let finish
  const h = await screenReactions((method, params) => {
    sent.push({ method, params })
    return new Promise((resolve) => { finish = resolve })
  })
  h.toggleReaction(h.key, '❤️')
  h.toggleReaction(h.key, '👍')
  t.is(h.state.painted.get(h.key)[0].emoji, '👍', 'optimistic choice changes before the request')
  h.commitRead([h.item], ++h.context.read, h.context)
  t.is(h.state.painted.get(h.key)[0].emoji, '👍', 'a read during the debounce keeps the choice')
  h.clock.tick(600)
  t.alike(JSON.parse(JSON.stringify(sent)), [{ method: 'dm.react', params: { to: 'peer', target: { from: 'peer', id: 'one' }, emoji: '👍' } }])
  h.toggleReaction(h.key, '😂')
  h.clock.tick(600)
  t.is(sent.length, 1, 'no parallel mutation on one message')
  t.absent(h.canReact(h.key))
  h.commitRead([h.item], ++h.context.read, h.context)
  t.is(h.state.painted.get(h.key)[0].emoji, '👍', 'a read during the send keeps the choice')
  finish({ ok: true })
  await settled()
  t.is(h.state.reads, 1)
  t.ok(h.canReact(h.key))
  h.commitRead([{ ...h.item, reactions: [{ emoji: '👍', mine: true }] }], ++h.context.read, h.context)
  t.absent(h.state.painted.has(h.key), 'fresh success read replaces the override')
})

test('screen net no-op and capability loss cancel without spending stamps', async (t) => {
  const sent = []
  const h = await screenReactions((...args) => { sent.push(args) })
  h.toggleReaction(h.key, '❤️')
  h.toggleReaction(h.key, '❤️')
  h.clock.tick(600)
  t.alike(sent, [])
  t.alike(h.state.painted.get(h.key), [])
  h.toggleReaction(h.key, '👍')
  h.env.reactionViewRef.current.disabled = true
  h.env.reactionViewRef.current.dispatchDisabled = true
  h.clock.tick(600)
  t.alike(sent, [], 'rechecks capability at dispatch')
  t.alike(h.state.painted.get(h.key), [])
  h.env.reactionViewRef.current.disabled = false
  h.env.reactionViewRef.current.dispatchDisabled = false
  h.item.deleted = true
  t.absent(h.canReact(h.key), 'deleted message')
})

test('screen refusals restore mine, retain new peer reactions and ignore pre-failure reads', async (t) => {
  let refuse
  const h = await screenReactions(() => new Promise((resolve, reject) => { refuse = reject }), [{ emoji: '❤️', mine: true }])
  h.toggleReaction(h.key, '👍')
  h.clock.tick(600)
  const oldRead = ++h.context.read
  h.item.reactions = [{ emoji: '❤️', mine: true }, { emoji: '😂', mine: false }]
  refuse(new Error('o limite de envio de hoje acabou'))
  await settled()
  t.alike(h.state.painted.get(h.key), [{ emoji: '❤️', count: 1, mine: true }, { emoji: '😂', count: 1, mine: false }])
  t.is(h.state.errors.at(-1), 'o limite de envio de hoje acabou')
  h.commitRead([{ ...h.item, reactions: [{ emoji: '👍', mine: true }] }], oldRead, h.context)
  t.is(h.state.painted.get(h.key)[0].emoji, '❤️', 'stale read cannot undo rollback')
  t.is(h.state.reads, 1)
  h.commitRead([h.item], ++h.context.read, h.context)
  t.absent(h.state.painted.has(h.key))
})

test('uncertain reactions allow only explicit retries, replacements and removal', async (t) => {
  const sent = []
  const h = await screenReactions(async (method, params) => {
    sent.push(params.emoji)
    throw Object.assign(new Error('não deu para confirmar o envio'), { uncertain: true })
  })
  h.toggleReaction(h.key, '❤️')
  h.clock.tick(600)
  await settled()
  t.is(h.context.unsure.get(h.key), '❤️')
  t.is(h.state.painted.get(h.key)[0].emoji, '❤️')
  t.is(h.state.errors.at(-1), '', 'uncertainty uses the quiet note, not a refusal')
  h.commitRead([h.item], h.context.read, h.context)
  t.ok(h.state.painted.has(h.key), 'a pre-answer read keeps optimism')
  t.ok(h.context.unsure.has(h.key))
  h.clock.tick(6000)
  t.alike(sent, ['❤️'], 'nothing retries without a tap')
  h.toggleReaction(h.key, '❤️')
  h.clock.tick(600)
  await settled()
  t.alike(sent, ['❤️', '❤️'], 'one tap resumes the same pending reaction exactly once')
  h.clock.tick(6000)
  t.is(sent.length, 2)
  h.toggleReaction(h.key, '👍')
  h.clock.tick(600)
  await settled()
  t.alike(sent, ['❤️', '❤️', '👍'])
  h.toggleReaction(h.key, '')
  h.clock.tick(600)
  await settled()
  t.alike(sent, ['❤️', '❤️', '👍', ''])
  h.commitRead([h.item], ++h.context.read, h.context)
  t.absent(h.state.painted.has(h.key), 'a read begun after the answer clears optimism')
  t.absent(h.context.unsure.has(h.key), 'a missing self copy also clears the quiet note')
  h.clock.tick(6000)
  t.is(sent.length, 4)
})

test('as a page, the retry of an unconfirmed reaction re-puts the same signed draft', async (t) => {
  const drafts = []
  let puts = 0
  const retry = async () => { puts++ }
  const h = await screenReactions(async (method, params) => {
    drafts.push(params.emoji)
    throw Object.assign(new Error('não deu para confirmar o envio'), { uncertain: true, retry })
  })
  h.toggleReaction(h.key, '❤️')
  h.clock.tick(600)
  await settled()
  t.alike(drafts, ['❤️'])
  t.is(h.context.retries.get(h.key), retry, 'the kept re-put')
  h.clock.tick(6000)
  t.is(puts, 0, 'nothing re-puts without a tap')
  h.toggleReaction(h.key, '❤️')
  h.clock.tick(600)
  await settled()
  t.alike(drafts, ['❤️'], 'no second draft')
  t.is(puts, 1, 'one tap re-puts the signed draft once')
  t.absent(h.context.retries.has(h.key), 'confirmed: nothing kept')
})

test('as a page, a held uncertain reaction locks its message until the retry settles it, past a thread read', async (t) => {
  const drafts = []
  let puts = 0
  const retry = async () => { puts++; throw Object.assign(new Error('não deu para confirmar o envio'), { uncertain: true, retry }) }
  const h = await screenReactions(async (method, params) => {
    drafts.push(params.emoji)
    throw Object.assign(new Error('não deu para confirmar o envio'), { uncertain: true, retry })
  })
  h.toggleReaction(h.key, '❤️')
  h.clock.tick(600)
  await settled()
  // The reread after the send does not drop the held state.
  h.commitRead([h.item], ++h.context.read, h.context)
  t.is(h.context.unsure.get(h.key), '❤️', 'still unsure after a read')
  h.toggleReaction(h.key, '👍')
  h.clock.tick(600)
  await settled()
  t.alike(drafts, ['❤️'], 'another emoji signs nothing')
  t.is(h.state.errors[h.state.errors.length - 1], 'Toque no mesmo emoji para tentar de novo.')
  h.toggleReaction(h.key, '❤️')
  h.clock.tick(600)
  await settled()
  t.is(puts, 1, 'the same emoji re-puts')
  t.ok(h.context.retries.has(h.key), 'uncertain again: still held')
  h.toggleReaction(h.key, '👍')
  h.clock.tick(600)
  await settled()
  t.alike(drafts, ['❤️'], 'still locked')
})

test('a tap on the removed emoji retries an unconfirmed removal instead of reacting again', async (t) => {
  const sent = []
  let unsure = true
  const h = await screenReactions(async (method, params) => {
    sent.push(params.emoji)
    if (unsure) throw Object.assign(new Error('não deu para confirmar o envio'), { uncertain: true })
    return { ok: true }
  }, [{ emoji: '\u2764\ufe0f', mine: true }])
  h.toggleReaction(h.key, '\u2764\ufe0f')
  h.clock.tick(600)
  await settled()
  t.alike(sent, [''], 'the removal went out')
  t.is(h.context.unsure.get(h.key), '')
  t.absent(h.state.painted.get(h.key).some((r) => r.mine), 'the chip stays removed')
  unsure = false
  h.toggleReaction(h.key, '\u2764\ufe0f')
  h.clock.tick(600)
  await settled()
  t.alike(sent, ['', ''], 'the same removal is retried, no new reaction')
  t.absent(h.context.unsure.has(h.key))
  t.absent(h.context.removed.has(h.key), 'a confirmed removal forgets the emoji it took away')
  h.toggleReaction(h.key, '\u{1f44d}')
  h.clock.tick(600)
  await settled()
  t.alike(sent, ['', '', '\u{1f44d}'], 'another emoji is a new reaction')
})

test('an unconfirmed removal is forgotten once a later op or a fresh read settles it', async (t) => {
  const unsure = async () => { throw Object.assign(new Error('não deu para confirmar o envio'), { uncertain: true }) }
  const removing = async () => {
    const h = await screenReactions(unsure, [{ emoji: '\u2764\ufe0f', mine: true }])
    h.toggleReaction(h.key, '\u2764\ufe0f')
    h.clock.tick(600)
    await settled()
    t.is(h.context.removed.get(h.key), '\u2764\ufe0f')
    return h
  }
  const a = await removing()
  a.toggleReaction(a.key, '\u{1f44d}')
  a.clock.tick(600)
  await settled()
  t.is(a.context.unsure.get(a.key), '\u{1f44d}', 'a new unconfirmed op')
  t.absent(a.context.removed.has(a.key), 'superseded: the removal is no longer the op to retry')
  const b = await removing()
  b.commitRead([b.item], ++b.context.read, b.context)
  t.absent(b.context.unsure.has(b.key))
  t.absent(b.context.removed.has(b.key), 'a fresh read settles it')
})

test('a thread read refreshes the newest held older pages, and deeper ones only with a change pending', async (t) => {
  const { olderPagesToReread, REREAD_OLDER_PAGES } = await load()
  t.is(REREAD_OLDER_PAGES, 3)
  const pages = new Map(['p1', 'p2', 'p3', 'p4', 'p5'].map((p) => [p, new Set([p + ':row'])]))
  t.alike(olderPagesToReread(pages, () => false).map(([b]) => b), ['p1', 'p2', 'p3'], 'newest first, capped')
  t.alike(olderPagesToReread(pages, (key) => key === 'p5:row').map(([b]) => b), ['p1', 'p2', 'p3', 'p5'], 'a deeper page with a pending change')
  t.alike(olderPagesToReread(new Map(), () => true), [])
})

test('a fresh read clears an uncertain reaction even when the own copy is absent', async (t) => {
  let sent = 0
  const h = await screenReactions(async () => {
    sent++
    throw Object.assign(new Error('não deu para confirmar o envio'), { uncertain: true })
  })
  h.toggleReaction(h.key, '❤️')
  h.clock.tick(600)
  await settled()
  t.ok(h.context.unsure.has(h.key))
  h.commitRead([h.item], ++h.context.read, h.context)
  t.absent(h.context.unsure.has(h.key))
  t.absent(h.state.painted.has(h.key))
  t.ok(h.canReact(h.key))
  h.clock.tick(6000)
  t.is(sent, 1, 'recovery does not send a request')
})

test('leaving flushes the last choice once, skips net no-ops and ignores late results', async (t) => {
  const src = screen()
  for (const unmount of [false, true]) {
    for (const noop of [false, true]) {
      const sent = []
      let refuse
      const h = await screenReactions((method, params) => {
        sent.push(params.emoji)
        return new Promise((resolve, reject) => { refuse = reject })
      })
      let cleanup
      const env = { ...h.env, isTop: false, reactionsDisabled: true, useEffect: (effect) => { cleanup = effect() } }
      if (unmount) {
        const start = src.indexOf('  useEffect(() => {\n    reactionContext.live = true')
        runInNewContext(src.slice(start, src.indexOf('  const [raw,', start)), env)
      }
      h.toggleReaction(h.key, '❤️')
      h.toggleReaction(h.key, noop ? '❤️' : '👍')
      h.clock.tick(100)
      if (unmount) cleanup()
      else {
        h.env.reactionViewRef.current.disabled = true
        const start = src.indexOf('  useEffect(() => {', src.indexOf('  reactionContext.view = reactionViewRef.current'))
        runInNewContext(src.slice(start, src.indexOf('  const reactionRowReady =', start)), env)
      }
      t.alike(sent, noop ? [] : ['👍'], unmount ? 'unmount' : 'covered screen')
      h.clock.tick(6000)
      t.is(sent.length, noop ? 0 : 1, 'the timer never resends the flush')
      const painted = h.state.painted
      if (refuse) {
        refuse(new Error('o limite de envio de hoje acabou'))
        await settled()
        if (unmount) {
          t.is(h.state.painted, painted, 'no state update after unmount')
          t.is(h.state.errors.at(-1), '')
          t.is(h.state.reads, 0)
        } else t.is(h.state.errors.at(-1), 'o limite de envio de hoje acabou')
      }
    }
  }
})

test('older reaction reads isolate a failed cursor and refresh the newest held pages and every page with a change pending', async (t) => {
  const { refreshThread, newestOf, messageKey } = await load()
  const rows = ['failed', 'debounced', 'deep', 'unsure', 'untouched', 'new'].map((id, i) => ({ from: 'peer', id, at: `2026-11-0${i + 1}T10:00:00Z`, text: id }))
  const h = await screenReactions(async () => ({}))
  // In load order, newest first, as loadOlder adds them.
  h.context.pages = new Map(rows.slice(0, -1).reverse().map((row) => [row.id, new Set([messageKey(row)])]))
  h.context.overrides.set(messageKey(rows[0]), [{ emoji: '❤️', mine: true }])
  h.context.debounce.schedule(messageKey(rows[1]), '', '👍', () => {})
  h.context.unsure.set(messageKey(rows[2]), '❤️')
  const rawRef = { current: rows.slice() }
  const cursors = []
  const errors = []
  const reads = []
  const env = {
    ...h.env,
    refreshThread,
    newestOf,
    messageKey,
    commitRead: h.commitRead,
    rawRef,
    olderRef: { current: true },
    olderErr: { current: false },
    ...openNames(),
    genRef: { current: 0 },
    dm: async (method, params) => {
      reads.push(params.before || 'newest')
      if (params.before === 'failed') throw new Error('offline')
      const row = params.before ? rows.find((row) => row.id === params.before) : rows.at(-1)
      return { messages: [{ ...row, reactions: [{ emoji: '👍', mine: false }] }], next: 'new-cursor' }
    },
    setRaw: (rows) => { rawRef.current = rows },
    setNext: (cursor) => cursors.push(cursor),
    setLoadError: (error) => errors.push(error),
    setNewest: () => {},
    setFolder: () => {},
    setBlocked: () => {},
    setLoaded: () => {},
    useCallback: (fn) => fn
  }
  const src = screen()
  const body = src.slice(src.indexOf('  const readThread ='), src.indexOf('  const reactionGate ='))
  const read = runInNewContext(body + '\n;readThread', env)
  await read()
  t.alike(reads, ['newest', 'untouched', 'unsure', 'deep', 'debounced', 'failed'], 'the newest three held pages, then the deeper ones with a change pending')
  t.alike(rawRef.current.map((m) => m.id), rows.map((m) => m.id))
  t.is(rawRef.current[0], rows[0], 'failed page stays as it was')
  t.ok(h.context.overrides.has(messageKey(rows[0])), 'failed page keeps its override')
  t.alike(rawRef.current[1].reactions, [{ emoji: '👍', mine: false }])
  t.alike(rawRef.current[3].reactions, [{ emoji: '👍', mine: false }])
  t.absent(h.context.unsure.has(messageKey(rows[3])))
  t.alike(rawRef.current[4].reactions, [{ emoji: '👍', mine: false }], 'the other person\'s reaction on a page with nothing pending shows without reopening')
  // A fourth held page with nothing pending waits for the reopening.
  h.context.pages.set('older', new Set(['peer:older']))
  reads.length = 0
  await read()
  t.absent(reads.includes('older'), 'past the newest three, a page with nothing pending is not read again')
  t.alike(cursors, [], 'keeps the older pagination cursor')
  t.alike(errors, ['', ''], 'no thread-level error for an older page')
  let fail
  let loaded = 0
  env.dm = () => new Promise((resolve, reject) => { fail = reject })
  env.setLoaded = () => { loaded++ }
  const pending = read()
  h.context.live = false
  fail(new Error('offline'))
  await pending
  t.alike(errors, ['', ''], 'a failed read after unmount changes no state')
  t.is(loaded, 0)
})

test('DM gate never hides by kind: a page takes reactions both ways', async (t) => {
  const { dmReactionGate } = await load()
  const { pageReadKind } = await import('../src/pageNotice.js')
  const gate = (input) => dmReactionGate({ ...input, peerKind: pageReadKind(input.read, input.peer) })
  const person = { page: 'peer', gen: null, owner: null, movedTo: null, closed: false, complete: true }
  const base = { read: person, peer: 'peer', pageKey: null, hosted: true, online: true, unlocked: true, isTop: true, blocked: false, folder: 'inbox' }
  const shown = { hidden: false, disabled: false }
  const disabled = { hidden: false, disabled: true }
  t.alike(gate(base), shown, 'complete person')
  t.alike(gate({ ...base, read: { ...person, complete: false } }), shown, 'incomplete person')
  t.alike(gate({ ...base, read: { ...person, complete: false, gen: 1 } }), shown, 'a page peer takes reactions')
  t.alike(gate({ ...base, pageKey: 'our-page' }), shown, 'acting as a page')
  t.alike(gate({ ...base, pageKey: 'our-page', read: null }), shown, 'acting as a page reads no peer')
  t.alike(gate({ ...base, pageKey: 'our-page', online: false }), disabled, 'acting as a page, offline')
  t.alike(gate({ ...base, pageKey: 'our-page', blocked: true }), disabled, 'acting as a page, blocked')
  for (const read of [undefined, null, { ...person, page: 'other' }]) {
    t.alike(gate({ ...base, read }), disabled, 'pending, failed or mismatched read')
  }
  for (const patch of [{ online: false }, { unlocked: false }, { hosted: false }, { isTop: false }, { blocked: true }, { folder: 'request' }, { folder: null }]) {
    t.alike(gate({ ...base, ...patch }), disabled, JSON.stringify(patch))
  }
  t.alike(gate({ ...base, hint: { page: true } }), shown, 'an index hint cannot hide a person')
})

test('peer reads are single flight, preserve answers on failure and retry only on explicit triggers', async (t) => {
  const { pageReadKind } = await import('../src/pageNotice.js')
  const src = screen()
  const body = src.slice(src.indexOf('  const readPeer ='), src.indexOf('  const [reactionOverrides,'))
  let calls = 0
  let finish
  let fail
  let effect
  const answers = []
  const context = { live: true, pending: false, answer: null, failures: 0, retry: null }
  const timers = []
  const env = {
    pageReadKind,
    peerReadDelay: (await load()).peerReadDelay,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => {},
    setPeerRetry: () => {},
    peerRetry: 0,
    peer: 'peer',
    peerReadContext: context,
    hosted: true,
    unlocked: true,
    pageKey: null,
    node: { online: true, visible: true },
    isTop: true,
    request: () => { calls++; return new Promise((resolve, reject) => { finish = resolve; fail = reject }) },
    setPeerRead: (read) => answers.push(read),
    useCallback: (fn) => fn,
    useEffect: (fn) => { effect = fn }
  }
  const read = runInNewContext(body + '\n;readPeer', env)
  effect()
  const pending = read()
  t.is(calls, 1, 'one request in flight')
  fail(new Error('offline'))
  await pending
  await settled()
  t.is(context.answer, null, 'thrown read remains unanswered')
  effect()
  t.is(calls, 2, 'visible unanswered conversation retries')
  finish({ page: 'other' })
  await settled()
  t.is(context.answer, null, 'mismatched answer remains unanswered')
  effect()
  finish({ page: 'peer', gen: null, owner: null, complete: false })
  await settled()
  t.is(answers.length, 1)
  effect()
  t.is(calls, 3, 'answered conversation does not read on return')
  env.node.online = false
  await read()
  env.node.online = true
  env.unlocked = false
  await read()
  t.is(calls, 3)
  t.is(context.answer, answers[0], 'offline and lock retain the last answer')
  env.unlocked = true
  const refresh = read()
  fail(new Error('busy'))
  await refresh
  t.is(context.answer, answers[0], 'failed refresh retains the last answer')
  t.absent(body.includes('node.dmVersion'))
  t.ok(src.includes('readLookup()\n    readPeer()'), 'pull to refresh triggers both reads')
})

test('DM source pins shared reaction UI, page checks, quiet uncertainty and spoiler cards', (t) => {
  const src = screen()
  t.ok(src.includes("request('page.read', { key: peer })"))
  t.ok(src.includes('const reactionGate = dmReactionGate({ read: peerRead, peer, peerKind: pageReadKind(peerRead, peer), pageKey, hosted, unlocked, online: node.online, isTop: true, blocked: blocked || blocks.has(peer), folder })'))
  t.ok(/actionsHeader=\{!reactionOff\s*\? \(\{ closeThen \}\) => <QuickReactions/.test(src))
  t.ok(src.includes('closeThen(() => toggleReaction(item.key, emoji))'))
  t.ok(src.includes('closeThen(() => openReactionPicker(item.key))'))
  t.ok(src.includes('below={chips.length > 0'))
  const chipsAt = src.indexOf('{chips.length > 0 ? <ReactionChips reactions={reactionsFor(item)} disabled={reactionOff} onToggle={(emoji) => toggleReaction(item.key, emoji)} labelOf={')
  t.ok(chipsAt > 0, 'chips sit on the bubble corner, gated by the same chips check')
  t.ok(src.slice(chipsAt, src.indexOf('\n', chipsAt)).endsWith(' overlap /> : null}'))
  t.ok(chipsAt < src.indexOf('<View style={styles.inline}>', chipsAt), 'the action pills stay in their own row under the chips')
  // The spoken label says whose reaction it is, through the shared chip.
  const shared = readFileSync(join(__dirname, '../src/ui/Reactions.js'), 'utf8')
  const spoken = shared.match(/accessibilityLabel=\{(displayText\(typeof labelOf[^\n]*\))\}\n/)
  t.ok(spoken, 'the shared chip speaks labelOf(chip) when given')
  const labelAt = src.indexOf('labelOf={', chipsAt)
  const labelOf = labelAt > 0 && labelAt < src.indexOf('\n', chipsAt)
    ? runInNewContext(src.slice(labelAt + 'labelOf={'.length, src.indexOf('} overlap />', labelAt)))
    : undefined
  const { displayText } = require('@varanda/rpc')
  const say = (chip) => spoken ? runInNewContext(spoken[1], { displayText, labelOf, chip }) : ''
  t.is(say({ label: 'curtir, 1 reação', mine: false, count: 1 }), 'curtir, 1 reação, da outra pessoa')
  t.is(say({ label: 'curtir, 2 reações, sua reação', mine: true, count: 2 }), 'curtir, 2 reações, sua reação, e da outra pessoa')
  t.is(say({ label: 'curtir, 1 reação, sua reação', mine: true, count: 1 }), 'curtir, 1 reação, sua reação')
  t.ok(shared.includes('accessibilityState={{ selected: chip.mine === true }}'))
  t.ok(readFileSync(join(__dirname, '../src/reactions.js'), 'utf8').includes("label + ', sua reação'"))
  t.absent(src.includes('onShowWho'))
  t.ok(src.includes('<ReactionPicker'))
  t.ok(src.includes('<Soft>Não deu para confirmar a reação.</Soft>'))
  t.ok(src.includes('reactionContext.debounce.clear()'))
  t.ok(src.includes('context.pages.set(cursor, new Set((r.messages || []).map(messageKey)))'))
  t.absent(src.includes('reactions={[chip]}') || src.includes('aria-hidden inert'), 'no hidden chip inside a second control')
  t.ok(/<PressScale\s+key=\{chip\.emoji\}/.test(shared), 'one accessible and keyboard-focusable chip control')
  t.ok(src.includes('const richBlocks = hasRich(text) ? parseRich(text) : null'))
  t.ok(src.includes('if (snapshot && cardBesideSpoilers(richBlocks, { url: snapshot.url }) === null) snapshot = null'))
})

test('a failed person lookup is retried with a growing wait until it answers', async (t) => {
  const { pageReadKind } = await import('../src/pageNotice.js')
  const { peerReadDelay } = await load()
  t.alike([0, 1, 2, 3, 4, 5, 9].map(peerReadDelay), [2000, 4000, 8000, 16000, 32000, 60000, 60000])
  const src = screen()
  const body = src.slice(src.indexOf('  const readPeer ='), src.indexOf('  const [reactionOverrides,'))
  const context = { live: true, pending: false, trailing: false, answer: null, failures: 0, retry: null }
  const clock = fakeClock()
  const answers = []
  let effect
  let retries = 0
  let calls = 0
  let ok = false
  const env = {
    peerReadDelay,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setPeerRetry: () => { retries++; effect() },
    peerRetry: 0,
    peer: 'peer',
    peerReadContext: context,
    hosted: true,
    unlocked: true,
    pageKey: null,
    node: { online: true, visible: true },
    isTop: true,
    request: async () => { calls++; if (!ok) throw new Error('offline'); return { page: 'peer', gen: null, owner: null, complete: false } },
    pageReadKind,
    setPeerRead: (read) => answers.push(read),
    useCallback: (fn) => fn,
    useEffect: (fn) => { effect = fn }
  }
  runInNewContext(body + '\n;readPeer', env)
  effect()
  await settled()
  t.is(calls, 1)
  clock.tick(1999)
  t.is(calls, 1, 'no tight loop')
  clock.tick(1)
  await settled()
  t.is(calls, 2, 'tried again after 2 s')
  clock.tick(3999)
  t.is(calls, 2)
  ok = true
  clock.tick(1)
  await settled()
  t.is(calls, 3, 'then after 4 s')
  t.is(answers.length, 1, 'the answer turns the reactions on')
  clock.tick(120000)
  await settled()
  t.is(calls, 3, 'an answered lookup is not repeated')
  t.is(retries, 2)
  t.is(context.failures, 0)
})

async function screenPeer (request) {
  const { pageReadKind } = await import('../src/pageNotice.js')
  const context = { live: true, pending: false, trailing: false, answer: null, failures: 0, retry: null }
  const answers = []
  const src = screen()
  const body = src.slice(src.indexOf('  const readPeer ='), src.indexOf('  const [reactionOverrides,'))
  const { peerReadDelay } = await load()
  const read = runInNewContext(body + '\n;readPeer', {
    peerReadDelay,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setPeerRetry: () => {},
    peerRetry: 0,
    peer: 'peer',
    peerReadContext: context,
    hosted: true,
    unlocked: true,
    pageKey: null,
    node: { online: true },
    isTop: true,
    request,
    pageReadKind,
    setPeerRead: (answer) => answers.push(answer),
    useCallback: (fn) => fn,
    useEffect: () => {}
  })
  return { read, context, answers }
}

test('a confirmed page keeps its answer after a refresh without head evidence', async (t) => {
  const { dmReactionGate } = await load()
  const { pageReadKind } = await import('../src/pageNotice.js')
  const page = { page: 'peer', gen: 1, owner: 'owner', complete: true }
  let answer = page
  const h = await screenPeer(async () => answer)
  await h.read()
  answer = { page: 'peer', gen: null, owner: null, complete: false }
  await h.read()
  t.is(h.context.answer, page, 'the confirmed answer is retained')
  t.is(h.answers.length, 1, 'the screen state retains its page evidence')
  t.alike(dmReactionGate({ read: h.answers.at(-1), peer: 'peer', peerKind: pageReadKind(h.answers.at(-1), 'peer'), hosted: true, unlocked: true, online: true, isTop: true, folder: 'inbox' }), { hidden: false, disabled: false })
  answer = { ...page, gen: 2 }
  await h.read()
  t.is(h.context.answer, answer, 'new page evidence replaces the previous answer')
})

test('refresh during a peer read gets one trailing read after throw or wrong peer', async (t) => {
  for (const wrongPeer of [false, true]) {
    const pending = []
    const h = await screenPeer(() => new Promise((resolve, reject) => pending.push({ resolve, reject })))
    const first = h.read()
    await h.read()
    await h.read()
    t.is(pending.length, 1, 'overlapping triggers do not start parallel reads')
    if (wrongPeer) pending[0].resolve({ page: 'other' })
    else pending[0].reject(new Error('offline'))
    await settled()
    t.is(pending.length, 2, 'refresh is retained after the unanswered read')
    if (pending[1]) {
      await h.read()
      pending[1].reject(new Error('offline'))
    }
    await first
    await settled()
    t.is(pending.length, 2, 'the trailing failure cannot loop, even with another trigger')
    t.absent(h.context.pending)
    t.is(h.context.answer, null)
  }
})

test('a successful peer read consumes overlapping refreshes without another read', async (t) => {
  let finish
  let calls = 0
  const h = await screenPeer(() => { calls++; return new Promise((resolve) => { finish = resolve }) })
  const first = h.read()
  await h.read()
  finish({ page: 'peer', gen: null, owner: null, complete: false })
  await first
  t.is(calls, 1)
  t.absent(h.context.trailing)
})

async function threadReader (h, rows, dm) {
  const { refreshThread, newestOf, messageKey } = await load()
  const rawRef = h.env.rawRef
  rawRef.current = rows
  const src = screen()
  const body = src.slice(src.indexOf('  const readThread ='), src.indexOf('  const reactionGate ='))
  return runInNewContext(body + '\n;readThread', {
    ...h.env,
    refreshThread,
    newestOf,
    messageKey,
    commitRead: h.commitRead,
    rawRef,
    olderRef: { current: true },
    olderErr: { current: false },
    ...openNames(),
    genRef: { current: 0 },
    dm,
    setRaw: (rows) => { rawRef.current = rows },
    setNext: () => {},
    setLoadError: () => {},
    setNewest: () => {},
    setFolder: () => {},
    setBlocked: () => {},
    setLoaded: () => {}
  })
}

test('a row displaced from the newest page loses settled optimism without a cursor', async (t) => {
  const { messageKey } = await load()
  const ids = ['unsure', 'override', 'sending', 'debounce', 'settling', 'new']
  const rows = ids.map((id, i) => ({ from: 'peer', id, at: `2026-11-0${i + 1}T10:00:00Z` }))
  const h = await screenReactions(async () => ({}))
  h.context.pages = new Map()
  for (const row of rows.slice(0, -1)) {
    const key = messageKey(row)
    h.context.overrides.set(key, [{ emoji: '❤️', mine: true }])
    if (row.id !== 'override') h.context.unsure.set(key, '❤️')
    h.context.settled.set(key, 0)
  }
  h.context.sending.add(messageKey(rows[2]))
  h.context.debounce.schedule(messageKey(rows[3]), '', '❤️', () => {})
  const read = await threadReader(h, rows, async () => {
    h.context.settled.set(messageKey(rows[4]), h.context.read)
    return { messages: [rows.at(-1)] }
  })
  await read()
  for (const row of rows.slice(0, 2)) {
    t.absent(h.context.unsure.has(messageKey(row)), 'orphan quiet note is removed')
    t.absent(h.state.painted.has(messageKey(row)), 'orphan override is removed')
  }
  for (const row of rows.slice(2, -1)) {
    t.ok(h.context.unsure.has(messageKey(row)), row.id + ' keeps its note')
    t.ok(h.state.painted.has(messageKey(row)), row.id + ' keeps its override')
  }
})

test('a confirmed reaction on a row displaced from the newest page stays on that row', async (t) => {
  const { messageKey } = await load()
  const rows = ['old', 'new'].map((id, i) => ({ from: 'peer', id, at: `2026-11-0${i + 1}T10:00:00Z`, reactions: id === 'old' ? [{ emoji: '❤️', mine: false }] : undefined }))
  const sent = []
  const h = await screenReactions(async (method, params) => { sent.push(params.emoji); return { ok: true } })
  const key = messageKey(rows[0])
  h.context.pages = new Map()
  h.env.reactionViewRef.current.rawById = new Map(rows.map((m) => [messageKey(m), m]))
  h.env.rawRef.current = rows
  h.toggleReaction(key, '👍')
  h.clock.tick(600)
  await settled()
  await settled()
  t.alike(sent, ['👍'])
  const read = await threadReader(h, h.env.rawRef.current, async () => ({ messages: [rows[1]] }))
  await read()
  t.absent(h.state.painted.has(key), 'the settled override is dropped')
  const held = h.env.rawRef.current.find((m) => messageKey(m) === key)
  t.alike(JSON.parse(JSON.stringify(held.reactions)), [{ emoji: '❤️', mine: false }, { emoji: '👍', mine: true }], 'the confirmed choice stays on the row with the other person kept')
})

test('a dead older cursor drops its keys and reactions when the node returns the newest page', async (t) => {
  const { messageKey } = await load()
  const rows = ['old', 'new'].map((id, i) => ({ from: 'peer', id, at: `2026-11-0${i + 1}T10:00:00Z` }))
  const h = await screenReactions(async () => ({}))
  const key = messageKey(rows[0])
  h.context.pages = new Map([['dead', new Set([key])]])
  h.context.unsure.set(key, '❤️')
  h.context.overrides.set(key, [{ emoji: '❤️', mine: true }])
  h.context.settled.set(key, 0)
  const calls = []
  const read = await threadReader(h, rows, async (method, params) => {
    calls.push(params.before || 'newest')
    return { messages: [rows[1]] }
  })
  await read()
  t.alike(calls, ['newest', 'dead'])
  t.absent(h.context.pages.has('dead'), 'the stale cursor is discarded')
  t.absent(h.context.unsure.has(key), 'quiet note is removed')
  t.absent(h.state.painted.has(key), 'optimistic chip is removed')
  await read()
  t.alike(calls, ['newest', 'dead', 'newest'], 'the dead cursor is not read again')
})

test('a row marked reactable: false shows no reaction UI and sends nothing', async (t) => {
  const { dmReactable } = await load()
  t.ok(dmReactable({ from: 'peer', id: 'one' }))
  t.absent(dmReactable({ from: 'peer', id: 'one', reactable: false }))
  t.absent(dmReactable({ from: 'peer', id: 'one', deleted: true }))
  t.absent(dmReactable(null))
  const sent = []
  const h = await screenReactions((...args) => { sent.push(args) })
  h.item.reactable = false
  t.absent(h.canReact(h.key), 'no quick strip, picker or chip tap')
  h.toggleReaction(h.key, '👍')
  h.clock.tick(600)
  t.alike(sent, [])
  t.absent(h.state.painted.has(h.key))
  const src = screen()
  t.ok(src.includes('const reactionRowReady = (item) => dmReactable(item)'), 'chips, quick strip and picker share the check')
  t.ok(src.includes('!reactionsHidden && reactionRowReady('), 'chips hidden on such a row')
})

test('a USAGE refusal from a stale screen restores the row, shows the message and is never retried', async (t) => {
  const sent = []
  const h = await screenReactions(() => {
    sent.push(1)
    return Promise.reject(Object.assign(new Error('esta mensagem não aceita reações'), { code: 'USAGE' }))
  }, [{ emoji: '❤️', mine: true }])
  h.toggleReaction(h.key, '👍')
  t.is(h.state.painted.get(h.key)[0].emoji, '👍')
  h.clock.tick(600)
  await settled()
  t.alike(h.state.painted.get(h.key), [{ emoji: '❤️', count: 1, mine: true }], 'optimistic choice reverted')
  t.is(h.state.errors.at(-1), 'esta mensagem não aceita reações')
  t.is(h.context.unsure.size, 0, 'not uncertain')
  t.is(h.state.reads, 1, 'one reread, which brings reactable: false')
  h.clock.tick(6000)
  await settled()
  t.is(sent.length, 1, 'no resend')
})

test('an older-page reread carries reactable: false, so the reaction controls go away', async (t) => {
  const { refreshThread, newestOf, messageKey, dmReactable } = await load()
  const rows = ['old', 'new'].map((id, i) => ({ from: 'peer', id, at: `2026-11-0${i + 1}T10:00:00Z`, text: id }))
  const h = await screenReactions(async () => ({}))
  const oldKey = messageKey(rows[0])
  const pend = () => {
    h.context.pages = new Map([['old', new Set([oldKey])]])
    h.context.overrides.set(oldKey, [{ emoji: '👍', count: 1, mine: true }])
  }
  pend()
  let mark = true
  const rawRef = { current: rows.slice() }
  const env = {
    ...h.env,
    refreshThread,
    newestOf,
    messageKey,
    commitRead: h.commitRead,
    rawRef,
    olderRef: { current: true },
    olderErr: { current: false },
    ...openNames(),
    genRef: { current: 0 },
    dm: async (method, params) => {
      const row = params.before ? rows[0] : rows[1]
      return { messages: [{ ...row, ...(params.before && mark ? { reactable: false } : {}) }], next: 'new-cursor' }
    },
    setRaw: (next) => { rawRef.current = next },
    setNext: () => {},
    setLoadError: () => {},
    setNewest: () => {},
    setFolder: () => {},
    setBlocked: () => {},
    setLoaded: () => {},
    useCallback: (fn) => fn
  }
  const src = screen()
  const read = runInNewContext(src.slice(src.indexOf('  const readThread ='), src.indexOf('  const reactionGate =')) + '\n;readThread', env)
  t.ok(dmReactable(rawRef.current[0]))
  await read()
  t.is(rawRef.current[0].reactable, false, 'the held row takes the mark of the reread')
  t.absent(dmReactable(rawRef.current[0]), 'chips, quick strip and picker go away')
  mark = false
  pend()
  await read()
  t.absent('reactable' in rawRef.current[0], 'a fresh row without the mark drops it')
})

test('a successful older page clears only the error an older page set', async (t) => {
  const { refreshThread, newestOf, messageKey, mergeMessages, pinToEnd } = await load()
  const h = await screenReactions(async () => ({}))
  h.context.pages = new Map()
  const row = (id) => ({ from: 'peer', id, at: id === 'new' ? 2 : 1, text: id, reactions: [] })
  const state = { loadError: '', calls: 0 }
  let fail = ''
  const env = {
    ...h.env,
    refreshThread,
    newestOf,
    messageKey,
    mergeMessages,
    pinToEnd,
    commitRead: h.commitRead,
    olderRef: { current: false },
    olderErr: { current: false },
    ...openNames(),
    genRef: { current: 0 },
    nextRef: { current: 'cursor' },
    endPin: { current: { pinned: true } },
    loadingMore: false,
    dm: async (method, params) => {
      state.calls++
      if (fail) throw new Error(fail)
      return params.before ? { messages: [row('old')], next: 'cursor' } : { messages: [row('new')], next: 'cursor' }
    },
    setRaw: (rows) => { env.rawRef.current = rows },
    setNext: () => {},
    setLoadError: (text) => { state.loadError = text },
    setLoadingMore: () => {},
    setNewest: () => {},
    setFolder: () => {},
    setBlocked: () => {},
    setLoaded: () => {}
  }
  const src = screen()
  const thread = src.slice(src.indexOf('  const readThread ='), src.indexOf('  const reactionGate ='))
  const older = src.slice(src.indexOf('  const loadOlder = async () => {'), src.indexOf('\n  olderLive.current ='))
  const { readThread, loadOlder } = runInNewContext(thread + older + '\n;({ readThread, loadOlder })', env)
  fail = 'offline'
  await loadOlder()
  t.is(state.loadError, 'offline', 'an older page failure shows its error')
  fail = ''
  await loadOlder()
  t.is(state.loadError, '', 'the pill retry that lands clears that error')
  t.absent(env.olderErr.current)
  fail = 'thread down'
  await readThread()
  t.is(state.loadError, 'thread down')
  fail = ''
  await loadOlder()
  t.is(state.loadError, 'thread down', 'an older page never clears a thread read error')
  fail = 'offline'
  await loadOlder()
  fail = ''
  await readThread()
  t.is(state.loadError, '', 'a thread read that lands clears either error')
  t.absent(env.olderErr.current, 'and forgets where it came from')
  fail = 'offline'
  await loadOlder()
  fail = 'thread down'
  await readThread()
  fail = ''
  await loadOlder()
  t.is(state.loadError, 'thread down', 'a thread error that replaced an older one stays')
  t.ok(state.calls >= 8)
})
