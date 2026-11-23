'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const load = () => import('../src/groupsUnreadRead.js')

const keys = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(64))
const communities = keys.map((community) => ({ community, state: 'ready', role: 'member' }))
const group = (unread, role = 'member') => ({ group: keys[0], role, unread })

test('the first unread group stops a serial read', async (t) => {
  const { readGroupsUnread } = await load()
  const calls = []
  const unread = await readGroupsUnread(async (method, params) => {
    calls.push([method, params])
    if (method === 'community.list') return { communities }
    if (method === 'group.standalone') return { groups: [], total: 0 }
    return { groups: [group(1)] }
  }, { atOnce: 1 })
  t.is(unread, true)
  t.alike(calls, [['community.list', {}], ['community.info', { community: keys[0] }]])
})

test('only ready member communities and member group rows count', async (t) => {
  const { readGroupsUnread } = await load()
  const calls = []
  const unread = await readGroupsUnread(async (method, params) => {
    if (method === 'community.list') {
      return {
        communities: [
          communities[0],
          { ...communities[1], state: 'pending' },
          { ...communities[2], role: 'left' },
          { ...communities[3], community: keys[3].toUpperCase() },
          { community: 42, state: 'ready', role: 'admin' },
          null
        ]
      }
    }
    if (method === 'group.standalone') return { groups: [], total: 0 }
    calls.push(params.community)
    return { groups: [group(0, 'creator'), group(2, 'left'), group(0.5, 'admin')] }
  })
  t.is(unread, false)
  t.alike(calls, [keys[0]])
})

test('a failed or missing answer cannot clear the dot', async (t) => {
  const { readGroupsUnread } = await load()
  for (const failure of [
    () => { throw new Error('community unavailable') },
    () => undefined
  ]) {
    const unread = await readGroupsUnread(async (method, { community }) => {
      if (method === 'community.list') return { communities }
      if (method === 'group.standalone') return { groups: [], total: 0 }
      return community === keys[1] ? failure() : { groups: [group(0)] }
    })
    t.is(unread, null)
  }
  t.is(await readGroupsUnread(async () => { throw new Error('list unavailable') }), null)
  t.is(await readGroupsUnread(async () => undefined), null)
})

test('an incomplete answer with no unread groups can clear the dot', async (t) => {
  const { readGroupsUnread } = await load()
  const unread = await readGroupsUnread(async (method) => {
    if (method === 'community.list') return { communities }
    if (method === 'group.standalone') return { groups: [], total: 0 }
    return { groups: [group(0)], incomplete: true }
  })
  t.is(unread, false)
})

const solo = ['e', 'f'].map((letter) => letter.repeat(64))

test('groups without community are paged and counted after the community reads', async (t) => {
  const { readGroupsUnread } = await load()
  const calls = []
  const unread = await readGroupsUnread(async (method, params) => {
    calls.push([method, params])
    if (method === 'community.list') return { communities: [] }
    if (params.offset === undefined) return { groups: [{ group: solo[0], role: 'creator', unread: 0 }], total: 2 }
    return { groups: [{ group: solo[1], role: 'member', unread: 3 }], total: 2 }
  })
  t.is(unread, true)
  t.alike(calls, [['community.list', {}], ['group.standalone', {}], ['group.standalone', { offset: 1 }]])
})

test('a failed standalone read is partial, an older node is not', async (t) => {
  const { readGroupsUnread } = await load()
  const read = (standalone) => readGroupsUnread(async (method, params) => {
    if (method === 'community.list') return { communities: [] }
    return standalone(params)
  })
  t.is(await read(() => { throw new Error('no answer') }), null)
  t.is(await read((p) => ({ groups: p.offset ? [] : [{ group: solo[0], role: 'member', unread: 0 }], total: 2 })), null, 'a short page')
  t.is(await read(() => { throw Object.assign(new Error('método desconhecido'), { code: 'USAGE' }) }), false)
  t.is(await read(() => ({ groups: [{ group: solo[0], role: 'member', unread: 0 }], total: 1 })), false)
})

test('a failed community read keeps the standalone rows', async (t) => {
  const { readGroupsUnread } = await load()
  const unread = await readGroupsUnread(async (method) => {
    if (method === 'community.list') throw new Error('list unavailable')
    return { groups: [{ group: solo[0], role: 'member', unread: 2 }], total: 1 }
  })
  t.is(unread, true)
})

