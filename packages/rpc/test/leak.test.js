'use strict'

// Sentinel sweep of the worklet IPC: a real node session behind the real
// dispatcher, every server message framed by encodeFrame exactly as
// apps/app/worklet/main.js does, and the whole byte stream searched for values
// that must never leave the node (the data dir, the secret keys, the
// bootstrap address). The sentinels are planted in the config or read from the
// member's own store, and only their labels are ever reported.

const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSession } = require('@varanda/core/lib/session')
const { initAssociation, issueCertificate } = require('@varanda/core/lib/assoc')
const { openStore, openDiary } = require('@varanda/core/lib/store')
const { createServerDispatcher, createClient, createFrameDecoder, encodeFrame, EVENTS } = require('..')

const BOOTSTRAP = '127.0.0.1:49737'
const FOREIGN = 'ab'.repeat(32)

function tmpDir (t, prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.VARANDA_TEST_TMPDIR || os.tmpdir(), prefix))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }), { order: 100, force: true })
  return dir
}

// The labels (never the values) of the sentinels found in any of the texts.
function leaked (texts, sentinels) {
  return Object.keys(sentinels).filter((label) => texts.some((text) => text.includes(sentinels[label])))
}

// The member's secret material as bytes, from its own closed store: the seed
// half of the diary's secret key (the other half is the public key) and the
// store's primary key.
// Each secret as it could slip out of a handler: hex, base64 (unpadded, so
// padded matches too), base64url, and the byte list a Buffer takes in JSON
// ({"type":"Buffer","data":[...]}).
function secretForms (secrets) {
  const out = {}
  for (const [label, bytes] of Object.entries(secrets)) {
    out[label + ' (hex)'] = bytes.toString('hex')
    out[label + ' (base64)'] = bytes.toString('base64').replace(/=+$/, '')
    // The same text as base64 when the key has no '+' or '/'.
    if (bytes.toString('base64url') !== out[label + ' (base64)']) out[label + ' (base64url)'] = bytes.toString('base64url')
    out[label + ' (byte list)'] = JSON.stringify([...bytes])
  }
  return out
}

async function secretsOf (dataDir) {
  const store = await openStore(dataDir)
  try {
    const diary = await openDiary(store)
    return {
      'diary secret key': Buffer.from(diary.keyPair.secretKey).subarray(0, 32),
      'store primary key': Buffer.from(store.primaryKey)
    }
  } finally {
    await store.close()
  }
}

async function failure (promise) {
  try {
    await promise
  } catch (err) {
    return err.code
  }
  return null
}

test('IPC frames carry no path, secret key or bootstrap address', async (t) => {
  const root = tmpDir(t, 'varanda-leak-')
  const dataDir = path.join(root, 'membro')
  const assocDir = path.join(root, 'associação')
  const { publicKey: association } = initAssociation(assocDir)
  const session = createSession({ dataDir, association, bootstrap: [BOOTSTRAP], dhtHost: '127.0.0.1' })
  t.teardown(() => session.close(), { force: true })

  const frames = []
  let client = null
  const dispatcher = createServerDispatcher({
    handlers: session.handlers,
    send: (message, text) => {
      frames.push(encodeFrame(message))
      queueMicrotask(() => client.receive(JSON.parse(text)))
    }
  })
  client = createClient({
    send: (message, text) => queueMicrotask(() => dispatcher.receive(JSON.parse(text))),
    timeoutMs: 60000
  })
  const events = []
  for (const name of EVENTS) client.on(name, (data) => events.push(name))
  session.attach(dispatcher.emit)
  t.teardown(() => {
    client.close()
    dispatcher.close()
  }, { force: true })
  const call = (method, params) => client.request(method, params)

  await call('session.open')
  await call('node.info')
  t.is(await failure(call('identity.show')), 'NOT_FOUND')
  const { publicKey } = await call('identity.create')
  await call('identity.show')
  await call('cert.add', { cert: issueCertificate(assocDir, { member: publicKey }) })
  await call('profile.set', { name: 'Ana', bio: 'bio' })
  const post = await call('post.create', { text: 'olá' })
  await call('post.reply', { to: post.ref, text: 'de novo' })
  t.is(await failure(call('post.create', { text: '' })), 'USAGE')
  t.is(await failure(call('node.info', { extra: 1 })), 'USAGE')
  await call('follow.add', { key: FOREIGN })
  await call('follow.list')
  await call('follow.remove', { key: FOREIGN })
  await call('log.read')
  t.is(await failure(call('log.read', { author: FOREIGN })), 'NOT_FOUND')
  await call('feed.read')
  await call('profile.read', { authors: [publicKey, FOREIGN] })
  await call('sync.status')
  const { runId } = await call('sync.start', { once: true, timeoutMs: 1000 })
  const stopped = new Promise((resolve) => client.on('sync.stopped', (data) => data.runId === runId && resolve()))
  await stopped
  await call('sync.status')
  t.ok(events.includes('sync.started') && events.includes('sync.stopped'), 'sync events crossed the link')

  await session.detach()
  await session.close()

  const secrets = await secretsOf(dataDir)
  const sentinels = { 'data dir': dataDir, 'association dir': assocDir, bootstrap: BOOTSTRAP, ...secretForms(secrets) }

  // The stream is decoded back, so the scan covers what a host would read.
  const stream = Buffer.concat(frames)
  const decoded = []
  const errors = []
  createFrameDecoder({ onMessage: (message) => decoded.push(message), onError: (err) => errors.push(err) }).push(stream)
  t.alike(errors, [], 'the stream decodes')
  t.is(decoded.length, frames.length, 'every frame decodes')
  t.ok(frames.length > 20, 'a broad script (' + frames.length + ' frames)')

  const texts = [stream.toString('latin1'), ...decoded.map((message) => JSON.stringify(message))]
  t.alike(leaked(texts, sentinels), [], 'no sentinel in any IPC frame')

  // Control: the scan names every sentinel it is given when one leaks.
  for (const label of Object.keys(sentinels)) {
    t.alike(leaked(['{"v":1,"id":1,"ok":true,"result":{"x":"' + sentinels[label] + '"}}'], sentinels), [label], 'control: ' + label)
  }

  // Control: a Buffer left in a result takes its JSON form, {"type":"Buffer","data":[...]}.
  for (const [label, bytes] of Object.entries(secrets)) {
    t.alike(leaked([JSON.stringify({ v: 1, id: 1, ok: true, result: { key: bytes } })], sentinels), [label + ' (byte list)'], 'control: ' + label + ' as a Buffer')
  }
})
