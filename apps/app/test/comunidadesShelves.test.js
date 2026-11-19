'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { transformSync } = require('@babel/core')

const SRC = path.join(__dirname, '..', 'src')
const screen = fs.readFileSync(path.join(SRC, 'screens', 'Comunidades.js'), 'utf8')
const hook = fs.readFileSync(path.join(SRC, 'useGroupShelves.js'), 'utf8')
const fanOutSource = fs.readFileSync(path.join(SRC, 'groupFanOut.js'), 'utf8')

function importsFrom (src, name, from) {
  const re = new RegExp('import\\s*\\{[^}]*\\b' + name + '\\b[^}]*\\}\\s*from\\s*\'' + from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '\'')
  return re.test(src)
}

test('Comunidades draws the shelves from useGroupShelves', (t) => {
  t.ok(importsFrom(screen, 'useGroupShelves', '../useGroupShelves'), 'imports the hook')
  t.ok(importsFrom(screen, 'GroupShelf', '../ui/GroupShelf'), 'imports GroupShelf')
  t.ok(screen.includes('<GroupShelf'), 'renders GroupShelf')
  t.ok(screen.includes("query.trim() === '' ? shelves.map("), 'only while the search is empty')
  t.ok(/useGroupShelves\(\{ enabled: hosted,/.test(screen), 'enabled only on a hosted node')
  t.ok(screen.includes('onRefresh={refresh}') && /const refresh = \(\) => \{\s*load\(\)\s*reloadShelves\(\)/.test(screen), 'pull to refresh reloads both')
})

test('useGroupShelves reads blocks, follows and the index', (t) => {
  t.ok(importsFrom(hook, 'useBlocks', './blocksProvider'), 'imports useBlocks')
  t.ok(importsFrom(hook, 'readFollowKeys', './follow'), 'imports readFollowKeys')
  t.ok(importsFrom(hook, 'fetchGroupBrowse', './indexClient'), 'imports fetchGroupBrowse')
  t.ok(importsFrom(hook, 'fanOut', './groupFanOut') && importsFrom(fanOutSource, 'fetchPublicGroups', './indexClient.js'), 'reads public groups through fanOut')
  t.ok(importsFrom(hook, 'registerLocalCache', './localCaches'), 'imports registerLocalCache')
  t.ok(hook.includes("blocks.loadState === 'ok'"), 'waits for the loaded block list')
})

test('useGroupShelves pages group.list within the rpc cap', (t) => {
  t.ok(hook.includes('limit: GROUP_LIST_LIMIT'), 'group.list limit is GROUP_LIST_LIMIT')
  t.absent(hook.includes('limit: 100'), 'never limit 100')
})

test('useGroupShelves never asks the index per group', (t) => {
  t.absent((hook + fanOutSource).includes('fetchGroup('), 'no fetchGroup call')
})

test('the followed shelf is derived on render from raw rows', (t) => {
  const memo = hook.slice(hook.indexOf('const shelves = useMemo('))
  t.ok(memo.length > 0 && hook.includes('const shelves = useMemo('), 'shelves in a useMemo')
  t.ok(memo.includes('tallyFollowed('), 'tallyFollowed runs in the render path')
  t.ok(/\}, \[[^\]]*\bblocked\b[^\]]*\]\)/.test(memo), 'the memo depends on the block list')
  t.ok(hook.includes('const blocked = blocks.keys'), 'blocked is blocks.keys')
  t.is(hook.split('tallyFollowed(').length - 1, 1, 'tallyFollowed is called only there, never before caching')
  t.ok(hook.includes('followCache.set(key, entry)'), 'the cache holds the raw entry')
})

test('a fan-out that crossed a block, an unfollow or a wipe commits nothing', (t) => {
  const guard = hook.indexOf('if (gen !== cacheGeneration()) return')
  t.ok(guard > -1, 'the generation guard returns early')
  const commit = hook.indexOf('setFollowed({ key, ...entry })')
  t.ok(commit > guard, 'setFollowed of the fan-out result comes after the guard')
  t.ok(hook.indexOf('followCache.set(key, entry)') > guard, 'the cache write comes after the guard')
})

