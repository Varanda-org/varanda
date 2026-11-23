'use strict'

// Group notices for standalone groups at the seeder (packages/core/lib/
// seeder.js, group-notice.js; docs/protocol.md "Group message notices"): a
// root that names no community, once its block 0 passes isStandaloneHeader,
// gets a hint built with `community: null` over its own cores alone. Only
// members are told, never outsiders, pending writers or banned ones, a
// rebuild replays nothing, and a private group's notice carries no name.
// The network tests run a local seeder and members on a local DHT; the
// in-memory ones feed a seeder hand-built cores to pin the block 0 check.

const test = require('brittle')
const b4a = require('b4a')
const { randomBytes, keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const { groupHeader, writerHeader, groupPost, groupAdmit, groupBan, groupSealed, groupLeave } = require('@varanda/core/lib/group')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createGroupIndex } = require('@varanda/core/lib/group-index')
const {
  makeAssociation,
  prepareSeederDir,
  startSeeder,
  encode,
  member,
  admit,
  admitted,
  downloaded,
  scansDone
} = require('../../../packages/core/test/helpers/seeder-groups')

const BOX = 'e'.repeat(64)
const WRITER_BOX = 'd'.repeat(64)

function sealed (writer) {
  return groupSealed({ kid: { writer, seq: 1 }, nonce: 'ab'.repeat(24), box: b4a.toString(b4a.alloc(40, 7), 'base64') })
}

