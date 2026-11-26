'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '../src/screens/Conversas.js'), 'utf8')
const communities = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
const owner = 'aa'.repeat(32)
const peer = 'bb'.repeat(32)
const other = 'cc'.repeat(32)
const binding = { origin: 'https://example.test', association: 'dd'.repeat(32), owner, acting: { kind: 'me' } }
const row = (key) => ({ peer: key, folder: 'inbox', preview: 'Olá', at: '2026-11-01T12:00:00.000Z', unread: true, mine: false })

function fn (text, name) {
  const start = text.indexOf('function ' + name + ' (')
  if (start < 0) throw new Error('Missing function ' + name)
  return text.slice(start, text.indexOf('\n}', start) + 2)
}

function evaluate (text, deps) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), text)(...Object.values(deps))
}

const sameSnapshotBinding = evaluate('return ' + fn(communities, 'sameSnapshotBinding'), {})
const bindingKeyOf = evaluate('return ' + fn(communities, 'bindingKeyOf'), {})
const memberSnapshotBinding = evaluate('return ' + fn(communities, 'memberSnapshotBinding'), {
  liveBinding: (key, config) => config ? { origin: config.origin, association: config.association, owner: key } : null
})
const node = () => ({ config: binding, passkey: { status: { unlocked: true, publicKey: owner } } })

// Execute the hook itself with persistent state and effect cleanup, without React Native.
async function inboxHarness (extra = {}) {
  const paging = await import('../src/inboxPaging.js')
  const slots = []
  let index = 0
  let effects = []
  const changed = (before, after) => !before || before.some((v, i) => v !== after[i])
  const hooks = {
    useState (initial) {
      const i = index++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
    },
    useRef (initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { current: initial }
      return slots[i]
    },
    useCallback (work, deps) {
      const i = index++
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { work, deps }
      return slots[i].work
    },
    useEffect (work, deps) {
      const i = index++
      if (slots[i] && !changed(slots[i].deps, deps)) return
      effects.push(() => {
        if (slots[i] && slots[i].cleanup) slots[i].cleanup()
        slots[i] = { deps, cleanup: work() }
      })
    }
  }
  const seededInbox = evaluate('return ' + fn(source, 'seededInbox'), {})
  const useInbox = evaluate('return ' + fn(source, 'useInbox'), {
    ...paging, ...hooks, seededInbox, bindingKeyOf, cacheGeneration: () => 1, errorText: (e) => e.message, ...extra
  })
  let props = { ready: false, dm: async () => ({ conversations: [] }), dmVersion: 0, pageKey: null, needle: '', seed: [row(peer)], snapshotBinding: binding, armSave: () => {}, cancelSave: () => {} }
  return {
    render (patch = {}) {
      props = { ...props, ...patch }
      index = 0
      return useInbox(props)
    },
    effects () {
      const pending = effects
      effects = []
      for (const run of pending) run()
    },
    unmount () {
      for (const slot of slots) if (slot && slot.cleanup) slot.cleanup()
    }
  }
}

test('the inbox seeds only the default member page, without loaded or live badges', async (t) => {
  for (const patch of [{}, { needle: 'ana' }, { pageKey: peer }, { snapshotBinding: null }, { seed: null }]) {
    const h = await inboxHarness()
    const inbox = h.render(patch)
    const seeded = Object.keys(patch).length === 0
    t.is(inbox.seeded, seeded)
    t.alike(inbox.rows, seeded ? [{ ...row(peer), unread: false }] : [], 'a seeded row never carries its stored unread flag')
    t.is(inbox.loaded, false)
    t.is(inbox.requests, false)
    t.is(inbox.inboxUnread, false)
    t.is(inbox.next, null)
  }
})

test('a live first page replaces the copy, dropping omitted conversations in order', async (t) => {
  const h = await inboxHarness()
  const live = [row(other), { ...row(peer), preview: 'Resposta' }]
  const inbox = h.render({ seed: [row(owner), row(peer)], dm: async () => ({ conversations: live, next: 'next', requests: true, inboxUnread: true }) })
  await inbox.list()
  const updated = h.render()
  t.alike(updated.rows, live)
  t.is(updated.seeded, false)
  t.is(updated.loaded, true)
  t.is(updated.requests, true)
  t.is(updated.inboxUnread, true)
  t.is(updated.next, 'next')
  await h.render({ dm: async () => ({ conversations: [] }) }).list()
  t.alike(h.render().rows, [], 'an empty live page removes all cached rows')
})

