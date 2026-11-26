'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '../src/screens/Seguindo.js'), 'utf8')
const communities = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
const owner = 'aa'.repeat(32)
const followed = 'bb'.repeat(32)
const added = 'cc'.repeat(32)
const binding = { origin: 'https://example.test', association: 'dd'.repeat(32), owner, acting: { kind: 'me' } }

function evaluate (text, deps) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), text)(...Object.values(deps))
}

function bindingFunction (name, deps = {}) {
  const start = communities.indexOf('function ' + name + ' (')
  return evaluate('return ' + communities.slice(start, communities.indexOf('\n}', start) + 2), deps)
}

const memberSnapshotBinding = bindingFunction('memberSnapshotBinding', {
  liveBinding: (key, config) => config ? { origin: config.origin, association: config.association, owner: key } : null
})
const sameSnapshotBinding = bindingFunction('sameSnapshotBinding')

// Run the screen's hooks and handlers with deferred RPCs and a manual clock.
// JSX is checked separately, so no React Native runtime or network is needed.
async function harness (options = {}) {
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const slots = []
  const effects = []
  const timers = new Map()
  const requests = []
  const writes = []
  const reads = []
  let index = 0
  let timerId = 0
  let generation = 0
  let acting = options.acting || binding.acting
  const node = {
    config: binding,
    passkey: { status: { unlocked: true, publicKey: owner } },
    request: (method, params) => new Promise((resolve, reject) => requests.push({ method, params, resolve, reject }))
  }
  if (options.locked) node.passkey.status.unlocked = false
  if (options.vitrine) node.config = null
  let stored = buildScreenSnapshot('listas', { ...binding, name: 'seguindo', scope: options.scope || '', rows: [followed], total: 3, blocked: [] })
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
    useMemo: (fn) => fn(),
    useEffect (fn, deps) {
      const i = index++
      if (!slots[i] || deps.some((v, n) => v !== slots[i].deps[n])) {
        effects.push(() => {
          if (slots[i] && slots[i].cleanup) slots[i].cleanup()
          slots[i] = { deps, cleanup: fn() }
        })
      }
    }
  }
  // Stable callbacks prevent the unmount cleanup from firing on a rerender.
  const callbacks = []
  hooks.useCallback = (fn, deps) => {
    const i = index++
    if (!callbacks[i] || deps.some((v, n) => v !== callbacks[i].deps[n])) callbacks[i] = { fn, deps }
    return callbacks[i].fn
  }
  const resolutions = []
  const names = { profileOf: () => undefined, resolveMany: (keys) => resolutions.push(keys) }
  const start = source.indexOf('export default function Seguindo (')
  const end = source.indexOf('\n  if (!mine) {', start)
  const screen = evaluate('return ' + source.slice(start, end).replace('export default ', '') + '\nreturn { keys, total, loaded, changing, reload, doMore, doRemove, doPublishLegacy }\n}', {
    ...hooks,
    useStyles: () => ({}),
    makeStyles: () => ({}),
    useNode: () => node,
    useActing: () => acting,
    pageMode: ({ acting }) => ({ key: acting.kind === 'page' ? added : null }),
    pagesOn: () => true,
    useBlocks: () => ({ keys: new Set(options.blocked || []), loadState: options.blockLoad || 'ok' }),
    useNames: () => names,
    useBottomPad: () => 0,
    useNotice: () => hooks.useState(''),
    useAction: () => ({ pending: false }),
    memberSnapshotBinding,
    sameSnapshotBinding,
    cacheGeneration: () => generation,
    loadScreenSnapshot: (kind, b) => { reads.push({ kind, b }); return stored },
    buildScreenSnapshot,
    saveScreenSnapshot: (kind, snapshot, gen) => { writes.push({ kind, snapshot, gen }); return false },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId },
    clearTimeout: (id) => timers.delete(id),
    PAGE: 50,
    SAVE_DELAY_MS: 2000,
    FOLLOW_LIMIT_MAX: 500,
    filterPeople: (keys) => keys,
    isKey: () => true,
    errorText: (err) => err.message
  })
  const props = { active: false, ownKey: owner, entry: options.entry }
  const render = () => {
    index = 0
    const result = screen(props)
    while (effects.length) effects.shift()()
    return result
  }
  return {
    render,
    requests,
    resolutions,
    writes,
    reads,
    timers,
    node,
    props,
    bump: () => { generation++ },
    act: (next) => { acting = next },
    store: (next) => { stored = next },
    flush: () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const timer of pending) timer.fn()
    },
    unmount: () => { for (const slot of slots) if (slot && slot.cleanup) slot.cleanup() }
  }
}

