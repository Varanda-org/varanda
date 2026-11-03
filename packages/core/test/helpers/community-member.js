'use strict'

const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert } = require('../../lib/cert')
const { groupJoinRecord, deleteRecord } = require('../../lib/records')
const groupLib = require('../../lib/group')
const store = require('../../lib/store')
const member = require('../../lib/member')
const { tmpDir } = require('./tmp')

const hex = (key) => b4a.toString(key, 'hex')

const leaveNoteFile = (ctx) => path.join(ctx.dataDir, 'community-leave.json')

async function person (t, kp, name = 'Ana', certified = true) {
  const ctx = { dataDir: tmpDir(t), association: hex(kp.publicKey) }
  const { publicKey } = await member.idCreate(ctx)
  if (certified) {
    await member.certAdd(ctx, createCert({ member: publicKey }, kp))
    await member.profileSet(ctx, { name })
  }
  return { ...ctx, key: publicKey }
}

// Corestore replication stays entirely in process, without sockets or a DHT.
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

// Everyone ends holding every core anyone holds.
async function sync (...people) {
  for (const from of people) for (const to of people) if (from !== to) await exchange(from, to)
  for (const from of people) for (const to of people) if (from !== to) await exchange(from, to)
}

async function coreEntries (ctx, key) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = s.get({ key: b4a.from(key, 'hex'), writable: false })
    await core.ready()
    return await store.readAll(core)
  } finally {
    await s.close()
  }
}

function entryOf (ctx, key) {
  return store.readGroups(ctx.dataDir).find((g) => g.group === key)
}

async function rejects (t, promise, message, code = 'USAGE') {
  try {
    await promise
    t.fail('expected rejection')
  } catch (err) {
    t.is(err.message, message)
    t.is(err.code, code)
  }
}

// A community of `a` that `others` joined, every core shared.
async function world (t, { join = 'open', names = ['Bia', 'Caio'] } = {}) {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const others = []
  for (const name of names) others.push(await person(t, kp, name))
  const { community, group: geral } = await member.communityCreate(a, { name: 'Bairro', join })
  for (const o of others) {
    await exchange(a, o)
    await member.communityJoin(o, { community })
    await exchange(o, a)
  }
  await sync(a, ...others)
  return { kp, a, others, community, geral }
}

// C's fold over the cores and diaries `ctx` holds, as a node builds it.
async function foldC (ctx, community, writerKeys) {
  const root = await coreEntries(ctx, community)
  const writers = []
  for (const key of writerKeys) {
    const entries = await coreEntries(ctx, key)
    writers.push({ key, entries, diary: entries[0].record.diary })
  }
  const joins = new Map()
  const confirms = new Map()
  for (const d of new Set([root[0].record.diary, ...writers.map((w) => w.diary)])) {
    const entries = await coreEntries(ctx, d)
    joins.set(d, groupLib.groupJoinHistory(entries, community))
    confirms.set(d, groupLib.groupConfirmHistory(entries, community))
  }
  return groupLib.buildCommunity({ root: { key: community, entries: root }, writers, joins, confirms })
}

// The leave records on core `key` of `ctx`.
async function leavesOn (ctx, key) {
  return (await coreEntries(ctx, key)).filter((e) => e.seq >= 1 && e.record.type === 'group-leave')
}

function texts (read) {
  return read.items.map((i) => (i.hidden ? '[hidden]' : i.text))
}

// Another device of the same diary, written into this store: a core for
// `group` with `header` and `records` (each a function of the core key),
// bound by a diary join. Returns its key.
async function otherDevice (ctx, group, nonce, header, records = [], community = false) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = await store.openGroupWriter(s, nonce)
    const key = hex(core.key)
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq, { community })
    await store.appendRecord(core, header, { validator })
    for (const make of records) await store.appendRecord(core, make(key), { validator })
    await store.appendRecord(await store.openDiary(s), groupJoinRecord({ group, writer: key, on: true }))
    return key
  } finally {
    await s.close()
  }
}

// Appends `record` to a root this person created.
async function rootAppend (ctx, key, record, community) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = await store.openGroupWriter(s, entryOf(ctx, key).nonce)
    await store.appendRecord(core, record, { validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { root: true, community }) })
  } finally {
    await s.close()
  }
}

async function joinGroup (ctx, group) {
  return member.groupJoin(ctx, { group })
}

// Appends a `delete` record (a diary record) on a group core this store holds
// the key of, as a holder of a copy of that device key could.
async function deleteOn (ctx, nonce, seq) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = await store.openGroupWriter(s, nonce)
    await store.appendRecord(core, deleteRecord({ seq }))
  } finally {
    await s.close()
  }
}

const cutsOf = async (ctx) => (await member.logRead(ctx)).entries.map((e) => e.record).filter((r) => r.type === 'group-cut')

// The creator's leave stops after its note and append (a mark fails), and
// another device of the diary comes back: the diary is a member again.
async function leaveThenReturn (t) {
  const w = await world(t, { names: ['Bia'] })
  const { a, community } = w
  a.onMark = () => { throw new Error('falha simulada') }
  await t.exception(() => member.communityLeave(a, { community }), /falha simulada/)
  delete a.onMark
  const [leave] = await leavesOn(a, community)
  await otherDevice(a, community, 'b7'.repeat(16), groupLib.writerHeader({ group: community, diary: a.key, rejoin: { writer: community, seq: leave.seq } }), [], true)
  t.is((await member.communityInfo(a, { community })).leavePending, true, 'info offers to finish the leave')
  return { ...w, leave }
}

function finished (t, log, { community, geral, leave }) {
  const cut = log.findIndex((r) => r.type === 'group-cut' && r.group === geral && r.writer === geral)
  const conf = log.findIndex((r) => r.type === 'group-confirm' && r.group === community && r.writer === community && r.seq === leave.seq)
  const off = log.findIndex((r) => r.type === 'group-join' && r.group === community && r.writer === community && r.on === false)
  t.ok(cut >= 0 && conf > cut && off > conf, 'the mark, the group-confirm, then the off join')
}

module.exports = { hex, leaveNoteFile, person, exchange, sync, coreEntries, entryOf, rejects, world, foldC, leavesOn, texts, otherDevice, rootAppend, joinGroup, deleteOn, cutsOf, leaveThenReturn, finished }
