'use strict'

// The optimistic FollowPill: a press flips the pill at once and calls the
// caller exactly once; while the request is pending further presses do
// nothing, and once it settles the caller's `following` is the truth.

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

function element (type, props) {
  return { type, props }
}

function nodes (node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(nodes)
  return [node, ...nodes(node.props && node.props.children)]
}

function compile (file, modules) {
  const { code } = transformSync(readFileSync(join(__dirname, '../src', file), 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [
      [require.resolve('@babel/plugin-transform-react-jsx'), { runtime: 'automatic' }],
      require.resolve('@babel/plugin-transform-modules-commonjs')
    ]
  })
  const exports = {}
  runInNewContext(code, {
    exports,
    require (name) {
      if (!Object.hasOwn(modules, name)) throw new Error('Unexpected import: ' + name)
      return modules[name]
    }
  })
  return exports
}

const follow = compile('follow.js', {})

// Just enough of React's hooks for one component: state survives renders,
// effects run after a render when their deps change, and a state update
// renders again, as a commit would.
function harness () {
  const slots = []
  let at = 0
  let dirty = false
  let queued = []
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const react = {
    useState (init) {
      const i = at++
      if (!(i in slots)) slots[i] = { value: typeof init === 'function' ? init() : init }
      const slot = slots[i]
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (!Object.is(value, slot.value)) {
          slot.value = value
          dirty = true
        }
      }]
    },
    useRef (value) {
      const i = at++
      if (!(i in slots)) slots[i] = { current: value }
      return slots[i]
    },
    useEffect (fn, deps) {
      const i = at++
      const prev = slots[i]
      if (!prev || !same(prev.deps, deps)) {
        slots[i] = { deps }
        queued.push(fn)
      }
    }
  }
  const taps = []
  const { FollowPill } = compile('ui/FollowPill.js', {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-native': { Text: 'Text', View: 'View' },
    './Sheet': { Sheet: 'Sheet' },
    './index': { Btn: 'Btn', Soft: 'Soft' },
    './Pill': { Pill: 'Pill' },
    './theme': { type: { sheetTitle: {} } },
    './ThemeProvider': { useTheme () { return { colors: { ink: 'ink' } } } },
    './haptics': { tap (kind) { taps.push(kind) } },
    '../follow': follow
  })
  let props = null
  let view = null
  let effects = []
  const flush = () => {
    const run = effects
    effects = []
    for (const fn of run) fn()
  }
  // One commit whose effects stay queued until just before the next one, as
  // React flushes a late commit's passive effects before rendering again.
  const commit = (next) => {
    flush()
    if (next) props = next
    dirty = false
    at = 0
    queued = []
    view = FollowPill(props)
    effects = queued
    queued = []
    return view
  }
  const render = (next) => {
    commit(next)
    for (let round = 0; round < 20; round++) {
      dirty = false
      flush()
      if (!dirty) return view
      commit()
    }
    throw new Error('render loop')
  }
  return { render, commit, taps, get view () { return view } }
}

const pill = (view) => nodes(view).find((n) => n.type === 'Pill')
const sheet = (view) => nodes(view).find((n) => n.type === 'Sheet')
const btn = (view, label) => nodes(view).find((n) => n.type === 'Btn' && n.props.label === label)

function counter () {
  const calls = { follow: 0, unfollow: 0 }
  return {
    calls,
    onFollow () { calls.follow++ },
    onUnfollow () { calls.unfollow++ }
  }
}

test('followView shows the press until the request settles, then the caller', (t) => {
  const { followView } = follow
  t.alike({ ...followView({ following: false, pending: false, intent: null }) }, { following: false, busy: false })
  t.alike({ ...followView({ following: true, pending: false, intent: null }) }, { following: true, busy: false })
  t.alike({ ...followView({ following: null, pending: false, intent: null }) }, { following: null, busy: false })
  t.alike({ ...followView({ following: false, pending: true, intent: true }) }, { following: true, busy: true }, 'a Seguir press shows Seguindo at once')
  t.alike({ ...followView({ following: true, pending: true, intent: false }) }, { following: false, busy: true }, 'a confirmed unfollow shows Seguir at once')
  t.alike({ ...followView({ following: false, pending: false, intent: true }) }, { following: true, busy: true }, 'the press holds the pill before pending lands')
  t.alike({ ...followView({ following: false, pending: true, intent: null }) }, { following: false, busy: true })
  t.alike({ ...followView({ following: false, pending: false, intent: undefined }) }, { following: false, busy: false })
})