test('only the own list with an unlocked member binding seeds the expected scope', async (t) => {
  const h = await harness()
  const state = h.render()
  t.alike(state.keys, [followed])
  t.is(state.total, 3)
  t.is(state.loaded, false)
  t.is(state.changing, true)
  for (const options of [{ locked: true }, { vitrine: true }, { acting: { kind: 'page' } }, { entry: { key: added } }]) {
    const other = await harness(options)
    t.alike(other.render().keys, [], 'no cache outside the member own list')
    t.is(other.reads.length, 0, 'not even a store read')
    const load = other.render().reload(50)
    other.requests[0].resolve({ follows: [added], total: 1 })
    await load
    other.flush()
    t.is(other.writes.length, 0, 'no save outside the member own list')
  }
  const scoped = await harness({ scope: 'other' })
  t.alike(scoped.render().keys, [], 'a different scope is not seeded')
})

test('seeded rows cannot follow or unfollow, and only the live page arms a save', async (t) => {
  const h = await harness()
  let state = h.render()
  await state.doRemove(followed)
  await state.doPublishLegacy()
  await state.doMore()
  t.is(h.requests.length, 0)
  t.is(h.timers.size, 0, 'painting never arms a save')
  t.ok(/disabled=\{changing\}/.test(source), 'the follow pill is disabled')
  t.ok(/onPress=\{doPublishLegacy\} disabled=\{!loaded\}/.test(source), 'legacy follow publication is disabled')
  const load = state.reload(50)
  t.alike(h.requests[0].params, { offset: 0, limit: 50 })
  h.requests[0].resolve({ follows: [added], total: 2 })
  await load
  state = h.render()
  t.alike(state.keys, [added], 'unfollowed rows leave and new follows replace them')
  t.is(state.total, 2)
  t.is(state.loaded, true)
  t.is(state.changing, false)
  t.is([...h.timers.values()][0].delay, 2000)
  const more = state.doMore()
  t.alike(h.requests[1].params, { offset: 1, limit: 50 })
  h.requests[1].resolve({ follows: [followed], total: 2 })
  await more
  t.alike(h.render().keys, [added, followed])
  h.flush()
  t.alike(h.writes[0].snapshot.body.lists.seguindo.rows, [added], 'later pages never enter the saved page')
  t.is(h.writes[0].gen, 0)
  h.flush()
  t.is(h.writes.length, 1, 'a refused write is not retried')
})

test('the save merges the latest shared body, caps rows and drops blocked keys', async (t) => {
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const h = await harness({ blocked: [followed] })
  const load = h.render().reload(150)
  const rows = [followed, ...Array.from({ length: 149 }, (_, i) => (i + 1).toString(16).padStart(64, '0'))]
  h.requests[0].resolve({ follows: rows, total: 200 })
  await load
  const other = buildScreenSnapshot('listas', { ...binding, name: 'assuntos', scope: '', rows: [{ tag: 'samba', label: '#samba', meta: '3 pessoas' }], blocked: [] })
  h.store(other)
  h.flush()
  const lists = h.writes[0].snapshot.body.lists
  t.alike(lists.assuntos, other.body.lists.assuntos, 'a save during the debounce is preserved without renewing its age')
  t.alike(lists.seguindo.rows, rows.slice(1, 100))
  t.is(lists.seguindo.total, 200)
  t.is(lists.seguindo.scope, '')
})

test('no save before block.list answered', async (t) => {
  const h = await harness({ blockLoad: 'pending' })
  const load = h.render().reload(150)
  h.requests[0].resolve({ follows: [followed], total: 1 })
  await load
  h.flush()
  t.is(h.writes.length, 0, 'a partial block list never filters a save')
  t.ok(source.includes("blocksOk: blocks.loadState === 'ok' }") && source.includes('|| !ctx.blocksOk) return'))
})