test('no platform branch and no em dash', (t) => {
  for (const [name, src] of [['useGroupShelves.js', hook], ['Comunidades.js', screen]]) {
    t.absent(src.includes('Platform.OS'), name + ' has no Platform.OS')
    t.absent(src.includes(String.fromCharCode(0x2014)), name + ' has no em dash')
  }
})

const groupRows = [
  { group: 'group-a', name: 'Grupo A', community: 'community', creator: 'creator', writerCount: 5 },
  { group: 'group-b', name: 'Grupo B', community: 'community', creator: 'creator', writerCount: 8 }
]
const publicGroups = { ok: true, value: { hidden: false, groups: groupRows, next: null } }

function deferred () {
  let done
  const promise = new Promise((resolve) => { done = resolve })
  return { promise, resolve: done }
}

async function mountShelves (t, fetchPage) {
  const { fanOut } = await import('../src/groupFanOut.js')
  const caches = await import('../src/localCaches.js')
  const slots = []
  const effects = []
  let cursor = 0
  let dirty = false
  const hooks = {
    useRef: (current) => (slots[cursor++] ??= { current }),
    useState: (initial) => {
      const slot = (slots[cursor++] ??= { value: initial })
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (!Object.is(slot.value, value)) {
          slot.value = value
          dirty = true
        }
      }]
    },
    useEffect: (effect, deps) => {
      const slot = (slots[cursor++] ??= {})
      if (slot.deps && deps.every((value, i) => Object.is(value, slot.deps[i]))) return
      slot.deps = deps
      effects.push(() => {
        slot.cleanup?.()
        slot.cleanup = effect()
      })
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn()
  }
  const rpcCalls = []
  const browseCalls = []
  const publicCalls = []
  const unsubscribers = []
  const joined = []
  const deps = {
    react: hooks,
    './blocksProvider': { useBlocks: () => ({ loadState: 'ok', keys: new Set() }) },
    './follow': await import('../src/follow.js'),
    './groupFanOut': {
      fanOut: (sample, alive) => fanOut(sample, alive, {
        fetchPage: (diary, after) => {
          publicCalls.push(diary)
          return fetchPage(diary, after)
        }
      })
    },
    './groups': await import('../src/groups.js'),
    './indexClient': {
      fetchGroupBrowse: async (order) => {
        browseCalls.push(order)
        return { ok: true, value: { groups: [] } }
      }
    },
    './localCaches': {
      ...caches,
      registerLocalCache: (entry) => {
        const unsubscribe = caches.registerLocalCache(entry)
        unsubscribers.push(unsubscribe)
        return unsubscribe
      }
    },
    './groupShelves': await import('../src/groupShelves.js')
  }
  const { code } = transformSync(hook, { babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'] })
  const exports = {}
  // eslint-disable-next-line no-new-func
  new Function('require', 'exports', code)((name) => deps[name], exports)
  const props = {
    enabled: true,
    pageKey: null,
    bindingKey: 'binding',
    groupVersions: {},
    request: async (method) => {
      rpcCalls.push(method)
      if (method === 'group.list') return { groups: joined.slice(), total: joined.length }
      if (method === 'follow.list') return { follows: ['diary'], total: 1 }
      throw new Error('unexpected request: ' + method)
    }
  }
  const unmount = () => {
    for (const slot of slots) slot.cleanup?.()
    slots.length = 0
  }
  t.teardown(() => {
    unmount()
    for (const unsubscribe of unsubscribers) unsubscribe()
  })
  return {
    async render (overrides) {
      Object.assign(props, overrides)
      let result
      do {
        dirty = false
        cursor = 0
        result = exports.useGroupShelves(props)
        for (const effect of effects.splice(0)) effect()
        await new Promise((resolve) => setImmediate(resolve))
      } while (dirty)
      return result
    },
    unmount,
    joined,
    rpcCalls,
    browseCalls,
    publicCalls,
    wipe: caches.wipeLocalCaches
  }
}

function followedGroups (view) {
  return view.shelves.find(({ id }) => id === 'followed')?.items.map(({ group }) => group) ?? []
}

test('refresh reloads browse lists while the current followed read stays in flight', async (t) => {
  const pending = deferred()
  const shelves = await mountShelves(t, () => pending.promise)
  const view = await shelves.render()
  t.alike(shelves.publicCalls, ['diary'])
  view.reload()
  await shelves.render()
  t.alike(shelves.browseCalls, ['trending', 'members', 'recent', 'trending', 'members', 'recent'])
  t.is(shelves.rpcCalls.filter((method) => method === 'follow.list').length, 1)
  t.alike(shelves.publicCalls, ['diary'])
  pending.resolve(publicGroups)
  t.alike(followedGroups(await shelves.render()), ['group-a', 'group-b'])
})

test('a wipe lets refresh load followed rows again before the superseded request replies', async (t) => {
  const pending = deferred()
  const next = deferred()
  const reads = [pending, next]
  const shelves = await mountShelves(t, async () => reads.shift()?.promise ?? publicGroups)
  const view = await shelves.render()
  shelves.wipe()
  view.reload()
  await shelves.render()
  t.alike(shelves.publicCalls, ['diary', 'diary'])
  pending.resolve(publicGroups)
  t.alike(followedGroups(await shelves.render()), [])
  view.reload()
  await shelves.render()
  t.alike(shelves.publicCalls, ['diary', 'diary'], 'the superseded run leaves the current run marked')
  next.resolve(publicGroups)
  t.alike(followedGroups(await shelves.render()), ['group-a', 'group-b'])
})

test('a superseded binding and an unmounted run leave no followed rows behind', async (t) => {
  const first = deferred()
  const second = deferred()
  const reads = [first, second]
  const shelves = await mountShelves(t, async () => reads.shift()?.promise ?? publicGroups)
  await shelves.render()
  const view = await shelves.render({ bindingKey: 'other' })
  t.alike(shelves.publicCalls, ['diary', 'diary'])
  first.resolve(publicGroups)
  t.alike(followedGroups(await shelves.render()), [])
  view.reload()
  await shelves.render()
  t.alike(shelves.publicCalls, ['diary', 'diary'])

  shelves.unmount()
  second.resolve(publicGroups)
  await new Promise((resolve) => setImmediate(resolve))
  t.alike(followedGroups(await shelves.render()), ['group-a', 'group-b'])
  t.alike(shelves.publicCalls, ['diary', 'diary', 'diary'], 'the remount starts a new read')
})

test('joining removes the group from the followed shelf using the rows already fetched', async (t) => {
  const pending = deferred()
  const shelves = await mountShelves(t, () => pending.promise)
  await shelves.render()
  await shelves.render({ groupVersions: { 'group-a': 1 } })
  t.alike(shelves.publicCalls, ['diary'], 'a group event leaves a pending fan-out alone')
  pending.resolve(publicGroups)
  t.alike(followedGroups(await shelves.render()), ['group-a', 'group-b'])
  shelves.joined.push({ group: 'group-a', role: 'member' })
  t.alike(followedGroups(await shelves.render({ groupVersions: { 'group-a': 2 } })), ['group-b'])
  t.alike(shelves.rpcCalls, ['group.list', 'follow.list', 'group.list', 'group.list'])
  t.alike(shelves.publicCalls, ['diary'])
  t.alike(shelves.browseCalls, ['trending', 'members', 'recent'])
})

test('a followed read that failed before any row is not kept, so refresh asks again', async (t) => {
  const reads = [{ ok: false, reason: 'rede' }, publicGroups]
  const shelves = await mountShelves(t, async () => reads.shift())
  const view = await shelves.render()
  t.alike(followedGroups(view), [])
  t.alike(shelves.publicCalls, ['diary'])
  view.reload()
  t.alike(followedGroups(await shelves.render()), ['group-a', 'group-b'])
  t.alike(shelves.publicCalls, ['diary', 'diary'])
  view.reload()
  await shelves.render()
  t.alike(shelves.publicCalls, ['diary', 'diary'], 'a read that answered stays fresh')
})
