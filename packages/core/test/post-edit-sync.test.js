'use strict'

// A post edit between two node sessions on the loopback testnet: the reader
// shows the edited text after sync, a second edit converges, the replica
// only grows, never forks, and the original post block is byte-identical on
// both sides.
const test = require('brittle')
const path = require('node:path')
const { tmpDir } = require('./helpers/tmp')
const { testnet, until, newSession, connect } = require('./helpers/net')
const { initAssociation, issueCertificate } = require('../lib/assoc')
const storeLib = require('../lib/store')

function association (t) {
  const dir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey } = initAssociation(dir)
  return { dir, hex: publicKey }
}

async function member (t, bootstrap, assoc) {
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: assoc.hex, bootstrap })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: issueCertificate(assoc.dir, { member: publicKey }) })
  return { dataDir, session, publicKey, ...link }
}

// Both nodes run a continuous sync until the reader reports `length` blocks
// of the author downloaded. Reads during a run would preempt it, so the wait
// is on the sync events only.
async function syncUntil (t, a, b, length, label) {
  await a.call('sync.start')
  await b.call('sync.start')
  try {
    const line = 'downloaded ' + a.publicKey + ' ' + length
    await until(() => b.events.find((e) => e.event === 'sync.event' && e.data.line === line), { timeoutMs: 60000, name: label })
  } finally {
    await b.call('sync.stop')
    await a.call('sync.stop')
  }
}

async function replicaState (dataDir, author, seq) {
  const s = await storeLib.openStore(dataDir)
  try {
    const core = author === null ? await storeLib.openDiary(s) : await storeLib.openReplica(s, author)
    return { length: core.length, fork: core.fork, block: JSON.stringify(await core.get(seq, { wait: false })) }
  } finally {
    await s.close()
  }
}

test('an edited post converges on a reader, which never forks', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const assoc = association(t)
  const a = await member(t, bootstrap, assoc)
  const b = await member(t, bootstrap, assoc)
  await a.call('profile.set', { name: 'Ana' })
  const post = await a.call('post.create', { text: 'um' })
  await b.call('follow.add', { key: a.publicKey })
  await syncUntil(t, a, b, 3, 'first sync')
  const shown = async () => (await b.call('feed.read', {})).items.find((i) => i.kind === 'post' && i.author === a.publicKey && i.seq === post.seq)
  t.is((await shown()).text, 'um')
  const first = await replicaState(b.dataDir, a.publicKey, post.seq)

  await a.call('post.edit', { to: post.ref, text: 'dois' })
  await syncUntil(t, a, b, 4, 'edit sync')
  const edited = await shown()
  t.is(edited.text, 'dois')
  t.is(edited.edited, true)
  const mid = await replicaState(b.dataDir, a.publicKey, post.seq)

  await a.call('post.edit', { to: post.ref, text: 'tres' })
  await syncUntil(t, a, b, 6, 'second edit sync')
  t.is((await shown()).text, 'tres')
  const last = await replicaState(b.dataDir, a.publicKey, post.seq)
  const own = await replicaState(a.dataDir, null, post.seq)

  t.ok(first.length < mid.length && mid.length < last.length, 'the replica only grows')
  t.is(last.fork, 0, 'reader fork stays 0')
  t.is(own.fork, 0, 'writer fork stays 0')
  t.is(last.length, own.length, 'same length on both')
  t.is(first.block, own.block, 'the post block is byte-identical on both replicas')
  t.is(mid.block, own.block)
  const log = await b.call('log.read', { author: a.publicKey })
  t.is(log.entries.find((e) => e.seq === post.seq).record.text, 'tres')
})
