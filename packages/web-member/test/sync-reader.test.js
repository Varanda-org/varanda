// The browser sync (lib/sync.js) publishes a reader over the cores it
// already holds: the own diary and the open follow replicas, just before the
// first connection; a lookup never opens a core; a hold keeps teardown from
// closing them until released; the reader is withdrawn however the run ends,
// before it published too.
const test = require('brittle')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord } = require('@varanda/core/lib/records')
const { runSync } = require('../lib/sync')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

const NO_SEEDER = 'ws://127.0.0.1:9/seeder'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// A member with block 0 on a fresh storage, following one diary whose
// block 0 (a certificate of the same association) is stored as a replica.
async function member (t) {
  const assocKp = generateAssociationKeyPair()
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const ctx = { storage, association: hex(assocKp.publicKey), keyPair, mediaKeyPair: crypto.keyPair() }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))

  const source = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await source.ready()
  t.teardown(() => source.close(), { force: true })
  const followHex = hex(source.key)
  await source.append(memberCertRecord(createCert({ member: followHex }, assocKp)))
  const replica = await store.openReplica(storage, followHex)
  const a = source.replicate(true)
  const b = replica.replicate(false)
  a.pipe(b).pipe(a)
  await replica.get(0)
  a.destroy()
  b.destroy()
  await replica.close()

  await store.writeFollows(storage, [followHex])
  await store.writeFollowsMigrated(storage)
  return { storage, ownHex, followHex }
}

// A reader that records every call and resolves `published` on set.
function recorder () {
  const calls = []
  let publish
  const published = new Promise((resolve) => { publish = resolve })
  const reader = {
    calls,
    published,
    api: null,
    set (api) {
      calls.push('set')
      reader.api = api
      publish(api)
    },
    clear () {
      calls.push('clear')
    }
  }
  return reader
}

// A socket that never connects: the run stays around its first connection.
function deadSocket () {
  return { readyState: 0, binaryType: 'arraybuffer', close () {}, send () {}, addEventListener () {}, removeEventListener () {} }
}

function sync (storage, reader, signal, opts = {}) {
  return runSync({
    storage,
    seederUrl: NO_SEEDER,
    createSocket: deadSocket,
    retryMinMs: 100,
    retryMaxMs: 200,
    socketCloseMs: 50,
    reader,
    signal,
    ...opts
  })
}

async function settledFirst (p, ms) {
  return Promise.race([p.then(() => 'done', () => 'done'), new Promise((resolve) => setTimeout(() => resolve('pending'), ms))])
}

test('the reader exposes the run\'s own diary and open replicas and opens nothing', async (t) => {
  t.timeout(30000)
  await testnet(t)
  const m = await member(t)
  const reader = recorder()
  const ac = new AbortController()
  const done = sync(m.storage, reader, ac.signal)
  const api = await reader.published

  t.is(hex(api.diary.key), m.ownHex, 'the own diary')
  const opens = []
  const core = m.storage.core
  m.storage.core = function (name) {
    opens.push(name)
    return core.apply(this, arguments)
  }
  const r = api.replica(m.followHex)
  t.ok(r, 'the stored follow is exposed')
  t.is(hex(r.key), m.followHex)
  t.is(api.replica(m.followHex), r, 'the same core on every lookup')
  t.is(api.replica(hex(crypto.keyPair().publicKey)), null, 'an unknown key is null')
  t.is(api.replica(m.ownHex), null, 'the own key is not a replica')
  t.alike(opens, [], 'lookups open nothing')
  m.storage.core = core

  ac.abort()
  await done
  t.ok(r.closed, 'the run closed its replica')
})

test('a hold keeps the cores open until released', async (t) => {
  t.timeout(30000)
  await testnet(t)
  const m = await member(t)
  const reader = recorder()
  const ac = new AbortController()
  const done = sync(m.storage, reader, ac.signal)
  const api = await reader.published
  const r = api.replica(m.followHex)

  t.is(api.hold(), true, 'a live run grants a hold')
  ac.abort()
  t.is(await settledFirst(done, 500), 'pending', 'the run waits for the hold')
  t.absent(r.closing, 'the replica stays open')
  t.absent(api.diary.closing, 'the diary stays open')
  t.ok(reader.calls.includes('clear'), 'the reader was withdrawn before the wait')

  api.release()
  api.release() // an extra release is ignored
  await done
  t.ok(r.closed, 'the replica closed after the release')
  t.ok(api.diary.closed, 'the diary closed after the release')
})

test('after the run, holds are refused and the reader was cleared', async (t) => {
  t.timeout(30000)
  await testnet(t)
  const m = await member(t)
  const reader = recorder()
  const ac = new AbortController()
  const done = sync(m.storage, reader, ac.signal)
  const api = await reader.published
  ac.abort()
  await done
  t.is(api.hold(), false, 'no hold once ended')
  t.alike(reader.calls.slice(0, 1), ['set'])
  t.ok(reader.calls.includes('clear'), 'cleared')
  t.is(reader.calls.lastIndexOf('set'), 0, 'set once')
})

test('a run that throws early clears the reader and never sets it', async (t) => {
  t.timeout(30000)
  await testnet(t)
  const noConfig = recorder()
  await t.exception(sync(memoryNodeStorage(), noConfig), /identidade não encontrada/)
  t.ok(noConfig.calls.includes('clear'), 'cleared')
  t.absent(noConfig.calls.includes('set'), 'never set')

  const m = await member(t)
  const readBlocklist = store.readBlocklist
  store.readBlocklist = async () => { throw new Error('falha de armazenamento') }
  t.teardown(() => { store.readBlocklist = readBlocklist })
  const badList = recorder()
  await t.exception(sync(m.storage, badList), /falha ao ler a lista de bloqueio/)
  store.readBlocklist = readBlocklist
  t.ok(badList.calls.includes('clear'), 'cleared')
  t.absent(badList.calls.includes('set'), 'never set')
})

test('a slow startup logs the step it is held on until it goes on, and nothing once the run ended', async (t) => {
  t.timeout(30000)
  await testnet(t)
  const m = await member(t)
  // The run's own follow gate (store.readFollows called from syncRun) is
  // held; every other caller goes through.
  const original = store.readFollows
  let armed = true
  let release
  const gate = new Promise((resolve) => { release = resolve })
  store.readFollows = async function (...args) {
    if (armed && /\bat syncRun \(/.test(new Error().stack)) {
      armed = false
      await gate
    }
    return original.apply(this, args)
  }
  t.teardown(() => {
    store.readFollows = original
    release()
  })
  const lines = []
  const reader = recorder()
  const ac = new AbortController()
  const done = sync(m.storage, reader, ac.signal, { startupSlowMs: 100, log: (line) => lines.push(line) })
  await until(() => lines.filter((l) => l.startsWith('aviso: partida demorada (etapa: seguidos (abertura), ')).length >= 2, { timeoutMs: 10000 })
  t.pass('the held step is named, again at the interval')
  t.absent(lines.some((l) => /etapa: (?!seguidos \(abertura\))/.test(l)), 'no other step while held')
  release()
  await reader.published
  await until(() => lines.some((l) => l.startsWith('aviso: partida demorada (etapa: conexão, ')), { timeoutMs: 10000 })
  t.pass('then the connection step, until the seeder link is up')
  ac.abort()
  await done
  const count = lines.length
  await new Promise((resolve) => setTimeout(resolve, 400))
  t.is(lines.length, count, 'no line after the run ended')
})
