'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createClient, createServerDispatcher } = require('@varanda/rpc')
const { tmpDir } = require('./helpers/tmp')
const { newSession, failure } = require('./helpers/net')
const { createCert } = require('../lib/cert')
const store = require('../lib/store')

const hex = (key) => b4a.toString(key, 'hex')

async function person (t, kp, name) {
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: hex(kp.publicKey), bootstrap: ['127.0.0.1:49737'] })
  const events = []
  const dispatcher = createServerDispatcher({
    handlers: session.handlers,
    send (message, text) {
      if (message.event) events.push(message.event)
      queueMicrotask(() => client.receive(JSON.parse(text)))
    },
    onProtocolError: () => t.fail('unexpected protocol error')
  })
  const client = createClient({
    timeoutMs: 90000,
    send (message, text) { queueMicrotask(() => dispatcher.receive(JSON.parse(text))) }
  })
  session.attach(dispatcher.emit)
  t.teardown(() => {
    client.close()
    dispatcher.close()
  }, { force: true })
  await client.request('session.open')
  const { publicKey } = await client.request('identity.create')
  await client.request('cert.add', { cert: createCert({ member: publicKey }, kp) })
  await client.request('profile.set', { name })
  return { dataDir, session, events, call: (method, params) => client.request(method, params) }
}

async function exchange (from, to) {
  const a = await store.openStore(from.dataDir)
  const b = await store.openStore(to.dataDir)
  let left
  let right
  try {
    const copies = []
    for await (const dk of a.list()) {
      const source = a.get({ discoveryKey: dk, writable: false })
      await source.ready()
      const target = b.get({ key: source.key, writable: false })
      await target.ready()
      copies.push({ source, target })
    }
    left = a.replicate(true)
    right = b.replicate(false)
    left.pipe(right).pipe(left)
    for (const { source, target } of copies) {
      for (let seq = 0; seq < source.contiguousLength; seq++) {
        await target.get(seq, { raw: true, timeout: 10000 })
      }
    }
  } finally {
    if (left) left.destroy()
    if (right) right.destroy()
    await b.close()
    await a.close()
  }
}

test('group.seen through the session: ok, idempotent, no groups.changed, unread cleared', async (t) => {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { community, group } = await a.call('community.create', { name: 'Bairro', join: 'open' })
  await exchange(a, b)
  await b.call('community.join', { community })
  await exchange(b, a)
  await b.call('group.post', { group, text: 'oi da Bia' })
  await exchange(b, a)
  const unread = async () => (await a.call('community.info', { community })).groups.find((g) => g.group === group).unread
  t.is(await unread(), 1)

  a.events.splice(0)
  t.alike(await a.call('group.seen', { group }), { ok: true })
  t.is(await unread(), 0)
  t.alike(await a.call('group.seen', { group }), { ok: true })
  t.is(await unread(), 0)
  t.absent(a.events.includes('groups.changed'), 'no groups.changed, Grupo would reload in a loop')

  const missing = { code: 'NOT_FOUND', message: 'grupo não encontrado' }
  t.alike(await failure(a.call('group.seen', { group: 'ab'.repeat(32) })), missing)
  const bad = await failure(a.call('group.seen', { group: 'x' }))
  t.ok(bad !== null, 'a malformed key is rejected: ' + (bad && bad.message))
  t.alike(a.session.internal, [])
})
