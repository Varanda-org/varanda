'use strict'

const test = require('brittle')

const load = () => import('../src/rowPeek.js')
const key = (n) => String(n).repeat(64).slice(0, 64)

test('planRowPeeks asks only top rows the node has no profile for, once per scope', async (t) => {
  const { planRowPeeks, PEEK_BATCH } = await load()
  const peers = [key(1), key(2), key(3), key(4), key(5), key(6), key(7)]
  const profiles = new Map([[key(1), { name: 'Ana' }], [key(2), undefined], [key(3), null], [key(4), null]])
  const profileOf = (peer) => (profiles.has(peer) ? profiles.get(peer) : null)
  const tried = new Set()
  const args = { peers, profileOf, isPeeked: () => false, tried, scope: '1:0' }
  t.alike(planRowPeeks(args), [key(3), key(4), key(5), key(6)], 'named and not-yet-read rows never ask; the batch is bounded')
  t.is(PEEK_BATCH, 4)
  tried.add('1:0:' + key(3).toLowerCase())
  t.alike(planRowPeeks(args), [key(4), key(5), key(6), key(7)], 'a key already asked is left out')
  t.alike(planRowPeeks({ ...args, scope: '2:0' }).slice(0, 1), [key(3)], 'a new scope asks again')
  t.alike(planRowPeeks({ ...args, isPeeked: (peer) => peer === key(4) }).includes(key(4)), false, 'a shown verified peek is not asked')
  t.alike(planRowPeeks({ ...args, tried: new Set(), window: 3 }), [key(3)], 'only the rows near the top ask')
  t.alike(planRowPeeks({ ...args, peers: null }), [])
})

test('runRowPeeks reads one at a time, learns only verified entries and never repeats', async (t) => {
  const { planRowPeeks, runRowPeeks } = await load()
  const { PEER_GONE } = await import('../src/peerProfile.js')
  const peers = [key(1), key(2), key(3), key(4), key(5), key(6)]
  const names = new Map()
  const tried = new Set()
  const asked = []
  let inflight = 0
  let overlap = false
  const answers = { [key(1)]: { name: 'Ana', username: 'ana', bio: null, avatar: null }, [key(2)]: null, [key(3)]: PEER_GONE }
  const forgotten = []
  const run = () => runRowPeeks({
    plan: () => planRowPeeks({ peers, profileOf: (p) => names.get(p) ?? null, isPeeked: () => false, tried, scope: 's' }),
    tried,
    scope: 's',
    read: async (peer) => {
      inflight++
      if (inflight > 1) overlap = true
      asked.push(peer)
      await Promise.resolve()
      inflight--
      return peer in answers ? answers[peer] : null
    },
    current: () => true,
    learn: (peer, entry) => names.set(peer, entry),
    forget: (peer) => forgotten.push(peer)
  })
  await run()
  t.alike(asked, peers, 'each row asked once, in order')
  t.absent(overlap, 'one read at a time')
  t.is(names.get(key(1)).name, 'Ana')
  t.is(names.has(key(2)), false, 'an answer with no verified name teaches nothing')
  t.alike(forgotten, [key(3)])
  await run()
  t.is(asked.length, 6, 'a second pass over the same rows asks nothing')
})

test('runRowPeeks stops when the screen is left or the scope moves', async (t) => {
  const { runRowPeeks } = await load()
  let live = true
  const asked = []
  const tried = new Set()
  await runRowPeeks({
    plan: () => [key(1), key(2), key(3)].filter((p) => !tried.has('s:' + p)),
    tried,
    scope: 's',
    read: async (peer) => { asked.push(peer); live = false; return null },
    current: () => live,
    learn: () => t.fail('no learn after the run stopped'),
    forget: () => {}
  })
  t.alike(asked, [key(1)])
  let late = true
  await runRowPeeks({
    plan: () => [key(4)],
    tried: new Set(),
    scope: 's',
    read: async () => { late = false; return { name: 'Atrasada', username: null, bio: null, avatar: null } },
    current: () => late,
    learn: () => t.fail('an answer that lands after the stop is dropped'),
    forget: () => t.fail('nor a forget')
  })
  t.pass()
})

test('the Conversas list wires the row peek to the names cache and the header reader', (t) => {
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const screen = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  t.ok(screen.includes('const peekGate = hosted && ready && active && node.visible !== false && node.online !== false'), 'hosted, on screen, online')
  t.ok(screen.includes('readPeerEntry(peer, {') && screen.includes("request('diary.peek', params)"), 'the same verified reader as the header')
  t.ok(screen.includes('learnVerified([[peer, entry]], scope)'), 'only a verified entry names a row')
})

test('runRowPeeks un-marks a key whose read the stop cut short, so the next walk asks it', async (t) => {
  const { runRowPeeks } = await load()
  const tried = new Set()
  let live = true
  await runRowPeeks({
    plan: () => [key(1)],
    tried,
    scope: 's',
    read: async () => { live = false; return { name: 'Ana', username: 'ana', bio: null, avatar: null } },
    current: () => live,
    learn: () => t.fail('nothing learned after the stop'),
    forget: () => {}
  })
  t.is(tried.has('s:' + key(1).toLowerCase()), false, 'the cut read does not count as asked')
  const names = []
  live = true
  await runRowPeeks({
    plan: () => (tried.has('s:' + key(1).toLowerCase()) ? [] : [key(1)]),
    tried,
    scope: 's',
    read: async () => ({ name: 'Ana', username: 'ana', bio: null, avatar: null }),
    current: () => live,
    learn: (peer, entry) => names.push(entry.name),
    forget: () => {}
  })
  t.alike(names, ['Ana'], 'the next walk asks again and names the row')
})

test('runRowPeeks batches member hints before serial reads and drops a cancelled batch', async (t) => {
  const { runRowPeeks } = await load()
  for (const cancelled of [false, true]) {
    const peers = [key(1), key(2), key(3)]
    const tried = new Set()
    const calls = []
    const members = peers.map((peer) => ({ ok: true, value: { peer } }))
    let current = true
    await runRowPeeks({
      plan: () => peers.filter((p) => !tried.has('s:' + p)),
      tried,
      scope: 's',
      lookupMany: async (keys) => {
        t.alike(keys, peers)
        calls.push('batch')
        if (cancelled) current = false
        return members
      },
      read: async (peer, member) => {
        t.is(member, members[peers.indexOf(peer)])
        calls.push(peer)
        return null
      },
      current: () => current,
      learn: () => t.fail('no verified entry'),
      forget: () => t.fail('no missing diary')
    })
    t.alike(calls, cancelled ? ['batch'] : ['batch', ...peers])
    t.is(tried.size, cancelled ? 0 : 3)
  }
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  for (const file of ['screens/Conversas.js', 'useRowPeeks.js']) {
    const src = readFileSync(join(__dirname, '../src', file), 'utf8')
    t.ok(src.includes('lookupMany: fetchMembers,'), file + ' batches the member phase')
    t.ok(src.includes('fetchMember: () => member,'), file + ' reuses the batch result')
  }
})