test('generation and binding are captured before the request and checked at the write', async (t) => {
  for (const when of ['request', 'debounce']) {
    for (const change of ['purge', 'owner', 'origin', 'association', 'lock', 'actor', 'list']) {
      const h = await harness()
      const load = h.render().reload(50)
      const mutate = () => {
        if (change === 'purge') h.bump()
        if (change === 'owner') h.node.passkey.status.publicKey = added
        if (change === 'origin') h.node.config = { ...binding, origin: 'https://other.test' }
        if (change === 'association') h.node.config = { ...binding, association: added }
        if (change === 'lock') h.node.passkey.status.unlocked = false
        if (change === 'actor') h.act({ kind: 'page' })
        if (change === 'list') h.props.entry = { key: added }
        h.render()
      }
      if (when === 'request') mutate()
      h.requests[0].resolve({ follows: [added], total: 1 })
      await load
      if (when === 'debounce') mutate()
      h.flush()
      t.is(h.writes.length, 0, change + ' during ' + when + ' prevents the save')
    }
  }
})

test('only the latest reload saves, and unmount cancels pending or late saves', async (t) => {
  const h = await harness()
  const state = h.render()
  const first = state.reload(50)
  const second = state.reload(50)
  h.requests[1].resolve({ follows: [added], total: 1 })
  await second
  h.requests[0].resolve({ follows: [followed], total: 1 })
  await first
  h.flush()
  t.alike(h.writes[0].snapshot.body.lists.seguindo.rows, [added])
  for (const pending of [false, true]) {
    const h = await harness()
    const load = h.render().reload(50)
    if (pending) h.unmount()
    h.requests[0].resolve({ follows: [added], total: 1 })
    await load
    if (!pending) h.unmount()
    t.is(h.timers.size, 0)
    h.flush()
    t.is(h.writes.length, 0)
  }
})

test('seeded follow keys resolve names once before follow.list answers', async (t) => {
  const h = await harness()
  h.render()
  t.alike(h.resolutions, [[followed]])
  h.render()
  t.is(h.resolutions.length, 1, 'a rerender does not repeat the seed read')
  const pass = h.render().reload(50)
  t.alike(h.resolutions, [[followed]], 'names resolve while follow.list waits')
  h.requests[0].resolve({ follows: [added], total: 1 })
  await pass
  t.alike(h.resolutions, [[followed], [added]], 'the live answer resolves its own keys')
  const locked = await harness({ locked: true })
  locked.render()
  t.alike(locked.resolutions, [], 'no seed means no seed lookup')
})

test('seeded rows cannot open a member or report an account', (t) => {
  const row = source.slice(source.lastIndexOf('<FollowRow'), source.indexOf('export function Fas'))
  const onOpenMember = () => {}
  const onReport = () => {}
  for (const [prop, callback] of [['onOpen', onOpenMember], ['onReport', onReport]]) {
    const expression = row.match(new RegExp(prop + '=\\{([^}]+)\\}'))[1]
    t.is(evaluate('return ' + expression, { loaded: false, onOpenMember, onReport }), undefined, prop + ' is absent on cached rows')
    t.is(evaluate('return ' + expression, { loaded: true, onOpenMember, onReport }), callback, prop + ' returns for live rows')
  }
  t.ok(source.includes("disabled={typeof onReport !== 'function'}"), 'the report button cannot invoke an absent callback')
  t.ok(/onPress=\{typeof onReport === 'function'\s+\?/.test(source))
})

test('seeded keys and total disappear at render when their binding or generation changes', async (t) => {
  for (const change of [
    (h) => { h.node.passkey.status.publicKey = added },
    (h) => { h.node.config = { ...binding, origin: 'https://other.test' } },
    (h) => { h.node.config = { ...binding, association: added } },
    (h) => { h.node.passkey.status.unlocked = false },
    (h) => h.act({ kind: 'page' }),
    (h) => { h.props.entry = { key: added } },
    (h) => h.bump()
  ]) {
    const h = await harness()
    t.alike(h.render().keys, [followed])
    change(h)
    const state = h.render()
    t.alike(state.keys, [], 'the same render hides the copy')
    t.is(state.total, 0)
    t.is(state.loaded, false)
  }
})
