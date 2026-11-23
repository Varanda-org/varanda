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
  t.ok(importsFrom(hook, 'fetchDiscoverGroups', './indexClient'), 'imports fetchDiscoverGroups')
  t.ok(importsFrom(hook, 'fetchDiscoverCommunities', './indexClient'), 'imports fetchDiscoverCommunities')
  t.ok(importsFrom(hook, 'fanOut', './groupFanOut') && importsFrom(fanOutSource, 'fetchStandaloneGroupsOf', './indexClient.js'), 'reads standalone groups through fanOut')
  t.absent(/fetchGroupBrowse|fetchPublicGroups|communityName/.test(hook + fanOutSource), 'no legacy route and no community name')
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
  { group: 'group-a', name: 'Grupo A', creator: 'creator', writerCount: 5 },
  { group: 'group-b', name: 'Grupo B', creator: 'creator', writerCount: 8 }
]
const publicGroups = { ok: true, value: { hidden: false, groups: groupRows, next: null } }

function deferred () {
  let done
  const promise = new Promise((resolve) => { done = resolve })
  return { promise, resolve: done }
}

const EMPTY_GROUPS = { ok: true, value: { groups: [], more: false, indexing: false, complete: true } }
const EMPTY_COMMUNITIES = { ok: true, value: { communities: [], more: false, indexing: false, complete: true } }

async function mountShelves (t, fetchPage, { groupsAnswer = () => EMPTY_GROUPS, communitiesAnswer = () => EMPTY_COMMUNITIES, blocked = new Set() } = {}) {
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
  const communityCalls = []
  const publicCalls = []
  const unsubscribers = []
  const joined = []
  const deps = {
    react: hooks,
    './blocksProvider': { useBlocks: () => ({ loadState: 'ok', keys: blocked }) },
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
    // Any other index call (a legacy route) throws.
    './indexClient': new Proxy({
      fetchDiscoverGroups: async (order) => {
        browseCalls.push(order)
        return groupsAnswer(order)
      },
      fetchDiscoverCommunities: async (order) => {
        communityCalls.push(order)
        return communitiesAnswer(order)
      }
    }, {
      get: (target, name) => {
        if (name in target || typeof name !== 'string' || name === '__esModule') return target[name]
        throw new Error('unexpected index call: ' + name)
      }
    }),
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
    communityCalls,
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

test('the shelves read only the discover routes, groups and communities', async (t) => {
  const shelves = await mountShelves(t, async () => publicGroups)
  await shelves.render()
  t.alike(shelves.browseCalls, ['trending', 'members', 'recent'])
  t.alike(shelves.communityCalls, ['members', 'recent'])
  t.alike(shelves.publicCalls, ['diary'])
})

test('an older seeder (404 on every discover route) hides every shelf with no legacy call', async (t) => {
  const missing = { ok: false, reason: 'not-found' }
  const shelves = await mountShelves(t, async () => publicGroups, { groupsAnswer: () => missing, communitiesAnswer: () => missing })
  const view = await shelves.render()
  t.alike(view.shelves, [])
  t.alike(view.communityShelves, [])
  t.alike(shelves.publicCalls, [], 'no fan-out either')
  t.absent(shelves.rpcCalls.includes('follow.list'))
})

const key = (n) => n.toString(16).padStart(64, '0')
const community = (n, fields = {}) => ({ community: key(n), name: 'Comunidade ' + n, creator: key(90), join: 'open', members: 3, created: 1000 - n, ...fields })

test('community shelves carry name, members and join mode, and drop blocked communities and creators', async (t) => {
  const rows = [community(1), community(2, { join: 'approval', members: 1 }), community(3, { creator: key(91) }), community(4)]
  const blocked = new Set([key(4), key(91)])
  const shelves = await mountShelves(t, async () => publicGroups, {
    blocked,
    communitiesAnswer: (order) => ({ ok: true, value: { communities: order === 'members' ? rows : [], more: false, indexing: false, complete: false } })
  })
  const view = await shelves.render()
  t.is(view.communityShelves.length, 1, 'an empty list shows no shelf')
  const [shelf] = view.communityShelves
  t.is(shelf.id, 'members')
  t.is(shelf.title, 'Mais membros')
  t.ok(shelf.orderText.length > 0)
  t.is(shelf.note, 'A lista ainda está sendo atualizada; alguns grupos podem faltar.')
  t.alike(shelf.items, [
    { community: key(1), name: 'Comunidade 1', meta: '3\u00a0membros · Entrada aberta' },
    { community: key(2), name: 'Comunidade 2', meta: '1\u00a0membro · Entrada com aprovação' }
  ])
  t.absent(view.shelves.some((s) => s.items.some((i) => 'communityName' in i)), 'group rows carry no community name')
})
