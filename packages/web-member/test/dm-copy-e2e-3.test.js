'use strict'

// The history copy under failure (docs/protocol.md section 11, "Import"),
// over the real Seeder and real browser nodes: a part that fails now keeps the
// todo for a later pull, a manifest that is gone ends it, and a lock right
// after a page that held the pointer loses nothing. Local DHT and tmp dirs only.

const test = require('brittle')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const store = require('../lib/node-store')
const { hex, seederHost, memberNode } = require('./helpers/dm-e2e')
const { BLOB, sleep, copyDiary, sweepPool, textsOf } = require('./helpers/dm-copy')

const imports = (n) => n.web.events.filter((e) => e.name === 'dm.copyImported')

async function nodes (t) {
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const A = await memberNode(t, assoc, host, { blob: BLOB })
  const P = await memberNode(t, assoc, host, { blob: BLOB })
  const A2 = await memberNode(t, assoc, host, { keyPair: A.keyPair, prf: A.prf, enable: false, blob: BLOB })
  await copyDiary(A, P)
  await copyDiary(P, A)
  return { host, A, P, A2 }
}

test('a part that fails keeps the copy for later pulls and ends it after three; a manifest that is gone ends it at once', async (t) => {
  t.timeout(110000)
  const { host, A, A2, P } = await nodes(t)
  // What the seeder answers: everything, only the first blob asked (the
  // manifest), or nothing. A sweep restarts the seeder, so the hook is
  // installed again after each.
  let mode = 'open'
  let manifest = null
  const install = () => {
    const seeder = host.current
    const chunk = seeder.blobChunk.bind(seeder)
    seeder.blobChunk = (id, index) => {
      if (mode === 'gone') return null
      if (mode === 'manifest') {
        if (manifest === null) manifest = id
        if (id !== manifest) return null
      }
      return chunk(id, index)
    }
  }
  const pull = async (m) => {
    mode = m
    manifest = null
    await A2.web.request('dm.pull')
    await sleep(1500)
  }
  const copy = async (text) => {
    await A.web.request('dm.send', { to: P.key, text })
    await sweepPool(host)
    install()
    await A.web.request('dm.historyCopy')
  }

  await copy('um')
  await pull('manifest')
  t.is(imports(A2).length, 0, 'a part that fails imports nothing yet')
  await pull('open')
  await until(() => imports(A2).length === 1, { name: 'copyImported', timeoutMs: 30000 })
  t.alike(textsOf(await A2.web.request('dm.thread', { peer: P.key })), ['um'], 'a later pull finished it')

  // The third pull that fails on a part ends the copy.
  await copy('dois')
  await pull('manifest')
  await pull('manifest')
  await pull('manifest')
  await pull('open')
  t.is(imports(A2).length, 1, 'after three failing pulls it is given up')

  // A manifest that is gone ends it at once.
  await copy('tres')
  await pull('gone')
  await pull('open')
  t.is(imports(A2).length, 1, 'a manifest that is gone is never tried again')
  t.alike(textsOf(await A2.web.request('dm.thread', { peer: P.key })), ['um'])
})

test('a lock right after a page that held the pointer leaves the copy noted: the next unlock imports it', async (t) => {
  t.timeout(110000)
  const { host, A, A2, P } = await nodes(t)
  await A.web.request('dm.send', { to: P.key, text: 'um' })
  await A.web.request('dm.send', { to: P.key, text: 'dois' })
  await sweepPool(host)
  await A.web.request('dm.historyCopy')

  // The cursor of A2 is written after that page, and the app locks right
  // then (what a lock or a kill between the cursor and the end of the pull
  // looks like).
  const put = A2.storage.writeJson.bind(A2.storage)
  let locked = null
  A2.storage.writeJson = async (key, value) => {
    const r = await put(key, value)
    if (key === 'dmCursor' && locked === null) locked = A2.node.clearKeyPair()
    return r
  }
  await A2.web.request('dm.pull').catch(() => null)
  await locked
  A2.storage.writeJson = put
  t.is(imports(A2).length, 0, 'nothing imported while locked')
  t.ok((await store.readDmCursor(A2.storage)) > 0, 'the cursor is past the pointer')

  await A2.node.setKeyPair(A2.keyPair, { prf: A2.prf })
  await A2.web.request('dm.pull')
  await until(() => imports(A2).length === 1, { name: 'copyImported after unlock', timeoutMs: 60000 })
  t.alike(textsOf(await A2.web.request('dm.thread', { peer: P.key })), ['dois', 'um'], 'the copy that the cursor had passed was imported')
})