test('at most atOnce community reads run together', async (t) => {
  const { readGroupsUnread } = await load()
  const pending = new Map()
  let releaseFirstPair
  let releaseSecondPair
  const firstPair = new Promise((resolve) => { releaseFirstPair = resolve })
  const secondPair = new Promise((resolve) => { releaseSecondPair = resolve })
  const result = readGroupsUnread(async (method, { community }) => {
    if (method === 'community.list') return { communities }
    if (method === 'group.standalone') return { groups: [], total: 0 }
    return new Promise((resolve) => {
      pending.set(community, () => {
        pending.delete(community)
        resolve({ groups: [group(0)] })
      })
      if (community === keys[1]) releaseFirstPair()
      if (community === keys[3]) releaseSecondPair()
    })
  }, { atOnce: 2 })
  await firstPair
  t.alike([...pending.keys()], keys.slice(0, 2))
  pending.get(keys[0])()
  pending.get(keys[1])()
  await secondPair
  t.alike([...pending.keys()], keys.slice(2))
  pending.get(keys[2])()
  pending.get(keys[3])()
  t.is(await result, false)
})

test('an unread group in a partial answer wins without waiting for another request', async (t) => {
  const { readGroupsUnread } = await load()
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  const calls = []
  const result = readGroupsUnread(async (method, { community }) => {
    if (method === 'community.list') return { communities }
    if (method === 'group.standalone') return { groups: [], total: 0 }
    calls.push(community)
    return community === keys[0] ? pending : { groups: [group(1, 'admin')], incomplete: true }
  }, { atOnce: 2 })
  t.is(await result, true)
  t.alike(calls, keys.slice(0, 2))
  finish({ groups: [] })
})

test('an expired read stops before starting another community', async (t) => {
  const { readGroupsUnread } = await load()
  let alive = true
  const calls = []
  const unread = await readGroupsUnread(async (method, { community }) => {
    if (method === 'community.list') return { communities }
    if (method === 'group.standalone') return { groups: [], total: 0 }
    calls.push(community)
    alive = false
    return { groups: [group(2)] }
  }, { atOnce: 1, alive: () => alive })
  t.is(unread, null)
  t.alike(calls, [keys[0]])
})

const tick = () => new Promise((resolve) => setImmediate(resolve))

function deferred () {
  let finish
  const promise = new Promise((resolve) => { finish = resolve })
  return { promise, resolve: finish }
}

async function scheduler (read = () => false, options = {}) {
  const { createGroupsDotScheduler } = await load()
  let time = 0
  let next = 0
  const timers = new Map()
  const started = []
  const applied = []
  const s = createGroupsDotScheduler({
    ...options,
    read: (...args) => {
      started.push(time)
      return read(...args)
    },
    apply: (result) => { applied.push(result) },
    now: () => time,
    setTimer: (fn, ms) => {
      timers.set(++next, { fn, at: time + ms })
      return next
    },
    clearTimer: (id) => { timers.delete(id) }
  })
  async function advance (ms) {
    const end = time + ms
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, { fn, at }] = due
      time = at
      timers.delete(id)
      fn()
      await tick()
    }
    time = end
  }
  return { s, advance, timers, started, applied }
}

test('one scheduler trigger reads once', async (t) => {
  const { s, advance, started, applied } = await scheduler()
  s.trigger()
  await tick()
  await advance(30000)
  t.alike(started, [0])
  t.alike(applied, [false])
})

test('five triggers within the gap coalesce at the end of the first window', async (t) => {
  const { s, advance, started, applied } = await scheduler()
  for (let i = 0; i < 5; i++) {
    s.trigger()
    await tick()
    await advance(500)
  }
  t.alike(started, [0])
  await advance(500)
  t.alike(started, [0, 3000])
  await advance(30000)
  t.alike(applied, [false, false])
})

test('triggers during a slow read keep its result and queue exactly one cycle', async (t) => {
  const first = deferred()
  const second = deferred()
  const reads = [first.promise, second.promise]
  const { s, advance, started, applied } = await scheduler(() => reads.shift())
  s.trigger()
  await advance(1000)
  s.trigger()
  await advance(3000)
  s.trigger()
  t.alike(started, [0], 'the throttle window can pass while the first read still owns the slot')
  first.resolve(true)
  await tick()
  t.alike(applied, [true], 'the first result survives the triggers')
  t.alike(started, [0, 4000])
  second.resolve(false)
  await tick()
  await advance(30000)
  t.alike(started, [0, 4000])
  t.alike(applied, [true, false])
})

test('reset frees the slot immediately and discards the old result and trailing cycle', async (t) => {
  const first = deferred()
  const second = deferred()
  const reads = [first.promise, second.promise]
  const { s, advance, timers, started, applied } = await scheduler(() => reads.shift())
  s.trigger()
  await advance(1000)
  s.trigger()
  s.reset()
  t.is(timers.size, 0)
  s.trigger()
  t.alike(started, [0, 1000])
  first.resolve(true)
  await tick()
  t.alike(applied, [])
  second.resolve(false)
  await tick()
  await advance(30000)
  t.alike(started, [0, 1000])
  t.alike(applied, [false])
})

