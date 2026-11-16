'use strict'

const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert } = require('../../lib/cert')
const { groupJoinRecord } = require('../../lib/records')
const groupLib = require('../../lib/group')
const store = require('../../lib/store')
const member = require('../../lib/member')
const { tmpDir } = require('./tmp')

const hex = (key) => b4a.toString(key, 'hex')
const AT = '2026-01-01T00:00:00.000Z'

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

async function pair (t, join = 'open') {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Horta', join })
  await exchange(a, b)
  const joined = await joinGroup(b, { group })
  await exchange(b, a)
  return { a, b, group, kp, joined }
}

async function writerEntries (ctx, group) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const local = store.readGroups(ctx.dataDir).find((g) => g.group === group)
    const writer = await store.openGroupWriter(s, local.nonce)
    return { key: hex(writer.key), entries: await store.readAll(writer), length: writer.length }
  } finally {
    await s.close()
  }
}

async function offlineAppend (ctx, group, record) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const local = store.readGroups(ctx.dataDir).find((g) => g.group === group)
    const writer = await store.openGroupWriter(s, local.nonce)
    const seq = await store.appendRecord(writer, record, {
      validator: (r, seq) => groupLib.validateGroupRecord(r, seq, { root: local.writer === group })
    })
    return { writer: local.writer, seq }
  } finally {
    await s.close()
  }
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

// Protocol v2: every group lives in a community. Each creator gets one open
// community (and its Geral) on first use; a joiner enters the group's
// community first.
const communityOfGroup = new Map()
// A community key for raw roots that only fill slots (never folded as members).
const FILL = 'cd'.repeat(32)

// The CW of `ctx` in the community of `group`, or null.
function cwOf (ctx, group) {
  const entry = store.readGroups(ctx.dataDir).find((g) => g.kind === 'community' && g.group === communityOfGroup.get(group))
  return entry ? entry.writer : null
}

async function communityFor (ctx) {
  const own = store.readGroups(ctx.dataDir).find((g) => g.kind === 'community' && g.writer === g.group)
  if (own) return own.group
  return (await member.communityCreate(ctx, { name: 'Bairro', join: 'open' })).community
}

async function createGroup (ctx, params) {
  const community = await communityFor(ctx)
  const r = await member.groupCreate(ctx, { ...params, community })
  communityOfGroup.set(r.group, community)
  return r
}

async function joinGroup (ctx, params) {
  const community = communityOfGroup.get(params.group)
  if (community !== undefined) await member.communityJoin(ctx, { community })
  return member.groupJoin(ctx, community === undefined ? params : { ...params, community })
}

async function groupJoins (ctx, group) {
  const { entries } = await member.logRead(ctx)
  return entries.filter((e) => e.record && e.record.type === 'group-join' && e.record.group === group).map((e) => e.record)
}

async function heldWriters (ctx, group) {
  const s = await store.openStore(ctx.dataDir)
  let n = 0
  try {
    for await (const dk of s.list()) {
      const core = s.get({ discoveryKey: dk, writable: false, active: false })
      try {
        await core.ready()
        if (core.contiguousLength === 0) continue
        const h = (await store.readAll(core))[0].record
        if (h && h.type === 'group-writer' && h.group === group) n++
      } finally {
        await core.close()
      }
    }
  } finally {
    await s.close()
  }
  return n
}

async function pendingPair (t, join = 'open', { ban = false } = {}) {
  const kp = crypto.keyPair()
  const a = await person(t, kp)
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Horta', join })
  if (ban) await member.groupBan(a, { group, member: b.key, on: true })
  // b holds the community and Geral, not the group root.
  await exchange(a, b)
  const s = await store.openStore(b.dataDir)
  await store.purgeReplica(s, group)
  await s.close()
  return { a, b, group }
}

async function otherDevice (ctx, group, nonce, records = []) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const writer = await store.openGroupWriter(s, nonce)
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    await store.appendRecord(writer, groupLib.writerHeader({ group, member: cwOf(ctx, group), diary: ctx.key }), { validator })
    for (const r of records) await store.appendRecord(writer, r, { validator })
    const diary = await store.openDiary(s)
    await store.appendRecord(diary, groupJoinRecord({ group, writer: hex(writer.key), on: true }))
    return { key: hex(writer.key), length: writer.length }
  } finally {
    await s.close()
  }
}

// Another device of the diary bound `writer`, whose core never reached here.
async function bindElsewhere (ctx, group, writer) {
  const s = await store.openStore(ctx.dataDir)
  try {
    await store.appendRecord(await store.openDiary(s), groupJoinRecord({ group, writer, on: true }))
  } finally {
    await s.close()
  }
}

// Another device of ctx's diary: a writer core bound by a join on, with
// `posts` group posts after its header.
async function otherWriter (ctx, group, nonce, posts = 0) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = await store.openGroupWriter(s, nonce)
    const validator = (r, seq) => groupLib.validateGroupRecord(r, seq)
    await store.appendRecord(core, groupLib.writerHeader({ group, member: cwOf(ctx, group), diary: ctx.key, rejoin: null }), { validator })
    for (let i = 0; i < posts; i++) await store.appendRecord(core, groupLib.groupPost({ text: 'outro ' + i }), { validator })
    await store.appendRecord(await store.openDiary(s), groupJoinRecord({ group, writer: hex(core.key), on: true }))
    return hex(core.key)
  } finally {
    await s.close()
  }
}

const THUMBS = '\u{1f44d}'
const HEART = '❤️'

module.exports = { hex, AT, person, exchange, pair, writerEntries, offlineAppend, rejects, communityOfGroup, FILL, cwOf, communityFor, createGroup, joinGroup, groupJoins, heldWriters, pendingPair, otherDevice, bindElsewhere, otherWriter, THUMBS, HEART }
