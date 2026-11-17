'use strict'

// The automatic history copy when the receiver's continuous run loses its
// link (docs/protocol.md section 11): a record that turns the device off may
// be on the way, so a copy that arrives meanwhile waits until the own diary
// is caught up again. Real Seeder and browser nodes over the real runSync;
// the link loss and the catch-up are events handed to the run. Local DHT and
// tmp dirs only.

const test = require('brittle')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const gc = require('@varanda/core/lib/group-crypto')
const { dmLocalKeyFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const { hex, seederHost, memberNode } = require('./helpers/dm-e2e')
const { BLOB, sleep, copyDiary, sweepPool, textsOf } = require('./helpers/dm-copy')
const { account, sibling, copiesOf, copied, kick } = require('./helpers/dm-auto')

// createBrowserNode over the real runSync, each run recorded with its events
// and its event handler; while a run is `down` its own-synced events are held
// back, as a lost link would. The module cache is restored.
function droppableSync () {
  const runs = []
  const sync = require('../lib/sync')
  const original = sync.runSync
  const ids = [require.resolve('../lib/node'), require.resolve('../lib/session')]
  const cached = ids.map((id) => require.cache[id])
  let factory
  try {
    sync.runSync = (opts) => {
      const r = { once: opts.once, down: false, events: [], deliver: opts.onEvent }
      runs.push(r)
      return original({
        ...opts,
        onEvent: (ev) => {
          if (ev) r.events.push(ev)
          if (r.down && ev && ev.event === 'own-synced') return
          return opts.onEvent(ev)
        }
      })
    }
    for (const id of ids) delete require.cache[id]
    factory = require('../lib/node').createBrowserNode
  } finally {
    sync.runSync = original
    ids.forEach((id, i) => { require.cache[id] = cached[i] })
  }
  return { runs, factory }
}

test('a copy that reaches a device whose link dropped waits until its own diary is caught up again', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const acct = await account(t, assoc, host, { old: 1, fresh: 1, blob: BLOB })
  const A = acct.first
  const P = await memberNode(t, assoc, host, { blob: BLOB })
  await copyDiary(A, P)
  await copyDiary(P, A)
  await A.web.request('dm.send', { to: P.key, text: 'oi' })
  await P.web.request('dm.pull')
  await P.web.request('dm.send', { to: A.key, text: 'tudo' })
  await A.web.request('dm.pull')
  // The pool forgets the originals: what C gets comes from the copy.
  await sweepPool(host)

  const [idC] = acct.fresh
  const sync = droppableSync()
  const C = await sibling(t, assoc, host, acct, idC, { blob: BLOB, factory: sync.factory })
  await C.web.request('sync.start', {})
  let run = null
  await until(() => {
    run = sync.runs.find((x) => !x.once && x.events.some((e) => e.event === 'own-synced')) || null
    return run !== null
  }, { name: 'own diary caught up', timeoutMs: 60000, intervalMs: 250 })
  // Caught up, C takes itself for on.
  t.is((await C.web.request('device.list')).off, false, 'the new device is on')
  const caught = run.events.filter((e) => e.event === 'own-synced').pop()

  // The link drops before the copy arrives.
  run.down = true
  run.deliver({ event: 'link-closed' })
  await kick(A)
  const copy = copiesOf(await copied(t, host, acct))[0]
  const id = copy.body.id
  await C.web.request('device.list')
  await C.web.request('dm.pull')
  const localKey = await dmLocalKeyFromPrf(acct.prf)
  const stateOf = async () => {
    const sealed = await store.readDmCopy(C.storage)
    return sealed === null ? null : gc.openRecord(sealed, localKey)
  }
  await until(async () => {
    const s = await stateOf()
    return s !== null && (s.todo.some((x) => x.id === id) || s.imported.includes(id))
  }, { name: 'copy pointer noted', timeoutMs: 30000, intervalMs: 250 })
  await sleep(3000)
  t.absent(C.web.events.some((e) => e.name === 'dm.copyImported'), 'nothing imported while the link is down')
  t.ok((await stateOf()).todo.some((x) => x.id === id), 'the copy waits')
  t.alike(textsOf(await C.web.request('dm.thread', { peer: P.key }).catch(() => ({ messages: [] }))), [], 'no conversation yet')

  // The link is back and the own diary is caught up again.
  run.down = false
  run.deliver({ event: 'own-synced', length: caught.length })
  await until(() => C.web.events.some((e) => e.name === 'dm.copyImported'), { name: 'copyImported', timeoutMs: 60000 })
  t.alike(textsOf(await C.web.request('dm.thread', { peer: P.key })), ['oi', 'tudo'], 'the copy lands once the own diary is caught up')
})
