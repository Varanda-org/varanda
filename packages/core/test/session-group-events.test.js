'use strict'

// groups.changed from the sync: the run's group-downloaded events reach the
// client as one groups.changed per group, however many blocks arrived. The
// sync is scripted (no network): runSync is replaced before session.js loads.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const syncPath = require.resolve('../lib/sync')
const realSync = require(syncPath)
let scripted = async () => ({ ok: true, downloaded: {}, unadvertised: [], skipped: [], errors: [] })
require.cache[syncPath].exports = { ...realSync, runSync: (opts) => scripted(opts) }

const { createClient, createServerDispatcher, validateEvent } = require('@varanda/rpc')
const { tmpDir } = require('./helpers/tmp')
const { newSession } = require('./helpers/net')

const hex = (key) => b4a.toString(key, 'hex')

async function open (t) {
  const session = newSession(t, { dataDir: tmpDir(t), association: hex(crypto.keyPair().publicKey), bootstrap: ['127.0.0.1:49737'] })
  const events = []
  const dispatcher = createServerDispatcher({
    handlers: session.handlers,
    send (message, text) {
      if (message.event) {
        t.ok(validateEvent(message).ok, 'valid event envelope')
        events.push({ event: message.event, data: message.data })
      }
      queueMicrotask(() => client.receive(JSON.parse(text)))
    },
    onProtocolError: () => t.fail('unexpected protocol error')
  })
  const client = createClient({
    timeoutMs: 30000,
    send (message, text) {
      queueMicrotask(() => dispatcher.receive(JSON.parse(text)))
    }
  })
  session.attach(dispatcher.emit)
  t.teardown(() => {
    client.close()
    dispatcher.close()
  }, { force: true })
  await client.request('session.open')
  await client.request('identity.create')
  return { call: (method, params) => client.request(method, params), events }
}

test('group-downloaded events become one groups.changed per group', async (t) => {
  const G = 'a1'.repeat(32)
  const H = 'b2'.repeat(32)
  const W = 'c3'.repeat(32)
  scripted = async ({ onEvent }) => {
    for (let length = 1; length <= 5; length++) onEvent({ event: 'group-downloaded', key: W, group: G, length })
    onEvent({ event: 'group-downloaded', key: H, group: H, length: 1 })
    return { ok: true, downloaded: {}, unadvertised: [], skipped: [], errors: [] }
  }
  const s = await open(t)
  await s.call('sync.start', { once: true })
  for (let i = 0; i < 200 && !s.events.some((e) => e.event === 'sync.stopped'); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  const changed = s.events.filter((e) => e.event === 'groups.changed').map((e) => e.data.group).sort()
  t.alike(changed, [G, H], 'one per group, flushed by the end of the run')
  t.is(s.events.filter((e) => e.event === 'sync.event' && e.data.line.startsWith('grupo ')).length, 6, 'every download still has its line')
})