test('Seguir flips at once, taps light and calls onFollow once per press', (t) => {
  const h = harness()
  const c = counter()
  const base = { following: false, title: 'Bia', pending: false, disabled: false, onFollow: c.onFollow, onUnfollow: c.onUnfollow }
  const first = h.render(base)
  t.is(pill(first).props.label, 'Seguir')
  t.is(pill(first).props.filled, true)
  t.absent(pill(first).props.tonal)
  t.alike(h.taps, [], 'rendering does not tap')

  const press = pill(first).props.onPress
  press()
  press()
  t.is(c.calls.follow, 1, 'two presses in one frame call once')
  t.alike(h.taps, ['light'])

  // The caller sets pending in the same handler, so the next commit has both.
  const flipped = h.render({ ...base, pending: true })
  t.is(pill(flipped).props.label, 'Seguindo', 'flips before the answer')
  t.is(pill(flipped).props.tonal, true)
  t.is(pill(flipped).props.pending, true)
  pill(flipped).props.onPress()
  t.absent(sheet(h.render()), 'a press while pending opens nothing')
  press()
  t.is(c.calls.follow, 1, 'presses while pending are ignored')
  t.is(c.calls.unfollow, 0)

  const done = h.render({ ...base, following: true, pending: false })
  t.is(pill(done).props.label, 'Seguindo')
  t.is(pill(done).props.pending, false)
  t.is(c.calls.follow, 1, 'nothing is resent when the request settles')
})

test('a failed follow shows the old state after the caller re-reads, and is never retried', (t) => {
  const h = harness()
  const c = counter()
  const base = { following: false, title: 'Bia', pending: false, disabled: false, onFollow: c.onFollow, onUnfollow: c.onUnfollow }
  pill(h.render(base)).props.onPress()
  t.is(pill(h.render({ ...base, pending: true })).props.label, 'Seguindo')
  const failed = h.render({ ...base, following: false, pending: false })
  t.is(pill(failed).props.label, 'Seguir', 'the re-read follow set is the truth')
  t.is(pill(failed).props.pending, false)
  t.is(c.calls.follow, 1, 'no retry')
  h.render(base)
  t.is(c.calls.follow, 1, 'later renders send nothing')
  pill(h.view).props.onPress()
  t.is(c.calls.follow, 2, 'a new press is a new single call')
})

test('a press the caller did not start lets go at the next commit', (t) => {
  const h = harness()
  const c = counter()
  const base = { following: false, title: 'Bia', pending: false, disabled: false, onFollow: c.onFollow, onUnfollow: c.onUnfollow }
  pill(h.render(base)).props.onPress()
  const after = h.render(base)
  t.is(pill(after).props.label, 'Seguir')
  t.is(pill(after).props.pending, false)
  t.is(c.calls.follow, 1)
})

test('Seguir does nothing while the follow set is unknown or the pill is disabled', (t) => {
  const c = counter()
  const unknown = harness()
  const a = unknown.render({ following: null, title: 'Bia', pending: false, disabled: false, onFollow: c.onFollow, onUnfollow: c.onUnfollow })
  t.is(pill(a).props.disabled, true)
  pill(a).props.onPress()
  const off = harness()
  const b = off.render({ following: false, title: 'Bia', pending: false, disabled: true, onFollow: c.onFollow, onUnfollow: c.onUnfollow })
  t.is(pill(b).props.disabled, true)
  pill(b).props.onPress()
  t.is(c.calls.follow, 0)
  t.alike(unknown.taps.concat(off.taps), [])
})

test('unfollow asks first and flips only after the confirm, calling onUnfollow once', (t) => {
  const h = harness()
  const c = counter()
  const base = { following: true, title: 'Bia', pending: false, disabled: false, onFollow: c.onFollow, onUnfollow: c.onUnfollow }
  const first = h.render(base)
  t.is(pill(first).props.label, 'Seguindo')
  pill(first).props.onPress()
  const asking = h.render()
  t.ok(sheet(asking), 'the confirm sheet opens')
  t.ok(nodes(asking).some((n) => n.type === 'Soft' && n.props.children === follow.UNFOLLOW_NOTE), 'with the unfollow note')
  t.is(pill(asking).props.label, 'Seguindo', 'opening the sheet does not flip')
  t.is(c.calls.unfollow, 0)

  btn(asking, 'Cancelar').props.onPress()
  const cancelled = h.render()
  t.absent(sheet(cancelled))
  t.is(pill(cancelled).props.label, 'Seguindo')
  t.is(c.calls.unfollow, 0, 'Cancelar sends nothing')

  pill(cancelled).props.onPress()
  const again = h.render()
  const confirm = btn(again, follow.UNFOLLOW_LABEL).props.onPress
  confirm()
  confirm()
  t.is(c.calls.unfollow, 1, 'two confirms in one frame call once')
  const flipped = h.render({ ...base, pending: true })
  t.absent(sheet(flipped))
  t.is(pill(flipped).props.label, 'Seguir', 'flips after the confirm')
  pill(flipped).props.onPress()
  t.is(c.calls.follow, 0, 'Seguir while pending is ignored')
  t.alike(h.taps, [], 'an unfollow does not tap')

  const failed = h.render({ ...base, following: true, pending: false })
  t.is(pill(failed).props.label, 'Seguindo', 'a failure shows the old state again')
  t.is(c.calls.unfollow, 1, 'no retry')
})