test('standalone group notices reach members only, survive a rebuild without replay and keep a private name out', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const notices = []
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, onGroupNotice: (e) => notices.push(e) })

  // Creator A: public approval group S ('Roda livre', one post of history)
  // and private group V, both standalone. B is admitted to both, P waits
  // for approval in S, X is admitted to S and then banned, O is a served
  // diary with no writer in either group.
  const k = {}
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.S = await make('s', groupHeader({ diary: key, join: 'approval', name: 'Roda livre' }), [groupPost({ text: 'history' })])
    k.V = await make('v', groupHeader({ diary: key, visibility: 'private', join: 'approval', name: null, box: BOX }))
    return [k.S, k.V].map((g) => groupJoinRecord({ group: g, writer: g, on: true }))
  })
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.WB = await make('wb', writerHeader({ group: k.S, diary: key, member: k.S }), [groupPost({ text: 'writer history' })])
    k.WV = await make('wv', writerHeader({ group: k.V, diary: key, member: k.V, box: WRITER_BOX }))
    return [groupJoinRecord({ group: k.S, writer: k.WB, on: true }), groupJoinRecord({ group: k.V, writer: k.WV, on: true })]
  })
  const P = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.WP = await make('wp', writerHeader({ group: k.S, diary: key, member: k.S }))
    return [groupJoinRecord({ group: k.S, writer: k.WP, on: true })]
  })
  const X = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.WX = await make('wx', writerHeader({ group: k.S, diary: key, member: k.S }))
    return [groupJoinRecord({ group: k.S, writer: k.WX, on: true })]
  })
  const O = await member(t, bootstrap, assoc, async () => [])
  const { S, V, WB, WV, WP, WX } = k
  await A.cores.s.append(encode(groupAdmit({ member: B.key, on: true, cuts: [{ writer: WB, seq: 1 }] })))
  await A.cores.s.append(encode(groupAdmit({ member: X.key, on: true, cuts: [{ writer: WX, seq: 1 }] })))
  await A.cores.s.append(encode(groupBan({ member: X.key, on: true, cuts: [{ writer: WX, seq: 1 }] })))
  await A.cores.v.append(encode(groupAdmit({ member: B.key, on: true, cuts: [{ writer: WV, seq: 1 }] })))

  for (const m of [A, B, P, X, O]) await admit(m, assoc)
  for (const key of [S, V, WB, WV, WP, WX]) await admitted(events, key)
  await downloaded(seeder, S, 5)
  await downloaded(seeder, V, 2)

  const state = (group) => seeder._groupServed.get(group).groupNotice
  // Queueing starts a scan at once, so only an idle state that is not done
  // yet asks for another pass.
  const settle = (group, done, name) => until(() => {
    const s = state(group)
    const ok = Boolean(s) && !s.busy && done(s)
    if (!ok && !(s && s.busy)) seeder._queueGroupNotices(group)
    return ok
  }, { name, timeoutMs: 60000 })
  const scannedTo = (s, writer) => {
    const c = s.cursors.get(writer)
    const e = seeder._groupServed.get(writer)
    return Boolean(c) && c.scanned === e.core.contiguousLength
  }

  await settle(S, (s) => s.hint.allowed(B.key) === true, 'dica de S completa')
  await settle(V, (s) => s.hint.allowed(B.key) === true, 'dica de V completa')
  t.is(seeder._groupServed.get(S).standalone, true, 'S block 0 passed isStandaloneHeader')
  t.is(seeder._groupServed.get(V).standalone, true, 'V block 0 passed isStandaloneHeader')
  t.alike([...state(S).cursors.keys()].sort(), [S, WB, WP, WX].sort(), 'only the cores of S are read')
  t.alike([...state(V).cursors.keys()].sort(), [V, WV].sort(), 'only the cores of V are read')
  const hint = state(S).hint
  t.is(hint.allowed(A.key), true, 'the creator is a member')
  t.is(hint.allowed(P.key), false, 'a pending writer is no member')
  t.is(hint.allowed(X.key), false, 'a banned writer is no member')
  t.is(hint.allowed(O.key), false, 'an outsider is no member')
  t.alike(notices, [], 'admitted history never notifies')

  await B.cores.wb.append(encode(groupPost({ text: 'nova' })))
  await until(() => notices.length === 1, { name: 'aviso do post de B' })
  t.is(notices[0].group, S)
  t.is(notices[0].visibility, 'public')
  t.is(notices[0].name, 'Roda livre', 'a public standalone group sends its name')
  t.alike(notices[0].recipients, [A.key], 'only the other member is told')

  // Posts of a pending and a banned writer notify no one.
  await P.cores.wp.append(encode(groupPost({ text: 'pendente' })))
  await X.cores.wx.append(encode(groupPost({ text: 'banido' })))
  await downloaded(seeder, WP, 2)
  await downloaded(seeder, WX, 2)
  await settle(S, (s) => scannedTo(s, WP) && scannedTo(s, WX), 'posts de P e X varridos')
  t.is(notices.length, 1, 'no notice for a pending or banned author')

  await A.cores.s.append(encode(groupPost({ text: 'da criadora' })))
  await until(() => notices.length === 2, { name: 'aviso do post de A' })
  t.alike(notices[1].recipients, [B.key], 'neither pending, banned nor outsider diaries are told')

  // A rebuild reads every core of S again from block zero and replays none
  // of its notices.
  const before = state(S).hint
  state(S).rebuild = true
  await settle(S, (s) => s.hint !== before && !s.rebuild && [S, WB, WP, WX].every((w) => scannedTo(s, w)), 'reconstrução de S')
  t.is(notices.length, 2, 'a rebuild replays nothing')
  await B.cores.wb.append(encode(groupPost({ text: 'depois' })))
  await until(() => notices.length === 3, { name: 'aviso depois da reconstrução' })
  t.alike(notices[2].recipients, [A.key])
  await settle(S, (s) => scannedTo(s, WB), 'varredura final de S')
  t.is(notices.length, 3, 'the post notifies once')

  // Private: a sealed envelope notifies the other member, with no name.
  await B.cores.wv.append(encode(sealed(V)))
  await until(() => notices.length === 4, { name: 'aviso do grupo privado' })
  t.is(notices[3].group, V)
  t.is(notices[3].visibility, 'private')
  t.is(notices[3].name, null, 'a private standalone group sends no name')
  t.alike(notices[3].recipients, [A.key])

  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a failed read of a standalone root block 0 is tried again on a later pass and notices still arrive', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const notices = []
  let S = null
  let reads = 0
  let failed = false
  let seeder = null
  // After S's gate read and before its first notice pass, the next local
  // read of block 0 rejects once, as a transient storage error would.
  const regateHook = async (key) => {
    if (key !== S) return
    const core = seeder._groupServed.get(S).core
    const get = core.get
    core.get = function (seq, opts) {
      if (seq === 0 && opts && opts.raw === true) {
        reads++
        if (!failed) {
          failed = true
          return Promise.reject(new Error('leitura falhou'))
        }
      }
      return get.call(this, seq, opts)
    }
  }
  const started = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, onGroupNotice: (e) => notices.push(e), regateHook })
  seeder = started.seeder
  const { events } = started

  let W = null
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    S = await make('s', groupHeader({ diary: key, name: 'Roda livre' }))
    return [groupJoinRecord({ group: S, writer: S, on: true })]
  })
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: S, diary: key, member: S }))
    return [groupJoinRecord({ group: S, writer: W, on: true })]
  })
  await admit(A, assoc)
  await admit(B, assoc)
  for (const key of [S, W]) await admitted(events, key)
  const root = seeder._groupServed.get(S)
  // Natural passes (root and diary scans) read block 0 again; settled as
  // not standalone, it would never be read again.
  await until(() => failed && root.standalone === true, { name: 'bloco 0 lido de novo' })
  t.pass('the first read of block 0 failed and a later pass found the root standalone')

  // Queueing starts a scan at once, so only an idle state that is not done
  // yet asks for another pass.
  await until(() => {
    const s = root.groupNotice
    const ok = Boolean(s) && !s.busy && s.hint.allowed(B.key) === true
    if (!ok && !(s && s.busy)) seeder._queueGroupNotices(S)
    return ok
  }, { name: 'dica de S depois da falha', timeoutMs: 60000 })
  t.is(root.standalone, true, 'a later pass read block 0 again')
  t.ok(reads >= 2, 'block 0 was read again after the failure')

  await B.cores.w.append(encode(groupPost({ text: 'oi' })))
  await until(() => notices.length === 1, { name: 'aviso depois da falha' })
  t.alike(notices[0].recipients, [A.key])
  t.is(notices[0].name, 'Roda livre')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root its creator never bound sends no notice, even with members posting', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const notices = []
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, onGroupNotice: (e) => notices.push(e) })

  // B makes root R naming A as its creator; A is served and never joins R.
  // B and D join R with writers naming R and post there.
  const k = {}
  const A = await member(t, bootstrap, assoc, async () => [])
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.R = await make('r', groupHeader({ diary: A.key, name: 'Sem dona' }))
    k.WB = await make('wb', writerHeader({ group: k.R, diary: key, member: k.R }))
    return [groupJoinRecord({ group: k.R, writer: k.WB, on: true })]
  })
  const D = await member(t, bootstrap, assoc, async ({ key, make }) => {
    k.WD = await make('wd', writerHeader({ group: k.R, diary: key, member: k.R }))
    return [groupJoinRecord({ group: k.R, writer: k.WD, on: true })]
  })
  const { R, WB, WD } = k
  for (const m of [A, B, D]) await admit(m, assoc)
  for (const key of [R, WB, WD]) await admitted(events, key)
  await until(() => scansDone(seeder), { name: 'varreduras' })
  t.is(seeder._groupIndex.writer(R), null, 'the unbound root has no index row')

  // Several idle passes, so a hint that could complete would have.
  const passes = async (n, name) => {
    for (let i = 0; i < n; i++) {
      seeder._queueGroupNotices(R)
      await until(() => {
        const s = seeder._groupServed.get(R).groupNotice
        return s !== null && !s.busy
      }, { name: name + ' ' + i, timeoutMs: 30000 })
    }
  }
  await passes(4, 'passagem antes dos posts')
  t.is(seeder._groupServed.get(R).standalone, true, 'R is a standalone root')
  await B.cores.wb.append(encode(groupPost({ text: 'oi' })))
  await D.cores.wd.append(encode(groupPost({ text: 'olá' })))
  await downloaded(seeder, WB, 2)
  await downloaded(seeder, WD, 2)
  await passes(4, 'passagem depois dos posts')
  t.alike(notices, [], 'no notice at all')
  t.absent(notices.some((n) => n.recipients.includes(A.key)), 'A is in no recipients list')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

