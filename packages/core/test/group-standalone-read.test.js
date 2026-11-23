'use strict'

// A core member node that holds a standalone group root (docs/protocol.md,
// section 10: community and member both null) folds it without reading a
// parent community.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createClient, createServerDispatcher } = require('@varanda/rpc')
const { tmpDir } = require('./helpers/tmp')
const { newSession } = require('./helpers/net')
const { createCert } = require('../lib/cert')
const { groupJoinRecord } = require('../lib/records')
const member = require('../lib/member')
const store = require('../lib/store')
const groups = require('../lib/group')

const BOOTSTRAP = ['127.0.0.1:49737']
const hex = (key) => b4a.toString(key, 'hex')

async function connect (t, session) {
  const dispatcher = createServerDispatcher({
    handlers: session.handlers,
    send (message, text) {
      queueMicrotask(() => client.receive(JSON.parse(text)))
    },
    onProtocolError: () => t.fail('unexpected protocol error')
  })
  const client = createClient({
    timeoutMs: 90000,
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
  return { call: (method, params) => client.request(method, params) }
}

async function person (t) {
  const kp = crypto.keyPair()
  const dataDir = tmpDir(t)
  const association = hex(kp.publicKey)
  const session = newSession(t, { dataDir, association, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: createCert({ member: publicKey }, kp) })
  await link.call('profile.set', { name: 'Ana' })
  return { dataDir, association, session, publicKey, ...link }
}

// A standalone root this node created, written as groupCreate writes a
// community group's root (nonce recorded, then the diary binds it), with no
// community and no member in its header.
async function standaloneRoot (m, { visibility = 'public' } = {}) {
  return member.withIdentity(m, async ({ store: s, diary, ownHex }) => {
    const nonce = hex(crypto.randomBytes(16))
    const root = await store.openGroupWriter(s, nonce)
    const group = hex(root.key)
    const header = visibility === 'private'
      ? groups.groupHeader({ diary: ownHex, visibility, join: 'approval', box: hex(store.ensureBoxKeyPair(m.dataDir).publicKey) })
      : groups.groupHeader({ diary: ownHex, name: 'Solta', join: 'open' })
    await store.appendRecord(root, header, { validator: (r, seq) => groups.validateGroupRecord(r, seq, { root: true, private: visibility === 'private' }) })
    store.writeGroups(m.dataDir, [...store.readGroups(m.dataDir), { group, writer: group, nonce }])
    await store.appendRecord(diary, groupJoinRecord({ group, writer: group, on: true }))
    return group
  })
}

test('a core node loads a public standalone group it holds: no community, creator a live writer', async (t) => {
  const m = await person(t)
  const group = await standaloneRoot(m)
  const info = await m.call('group.info', { group })
  t.is(info.community, null, 'names no community')
  t.is(info.orphan, false)
  t.is(info.creator, m.publicKey)
  t.is(info.role, 'creator')
  t.is(info.state, 'member')
  t.is(info.name, 'Solta')
  t.is(info.visibility, 'public')
  const { members } = await m.call('group.members', { group })
  t.alike(members.map((x) => [x.member, x.admin, x.banned]), [[m.publicKey, true, false]], 'the creator counts as a live writer')
  const page = await m.call('group.read', { group })
  t.is(page.state, 'ok')
  t.is(page.incomplete, false, 'no parent to wait for')
})

test('a core node loads a private standalone group whose root box is its own', async (t) => {
  const m = await person(t)
  const group = await standaloneRoot(m, { visibility: 'private' })
  const info = await m.call('group.info', { group })
  t.is(info.community, null)
  t.is(info.creator, m.publicKey)
  t.is(info.state, 'member')
  t.is(info.visibility, 'private')
})

test('a community group still loads with its community', async (t) => {
  const m = await person(t)
  const { community } = await m.call('community.create', { name: 'Bairro', join: 'open' })
  const { group } = await m.call('group.create', { name: 'Horta', join: 'open', community })
  const info = await m.call('group.info', { group })
  t.is(info.community, community)
  t.is(info.orphan, false)
  t.is(info.creator, m.publicKey)
  t.is(info.state, 'member')
})
