// Screen stack (nav.js) and the browser history binding (history.web.js,
// history.native.js) with a fake window.
'use strict'

const test = require('brittle')
const loadNav = () => import('../src/nav.js')
const loadWeb = () => import('../src/history.web.js')
const loadNative = () => import('../src/history.native.js')

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)

test('push, pop, top, depth and reset', async (t) => {
  const { EMPTY, push, pop, top, depth, reset } = await loadNav()
  t.is(depth(EMPTY), 0)
  t.is(top(EMPTY), null)
  const one = push(EMPTY, { screen: 'conversa', key: A + ':3', params: { seed: 1 } })
  t.is(depth(one), 1)
  t.alike(top(one), { screen: 'conversa', key: A + ':3', params: { seed: 1 } })
  t.ok(Object.isFrozen(one) && Object.isFrozen(top(one)), 'immutable')
  const two = push(one, { screen: 'membro', key: B })
  t.is(depth(two), 2)
  t.alike(top(two).params, {}, 'params default to {}')
  t.is(depth(one), 1, 'push does not mutate')
  t.is(pop(two).length, 1)
  t.is(top(pop(two)), top(one))
  t.is(pop(one), EMPTY)
  t.is(pop(EMPTY), EMPTY)
  t.is(reset(), EMPTY)
})

test('pushing the same screen and key as the top is a no-op', async (t) => {
  const { EMPTY, push } = await loadNav()
  const one = push(EMPTY, { screen: 'membro', key: A })
  t.is(push(one, { screen: 'membro', key: A, params: { seed: 2 } }), one)
  t.is(push(one, { screen: 'membro', key: B }).length, 2)
  const two = push(one, { screen: 'conversa', key: A + ':1' })
  t.is(push(two, { screen: 'membro', key: A }).length, 3, 'only the top dedupes')
})

test('invalid entries are refused', async (t) => {
  const { EMPTY, push, validEntry } = await loadNav()
  const bad = [
    null,
    { screen: 'outra', key: A },
    { screen: 'conversa', key: A },
    { screen: 'conversa', key: A + ':0' },
    { screen: 'conversa', key: A + ':01' },
    { screen: 'conversa', key: A.toUpperCase() + ':1' },
    { screen: 'conversa', key: A + ':99999999999999999' },
    { screen: 'membro', key: A + ':1' },
    { screen: 'membro', key: A.toUpperCase() },
    { screen: 'membro', key: 'ab' },
    { screen: 'membro', key: 42 },
    { screen: 'curtidas', key: A, params: { kind: 'likes' } },
    { screen: 'curtidas', key: A + ':0', params: { kind: 'likes' } },
    { screen: 'curtidas', key: A.toUpperCase() + ':3', params: { kind: 'likes' } },
    { screen: 'curtidas', key: A + ':3' },
    { screen: 'curtidas', key: A + ':3', params: {} },
    { screen: 'curtidas', key: A + ':3', params: { kind: 'like' } },
    { screen: 'curtidas', key: A + ':3', params: ['likes'] }
  ]
  for (const entry of bad) {
    t.absent(validEntry(entry), JSON.stringify(entry))
    t.is(push(EMPTY, entry), EMPTY)
  }
})

test('curtidas is keyed by a post ref with a likes or reposts kind', async (t) => {
  const { EMPTY, SCREENS, push, top, validEntry } = await loadNav()
  t.ok(SCREENS.includes('curtidas'))
  const entry = { screen: 'curtidas', key: A + ':3', params: { kind: 'reposts' } }
  t.ok(validEntry(entry))
  t.ok(validEntry({ screen: 'curtidas', key: A + ':3', params: { kind: 'likes' } }))
  const one = push(EMPTY, entry)
  t.alike(top(one), entry)
  t.is(push(one, { screen: 'curtidas', key: A + ':3', params: { kind: 'likes' } }), one, 'the other kind on top is a no-op')
  t.is(push(one, { screen: 'curtidas', key: A + ':4', params: { kind: 'likes' } }).length, 2)
})

test('MAX_DEPTH drops the oldest entry', async (t) => {
  const { EMPTY, MAX_DEPTH, push, top } = await loadNav()
  t.is(MAX_DEPTH, 20)
  let stack = EMPTY
  for (let i = 1; i <= MAX_DEPTH + 3; i++) stack = push(stack, { screen: 'conversa', key: A + ':' + i })
  t.is(stack.length, MAX_DEPTH)
  t.is(stack[0].key, A + ':4')
  t.is(top(stack).key, A + ':23')
})