test('capture generation and binding before dm.list; a wipe prevents arming', async (t) => {
  for (const wipe of [false, true]) {
    let generation = 1
    let answer
    const armed = []
    const h = await inboxHarness({ cacheGeneration: () => generation })
    const inbox = h.render({ dm: () => new Promise((resolve) => { answer = resolve }), armSave: (...args) => armed.push(args) })
    const pending = inbox.list()
    h.render({ snapshotBinding: { ...binding, owner: other } })
    if (wipe) generation++
    answer({ conversations: [row(peer)] })
    await pending
    t.alike(armed, wipe ? [] : [[1, binding, [row(peer)]]], 'the request carries its original binding and generation')
  }
  const armed = []
  const h = await inboxHarness()
  await h.render({ needle: 'ana', armSave: (...args) => armed.push(args) }).list()
  t.alike(armed, [], 'a search does not save')
})

test('scrolling keeps deeper pages and their refresh does not arm a snapshot', async (t) => {
  const armed = []
  const h = await inboxHarness()
  const dm = async (method, args) => args.before ? { conversations: [row(other)] } : { conversations: [row(peer)], next: 'older' }
  await h.render({ dm, armSave: (...args) => armed.push(args) }).list()
  await h.render().loadMore()
  t.alike(h.render().rows, [row(peer), row(other)])
  await h.render().list()
  t.alike(h.render().rows, [row(peer), row(other)])
  t.is(armed.length, 1, 'only the default first page is saved')
})

test('identity reset drops seeds and cancels saves; unmount rejects late answers', async (t) => {
  let cancelled = 0
  let answer
  const armed = []
  const h = await inboxHarness()
  h.render({ cancelSave: () => cancelled++, dm: () => new Promise((resolve) => { answer = resolve }), armSave: (...args) => armed.push(args) })
  h.effects()
  h.render({ snapshotBinding: null })
  h.effects()
  const reset = h.render()
  t.alike(reset.rows, [])
  t.is(reset.seeded, false)
  t.is(cancelled, 1)
  h.render({ snapshotBinding: binding })
  h.effects()
  const pending = h.render().list()
  h.unmount()
  answer({ conversations: [row(peer)] })
  await pending
  t.is(cancelled, 3)
  t.alike(armed, [])
  t.alike(h.render().rows, [{ ...row(peer), unread: false }], 'the late answer cannot replace the reseeded copy after unmount')
  t.is(h.render().seeded, true)
})

test('cached rows pass the current binding and block gate on each render', async (t) => {
  const { cachedRowsShown } = await import('../src/cachedRows.js')
  const start = source.indexOf('const inboxRows = useMemo(')
  const gate = source.slice(start, source.indexOf('\n  // Only a finished', start))
  const draw = (blocks, snapshotBinding = binding) => evaluate(gate + '\nreturn inboxRows', {
    useMemo: (read) => read(), inbox: { seeded: true, rows: [row(peer)] }, snapshotSeed: { binding }, snapshotBinding, blocks, sameSnapshotBinding, cachedRowsShown
  })
  t.alike(draw({ loadState: 'pending', keys: new Set() }), [])
  t.alike(draw({ loadState: 'failed', keys: new Set() }), [])
  t.alike(draw({ loadState: 'ok', keys: new Set() }), [row(peer)])
  t.alike(draw({ loadState: 'ok', keys: new Set([peer]) }), [], 'a later block hides the cached row')
  t.alike(draw({ loadState: 'ok', keys: new Set() }, null), [], 'locked')
  t.alike(draw({ loadState: 'ok', keys: new Set() }, { ...binding, owner: other }), [], 'another owner')
  t.ok(gate.includes('blocks.loadState, blocks.keys, snapshotBinding, snapshotSeed.binding]'), 'memo follows the gate inputs')
  t.ok(source.includes('dmConversations: ready || inbox.seeded ? inboxRows : []'), 'only gated rows reach mergeRows')
  t.ok(source.includes('const dmLoaded = !ready || inbox.loaded || (inbox.seeded && inboxRows.length > 0)'))
  t.absent(/dm\.seen/.test(source), 'cached paint never marks a conversation read')
})