test('a press while the caller is already pending calls nothing', (t) => {
  const h = harness()
  const c = counter()
  const base = { following: false, title: 'Bia', pending: true, disabled: false, onFollow: c.onFollow, onUnfollow: c.onUnfollow }
  pill(h.render(base)).props.onPress()
  t.is(c.calls.follow, 0)
  t.alike(h.taps, [], 'no tap either')
  t.is(pill(h.render()).props.label, 'Seguir', 'nothing flips')
})

test('a confirm after the caller went pending calls nothing', (t) => {
  const h = harness()
  const c = counter()
  const base = { following: true, title: 'Bia', pending: false, disabled: false, onFollow: c.onFollow, onUnfollow: c.onUnfollow }
  pill(h.render(base)).props.onPress()
  t.ok(sheet(h.render()), 'the sheet is open')
  const busy = h.render({ ...base, pending: true })
  const confirm = btn(busy, follow.UNFOLLOW_LABEL)
  t.ok(confirm, 'the sheet is still open while pending')
  confirm.props.onPress()
  t.is(c.calls.unfollow, 0)
  t.is(pill(h.render()).props.label, 'Seguindo', 'nothing flips')
})

test('a late effect from the settled commit does not wipe the next press', (t) => {
  const h = harness()
  const c = counter()
  const base = { following: false, title: 'Bia', pending: false, disabled: false, onFollow: c.onFollow, onUnfollow: c.onUnfollow }
  pill(h.render(base)).props.onPress()
  h.render({ ...base, pending: true })
  // The request fails: the settle commit, then the re-render its effect asks
  // for, whose own effect has not run when the person presses again.
  h.commit({ ...base, following: false, pending: false })
  const again = h.commit()
  t.is(pill(again).props.label, 'Seguir')
  t.is(pill(again).props.pending, false, 'the pill is enabled again')
  pill(again).props.onPress()
  t.is(c.calls.follow, 2, 'the second press calls once')
  const flipped = h.render({ ...base, pending: true })
  t.is(pill(flipped).props.label, 'Seguindo', 'the second press stays flipped')
  t.is(pill(flipped).props.pending, true)
  const done = h.render({ ...base, following: true, pending: false })
  t.is(pill(done).props.label, 'Seguindo')
  t.is(pill(done).props.pending, false)
  t.is(c.calls.follow, 2, 'no retry')
})

test('the Seguir label defaults to FOLLOW_LABEL, can be replaced, and small passes through', (t) => {
  const c = counter()
  const plain = harness().render({ following: false, title: 'Bia', onFollow: c.onFollow, onUnfollow: c.onUnfollow })
  t.is(pill(plain).props.label, follow.FOLLOW_LABEL)
  t.absent(pill(plain).props.small)
  const custom = harness().render({ following: false, title: 'Bia', label: 'Seguir de volta', small: true, onFollow: c.onFollow, onUnfollow: c.onUnfollow })
  t.is(pill(custom).props.label, 'Seguir de volta')
  t.is(pill(custom).props.small, true)
  t.is(pill(custom).props.accessibilityLabel, 'seguir Bia')
  const followingSmall = harness().render({ following: true, title: 'Bia', label: 'Seguir de volta', small: true, onFollow: c.onFollow, onUnfollow: c.onUnfollow })
  t.is(pill(followingSmall).props.label, follow.FOLLOWING_LABEL)
  t.is(pill(followingSmall).props.small, true)
})

test('Membro draws its own page follow pill tonal while it says Seguindo', (t) => {
  const src = readFileSync(join(__dirname, '../src/screens/Membro.js'), 'utf8')
  t.ok(src.includes('tonal={!pageFollowsFailed && pageFollows !== null && pageFollows.has(author)}'))
})