// A window whose history is a real entry list with a current index.
function fakeWindow () {
  const listeners = new Map()
  const pushed = []
  const replaced = []
  let entries = [null]
  let index = 0
  const fire = (state) => listeners.get('popstate')({ state })
  return {
    pushed,
    replaced,
    listeners,
    get length () { return entries.length },
    history: {
      get state () { return entries[index] },
      pushState: (state, title) => {
        pushed.push({ state, title })
        entries = entries.slice(0, index + 1).concat([state])
        index++
      },
      replaceState: (state, title) => {
        replaced.push({ state, title })
        entries[index] = state
      }
    },
    back: () => {
      if (index === 0) return false
      index--
      fire(entries[index])
      return true
    },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) },
    fire
  }
}

test('history.web: pushed tags the depth, popstate closes screens', async (t) => {
  const { bindHistory } = await loadWeb()
  const win = fakeWindow()
  let depth = 0
  const backs = []
  const h = bindHistory({ depthOf: () => depth, onBack: (n) => backs.push(n), win })
  h.pushed()
  t.is(win.pushed.length, 0, 'never pushes for depth 0')
  depth = 1
  h.pushed()
  depth = 2
  h.pushed()
  t.alike(win.pushed.map((p) => p.state), [{ varanda: 1 }, { varanda: 2 }])
  win.fire({ varanda: 1 })
  t.alike(backs, [1])
  win.fire(null)
  t.alike(backs, [1, 2], 'untagged entry counts as depth 0')
  depth = 1
  win.fire({ varanda: 1 })
  win.fire({ varanda: 3 })
  t.alike(backs, [1, 2], 'same or higher depth does nothing')
  win.fire({ varanda: 'x' })
  t.alike(backs, [1, 2, 1], 'a bad tag counts as 0')
  h.unbind()
  t.absent(win.listeners.has('popstate'))
})

test('history.web: past MAX_DEPTH the entry is replaced, every Back closes a screen', async (t) => {
  const { bindHistory } = await loadWeb()
  const { EMPTY, MAX_DEPTH, push, pop, depth } = await loadNav()
  const win = fakeWindow()
  let stack = EMPTY
  let backs = 0
  const h = bindHistory({
    depthOf: () => depth(stack),
    onBack: (n) => { backs++; for (let i = 0; i < n; i++) stack = pop(stack) },
    win
  })
  for (let i = 1; i <= MAX_DEPTH + 1; i++) {
    stack = push(stack, { screen: 'conversa', key: A + ':' + i })
    h.pushed()
  }
  t.is(depth(stack), MAX_DEPTH)
  t.is(win.pushed.length, MAX_DEPTH)
  t.is(win.replaced.length, 1, 'the 21st screen replaced the top entry')
  t.is(win.length, MAX_DEPTH + 1, 'history depth equals stack depth (plus the base entry)')
  for (let i = 0; i < MAX_DEPTH; i++) win.back()
  t.is(backs, MAX_DEPTH, 'each Back called onBack')
  t.is(depth(stack), 0)
})

test('history.web tolerates a missing history API; native is a no-op', async (t) => {
  const { bindHistory } = await loadWeb()
  const h = bindHistory({ depthOf: () => 2, onBack: () => {}, win: {} })
  h.pushed()
  h.unbind()
  const none = bindHistory({ depthOf: () => 2, onBack: () => {}, win: null })
  none.pushed()
  none.unbind()
  const throwing = fakeWindow()
  throwing.history.pushState = () => { throw new Error('SecurityError') }
  bindHistory({ depthOf: () => 1, onBack: () => {}, win: throwing }).pushed()
  const native = (await loadNative()).bindHistory({ depthOf: () => 1, onBack: () => t.fail() })
  native.pushed()
  native.unbind()
  t.pass()
})

test('cadeira and comunidade are keyed by a lowercase hex64 root key', async (t) => {
  const { EMPTY, SCREENS, push, top, validEntry, MAX_DEPTH } = await loadNav()
  t.ok(SCREENS.includes('cadeira'))
  t.ok(SCREENS.includes('comunidade'))
  for (const screen of ['cadeira', 'comunidade']) {
    t.ok(validEntry({ screen, key: A }))
    const stack = push(EMPTY, { screen, key: A })
    t.alike(top(stack), { screen, key: A, params: {} })
    t.is(push(stack, { screen, key: A }), stack, 'same top is a no-op')
    for (const key of [A.toUpperCase(), 'ab', A + ':1', 42, null, A + '0']) {
      t.absent(validEntry({ screen, key }), screen + ' ' + String(key))
      t.is(push(EMPTY, { screen, key }), EMPTY)
    }
  }
  t.is(push(push(EMPTY, { screen: 'cadeira', key: A }), { screen: 'comunidade', key: A }).length, 2, 'same key on another screen is a new entry')
  t.ok(validEntry({ screen: 'conversa', key: A + ':1' }) && validEntry({ screen: 'membro', key: A }), 'existing screens keep working')
  t.is(MAX_DEPTH, 20)
})