function saver (extra = {}) {
  let generation = 1
  const timers = new Map()
  const writes = []
  const start = source.indexOf('// The last live inbox page armed')
  const code = source.slice(start, source.indexOf('// Search text reaches', start))
  const result = evaluate(code + '\nreturn { armSave, cancelSave, saveContext, onGroupsComplete }', {
    useRef: (current) => ({ current }),
    useCallback: (f) => f,
    useGroupRows: () => ({ completeRows: { current: null } }),
    useBlocks: () => ({ loadState: 'ok', keys: new Set() }),
    hosted: true,
    allowed: true,
    seenTick: 0,
    snapshotBinding: binding,
    seedBody: null,
    node: node(),
    acting: binding.acting,
    pageKey: null,
    cacheGeneration: () => generation,
    sameSnapshotBinding,
    memberSnapshotBinding,
    buildScreenSnapshot: (kind, input) => input,
    saveScreenSnapshot: (...args) => { writes.push(args); return false },
    setTimeout: (run, ms) => { timers.set(run, ms); return run },
    clearTimeout: (id) => timers.delete(id),
    ...extra
  })
  return { ...result, timers, writes, wipe: () => generation++, flush: () => { const pending = [...timers.keys()]; timers.clear(); for (const run of pending) run() } }
}

test('the save debounce uses current blocks, first 30 rows and the last complete groups', async (t) => {
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const s = saver({ buildScreenSnapshot })
  const rows = Array.from({ length: 32 }, (_, i) => row(i.toString(16).padStart(64, '0')))
  s.armSave(1, binding, rows)
  t.alike([...s.timers.values()], [2000])
  s.saveContext.current.blocks.keys = new Set([rows[0].peer])
  s.saveContext.current.completeRows.current = {
    binding,
    rows: [
      { group: peer, name: 'Privado', visibility: 'private' },
      { group: other, name: 'Público', visibility: 'public' }
    ]
  }
  s.flush()
  const [kind, snapshot, gen] = s.writes[0]
  t.is(kind, 'conversas')
  t.is(gen, 1)
  t.alike(snapshot.body.rows, rows.slice(1, 30))
  t.alike(snapshot.body.groups, [{ group: peer, name: 'Privado' }])
  s.flush()
  t.is(s.writes.length, 1, 'a refused save is never retried')
  t.ok(/if \(!partial && !failed && cacheGeneration\(\) === cacheGen && sameSnapshotBinding\(snapshotBinding, bindingRef.current\)\) \{\n\s*completeRows.current =/.test(source), 'only complete current live group reads replace the saved group source')
})

test('a newer commit replaces the pending save rather than writing both', (t) => {
  const s = saver()
  s.armSave(1, binding, [row(peer)])
  s.armSave(1, binding, [row(other)])
  t.is(s.timers.size, 1)
  s.flush()
  t.is(s.writes.length, 1)
  t.alike(s.writes[0][1].rows, [row(other)])
})

test('a wipe, changed binding, unknown blocks or cancellation prevents the delayed save', (t) => {
  for (const change of [
    (s) => s.wipe(),
    (s) => { s.saveContext.current.node.passkey.status.unlocked = false },
    (s) => { s.saveContext.current.node.passkey.status.signedOut = true },
    (s) => { s.saveContext.current.pageKey = peer },
    (s) => { s.saveContext.current.node.config = null },
    (s) => { s.saveContext.current.node.config = { ...binding, association: other } },
    (s) => { s.saveContext.current.blocks.loadState = 'pending' },
    (s) => s.cancelSave()
  ]) {
    const s = saver()
    s.armSave(1, binding, [row(peer)])
    change(s)
    s.flush()
    t.alike(s.writes, [])
  }
})

test('one bound snapshot read supplies both inbox rows and private group names', (t) => {
  t.is((source.match(/loadScreenSnapshot\('conversas'/g) || []).length, 1)
  t.ok(source.includes("snapshot: snapshotBinding === null ? null : loadScreenSnapshot('conversas', snapshotBinding)"))
  t.ok(source.includes('seed: seedBody === null ? null : seedBody.rows'))
  t.ok(source.includes('privateGroups: seedBody === null ? [] : seedBody.groups'))
  const seededGroups = evaluate(fn(source, 'seedRow') + '\nreturn ' + fn(source, 'seededGroups'), {
    readGroupSnapshot: () => [{ group: peer, community: other, role: 'member', general: false, name: null }],
    NO_GROUPS: { rows: [], loaded: false }
  })
  const groups = seededGroups(binding, [{ group: peer, name: 'Privado' }])
  t.is(groups.rows[0].name, 'Privado')
  t.is(groups.rows[0].seedBinding, binding)
  t.is(groups.loaded, false)
})

test('an inbox mounted before the unlock seeds the copy once the binding arrives', async (t) => {
  const h = await inboxHarness()
  const before = h.render({ snapshotBinding: null })
  h.effects()
  t.alike(before.rows, [])
  t.is(before.seeded, false)
  h.render({ snapshotBinding: binding })
  h.effects()
  const after = h.render()
  t.is(after.seeded, true)
  t.alike(after.rows, [{ ...row(peer), unread: false }])
  t.is(after.loaded, false)
  t.is(after.inboxUnread, false)
  h.render({ snapshotBinding: binding, pageKey: peer })
  h.effects()
  t.alike(h.render().rows, [], 'a page actor never seeds')
})

test('the stored copy is read again when the binding changes', (t) => {
  const start = source.indexOf('  const snapshotKey = bindingKeyOf(snapshotBinding)')
  const end = source.indexOf('\n', source.indexOf('setSnapshotSeed(readSeed())', start))
  const code = source.slice(start, end) + '\nreturn snapshotSeed'
  let slot
  const reads = []
  const render = (snapshotBinding) => evaluate(code, {
    snapshotBinding,
    bindingKeyOf,
    loadScreenSnapshot: (kind, b) => { reads.push(b); return { body: { rows: [row(peer)], groups: [] } } },
    useState: (init) => {
      if (slot === undefined) slot = init()
      return [slot, (next) => { slot = next }]
    }
  })
  render(null)
  t.is(slot.snapshot, null)
  render(binding)
  t.is(slot.binding, binding, 'the first binding reads the copy the mount could not')
  t.alike(reads, [binding])
  render(binding)
  t.is(reads.length, 1, 'the same binding reads once')
})

test('a save before the group read keeps the stored private names, and the complete read saves again', async (t) => {
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const s = saver({ buildScreenSnapshot, seedBody: { rows: [], groups: [{ group: peer, name: 'Guardado' }] } })
  s.armSave(1, binding, [row(other)])
  s.flush()
  t.alike(s.writes[0][1].body.groups, [{ group: peer, name: 'Guardado' }], 'groups not loaded yet never erase the stored names')
  t.alike(s.writes[0][1].body.rows, [row(other)])
  s.saveContext.current.completeRows.current = { binding, rows: [{ group: other, name: 'Novo', visibility: 'private' }] }
  s.onGroupsComplete()
  t.alike([...s.timers.values()], [2000], 'a complete group read arms the save again')
  s.flush()
  t.is(s.writes.length, 2)
  t.alike(s.writes[1][1].body.groups, [{ group: other, name: 'Novo' }])
  t.alike(s.writes[1][1].body.rows, [row(other)], 'with the last live inbox page')
  s.wipe()
  s.onGroupsComplete()
  t.is(s.timers.size, 0, 'a wipe since the inbox read arms nothing')
  const fresh = saver()
  fresh.onGroupsComplete()
  t.is(fresh.timers.size, 0, 'no live inbox page yet: nothing to save')
  t.ok(/onCompleteRef\.current\(\)/.test(source.slice(source.indexOf('completeRows.current = { binding: snapshotBinding'))), 'the hook calls back after a complete read')
  t.ok(source.includes('onComplete: onGroupsComplete, binding: snapshotBinding })'))
})

test('a complete group list drops the stored messages of every group no longer read', (t) => {
  const helper = source.slice(source.indexOf('function forgetLeftGroups'), source.indexOf('function useGroupRows'))
  t.ok(helper.includes("loadScreenSnapshot('grupoMensagens', binding)"), 'reads the stored group messages')
  t.ok(helper.includes('keepGroups(current.body, groups)'), 'keeps only the listed groups')
  t.ok(helper.includes("clearScreenSnapshot('grupoMensagens')"), 'a failed rewrite drops the kind')
  t.ok(helper.includes('cacheGeneration() !== gen'), 'never after a wipe')
  const complete = source.slice(source.indexOf('// Only a complete list: a partial one would drop the groups it missed.'))
  t.ok(complete.slice(0, complete.indexOf('saveGroupSnapshot(')).includes('forgetLeftGroups(snapshotBinding, all.map((r) => r.group), cacheGen)'), 'only on a complete list')
})