// In-memory seeder: hand-built cores of one group, every diary scan complete.
function hexKey () {
  return b4a.toString(randomBytes(32), 'hex')
}

function memFixture ({ rootRecord, indexRecord = rootRecord, block0 = null } = {}) {
  const G = hexKey()
  const creator = rootRecord.diary
  const logs = new Map([[G, { diary: creator, entries: [rootRecord] }]])
  const events = []
  const seeder = new Seeder({ onGroupNotice: (e) => events.push(e) })
  seeder._keyPair = signingKeyPair()
  seeder._passesStarted = true
  seeder._groupIndex = createGroupIndex()
  seeder._groupIncomplete = () => false
  let reads = 0
  const serve = (key) => {
    const log = logs.get(key)
    const core = {
      fork: 0,
      get length () { return log.entries.length },
      get contiguousLength () { return log.entries.length },
      async get (seq, opts) {
        if (key === G && seq === 0 && opts && opts.raw === true) {
          reads++
          if (block0 !== null) return block0(reads)
        }
        return encode(log.entries[seq])
      }
    }
    seeder._groupServed.set(key, { core, group: G, diary: log.diary, headerOk: true, dropped: false, noticeFrom: core.length, groupNotice: null, standalone: null, cut: null })
    seeder._groups.set(key, { group: G, diary: log.diary, seq: 1, bound: true })
    seeder._groupIndex.addWriter(G, key, log.diary, 1)
    let diary = seeder._served.get(log.diary)
    if (!diary) {
      diary = { core: { length: 1, contiguousLength: 1 }, scanned: 1, gated: true, dropped: false, groupEvents: new Map(), groupLive: new Map() }
      seeder._served.set(log.diary, diary)
    }
    diary.groupLive.set(key, { group: G, seq: 1, left: false })
  }
  const f = {
    G,
    seeder,
    events,
    reads: () => reads,
    root: () => seeder._groupServed.get(G),
    add (diary, header = writerHeader({ group: G, diary, member: G })) {
      const key = hexKey()
      logs.set(key, { diary, entries: [header] })
      serve(key)
      return key
    },
    push (key, record) {
      logs.get(key).entries.push(record)
    },
    // One natural pass: queue, then let the block 0 read, the re-queue it
    // may start and the scan chain settle.
    async pass () {
      seeder._queueGroupNotices()
      for (let i = 0; i < 6; i++) {
        await seeder._groupNoticeScan
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  }
  serve(G)
  seeder._groupIndex.setHeader(G, indexRecord)
  return f
}

test('a group naming a community whose parent root is missing gets no notice state and no block 0 read', async (t) => {
  const Z = hexKey()
  const f = memFixture({ rootRecord: groupHeader({ diary: Z, community: hexKey(), member: hexKey(), name: 'Sem comunidade à vista' }) })
  f.add(hexKey())
  await f.pass()
  await f.pass()
  t.is(f.root().groupNotice, null, 'no notice state')
  t.is(f.root().standalone, null, 'never judged standalone')
  t.is(f.reads(), 0, 'block 0 is never read')
})

test('an index header with no community over a block 0 that is no standalone header settles once, never read again', async (t) => {
  const Z = hexKey()
  const standalone = groupHeader({ diary: Z, name: 'Roda' })
  const cases = [
    ['a community group header', () => encode(groupHeader({ diary: Z, community: hexKey(), member: hexKey(), name: 'Roda' }))],
    ['an undecodable block', () => b4a.from('not json')]
  ]
  for (const [label, block] of cases) {
    const f = memFixture({ rootRecord: standalone, block0: block })
    f.add(hexKey())
    await f.pass()
    t.is(f.root().standalone, false, label + ': settled as not standalone')
    t.is(f.reads(), 1, label + ': read once')
    await f.pass()
    await f.pass()
    t.is(f.reads(), 1, label + ': never read again')
    t.is(f.root().groupNotice, null, label + ': no notice state')
  }
})

test('a block 0 not held locally stays unknown and is read again on a later pass', async (t) => {
  const Z = hexKey()
  const f = memFixture({ rootRecord: groupHeader({ diary: Z, name: 'Roda' }), block0: (n) => n === 1 ? null : encode(groupHeader({ diary: Z, name: 'Roda' })) })
  const B = hexKey()
  const WB = f.add(B)
  await f.pass()
  t.is(f.root().standalone, null, 'still unknown')
  t.is(f.root().groupNotice, null, 'no notice state yet')
  t.is(f.reads(), 1)
  await f.pass()
  // The notice scan reads block 0 too, but only once the check passed.
  t.ok(f.reads() >= 2, 'a later pass read block 0 again')
  t.is(f.root().standalone, true)
  t.not(f.root().groupNotice, null, 'the hint is set up')
  f.push(WB, groupPost({ text: 'oi' }))
  await f.pass()
  t.is(f.events.length, 1)
  t.alike(f.events[0].recipients, [Z])
})

test('a member that leaves stops being a recipient and a creator leave silences the group', async (t) => {
  const Z = hexKey()
  const f = memFixture({ rootRecord: groupHeader({ diary: Z, name: 'Roda' }) })
  const B = hexKey()
  const X = hexKey()
  const WB = f.add(B)
  const WX = f.add(X)
  await f.pass()
  f.push(WB, groupPost({ text: 'um' }))
  await f.pass()
  t.is(f.events.length, 1)
  t.alike([...f.events[0].recipients].sort(), [Z, X].sort(), 'both other members are told')
  f.push(WX, groupLeave({ cuts: [{ writer: WX, seq: 1 }] }))
  await f.pass()
  f.push(WB, groupPost({ text: 'dois' }))
  await f.pass()
  t.is(f.events.length, 2)
  t.alike(f.events[1].recipients, [Z], 'the member that left is no longer told')
  f.push(f.G, groupLeave({ cuts: [{ writer: f.G, seq: 1 }] }))
  await f.pass()
  f.push(WB, groupPost({ text: 'três' }))
  await f.pass()
  t.is(f.events.length, 2, 'a creator leave silences the group')
})