test('reset clears an armed trailing timer', async (t) => {
  const { s, advance, timers, started } = await scheduler()
  s.trigger()
  await tick()
  s.trigger()
  t.is(timers.size, 1)
  s.reset()
  t.is(timers.size, 0)
  await advance(30000)
  t.alike(started, [0])
})

test('stop clears a live deadline and ignores a late result and later triggers', async (t) => {
  const result = deferred()
  const { s, advance, timers, started, applied } = await scheduler(() => result.promise)
  s.trigger()
  s.trigger()
  t.is(timers.size, 1)
  s.stop()
  t.is(timers.size, 0)
  result.resolve(true)
  await tick()
  s.trigger()
  await advance(30000)
  t.alike(started, [0])
  t.alike(applied, [])
})

test('a read deadline reports unknown and releases the slot for the next trigger', async (t) => {
  const result = deferred()
  const reads = [result.promise, false]
  const { s, advance, started, applied } = await scheduler(() => reads.shift())
  s.trigger()
  await advance(59999)
  t.alike(applied, [])
  await advance(1)
  t.alike(applied, [null])
  s.trigger()
  result.resolve(true)
  await tick()
  await advance(30000)
  t.alike(started, [0, 60000])
  t.alike(applied, [null, false])
})

test('an early unread result applies while other requests still hold the cycle', async (t) => {
  const { readGroupsUnread } = await load()
  const pending = deferred()
  const request = async (method, { community }) => {
    if (method === 'community.list') return { communities: communities.slice(0, 2) }
    return community === keys[0] ? pending.promise : { groups: [group(1)] }
  }
  const { s, advance, started, applied } = await scheduler((alive, onUnread) => readGroupsUnread(request, { alive, onUnread }))
  s.trigger()
  await tick()
  t.alike(applied, [true])
  s.trigger()
  await advance(4000)
  t.alike(started, [0])
  pending.resolve({ groups: [] })
  await tick()
  t.alike(started, [0, 4000])
  t.alike(applied, [true, true])
})

test('unknown or thrown reads retry once, 15000 ms after finishing', async (t) => {
  const result = deferred()
  const reads = [() => result.promise, () => { throw new Error('offline') }, () => false]
  const { s, advance, started, applied } = await scheduler(() => reads.shift()())
  s.trigger()
  await advance(2000)
  result.resolve(null)
  await tick()
  await advance(14999)
  t.alike(started, [0])
  await advance(1)
  t.alike(started, [0, 17000])
  t.alike(applied, [null, null])
  await advance(15000)
  t.alike(started, [0, 17000])
  s.trigger()
  await tick()
  t.alike(applied, [null, null, false])
})

test('a queued cycle replaces the retry and stop clears an armed retry', async (t) => {
  const first = deferred()
  const reads = [first.promise, null]
  const { s, advance, timers, started } = await scheduler(() => reads.shift())
  s.trigger()
  s.trigger()
  first.resolve(null)
  await tick()
  t.is(timers.size, 1)
  await advance(3000)
  t.alike(started, [0, 3000])
  t.is(timers.size, 1)
  s.stop()
  t.is(timers.size, 0)
  await advance(30000)
  t.alike(started, [0, 3000])
})

test('a queued cycle skips the read on Conversas and can run again after leaving', async (t) => {
  let onScreen = false
  const { s, advance, started } = await scheduler(undefined, { canRead: () => !onScreen })
  s.trigger()
  await tick()
  s.trigger()
  onScreen = true
  await advance(3000)
  t.alike(started, [0])
  onScreen = false
  s.trigger()
  await tick()
  t.alike(started, [0, 3000])
})

test('App wires the Conversas badge to actual unread state and the acting inbox', (t) => {
  const app = readFileSync(join(__dirname, '..', 'App.js'), 'utf8')
  t.absent(/\bgroupsBadge\b/.test(app))
  t.absent(/\bsetGroupSeen\b/.test(app))
  t.absent(/\backCaughtUp\s*\(/.test(app))
  t.ok(/comunidades:\s*conversasDot\(/.test(app))
  t.ok(/dmRequest\('dm\.list',\s*badgeListParams\(/.test(app))
  t.ok(/<Conversas\b[^>]*\bonGroupsUnread=/.test(app))
  t.ok(/\bsettleGroups\(/.test(app))
  t.ok(/return \(\) => scheduler\.reset\(\)\n\s*\}, \[[^\]]*\bconversasOnScreen\b[^\]]*\]\)/.test(app), 'opening Conversas drops a sweep in flight')
})
