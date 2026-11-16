'use strict'

const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert } = require('../../lib/cert')
const store = require('../../lib/store')
const member = require('../../lib/member')
const { groupJoinRecord } = require('../../lib/records')
const { tmpDir } = require('./tmp')

const hex = (key) => b4a.toString(key, 'hex')

async function person (t, kp, name) {
  const ctx = { dataDir: tmpDir(t), association: hex(kp.publicKey) }
  const { publicKey } = await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: publicKey }, kp))
  await member.profileSet(ctx, { name })
  return { ...ctx, key: publicKey }
}

// Protocol v2: every group lives in a community. Each creator gets one open
// community (and its Geral) on first use; a joiner enters the group's
// community first.
const communityOfGroup = new Map()

async function communityFor (ctx) {
  const own = store.readGroups(ctx.dataDir).find((g) => g.kind === 'community' && g.writer === g.group)
  if (own) return own.group
  return (await member.communityCreate(ctx, { name: 'Bairro', join: 'open' })).community
}

// The CW of `ctx` in the community of `group`, or null.
function cwOf (ctx, group) {
  const entry = store.readGroups(ctx.dataDir).find((g) => g.kind === 'community' && g.group === communityOfGroup.get(group))
  return entry ? entry.writer : null
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

// Corestore replication in process, without sockets or a DHT.
async function exchange (from, to, skip = null) {
  const a = await store.openStore(from.dataDir)
  const b = await store.openStore(to.dataDir)
  let left
  let right
  try {
    const copies = []
    for await (const dk of a.list()) {
      const source = a.get({ discoveryKey: dk, writable: false })
      await source.ready()
      if (skip !== null && skip.has(hex(source.key))) {
        await source.close()
        continue
      }
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

async function sync (...people) {
  for (const x of people) for (const y of people) if (x !== y) await exchange(x, y)
}

async function rootEntries (ctx, group) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const core = s.get({ key: b4a.from(group, 'hex'), writable: false })
    await core.ready()
    return await store.readAll(core)
  } finally {
    await s.close()
  }
}

function filesOf (dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.lstatSync(p)
    if (st.isDirectory()) out.push(...filesOf(p))
    else if (st.isFile()) out.push(p)
  }
  return out
}

// Appends to this device's writer of `group` with no record check.
async function rawAppend (ctx, group, record) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const local = store.readGroups(ctx.dataDir).find((g) => g.group === group)
    const writer = await store.openGroupWriter(s, local.nonce)
    return await store.appendRecord(writer, record, { validator: () => null })
  } finally {
    await s.close()
  }
}

// A writer of `group` made by hand with header `box`, recorded in
// groups.json, and bound by the diary only when `bind` is true.
async function plantWriter (ctx, group, box, bind) {
  const nonce = hex(crypto.randomBytes(16))
  const key = await member.withIdentity(ctx, async ({ store: s, diary }) => {
    const writer = await store.openGroupWriter(s, nonce)
    // Built raw: the builder refuses a low-order box.
    const header = { type: 'group-writer', v: 2, group, diary: ctx.key, member: cwOf(ctx, group), box, rejoin: null, at: new Date().toISOString() }
    await store.appendRecord(writer, header, { validator: () => null })
    const k = hex(writer.key)
    if (bind) await store.appendRecord(diary, groupJoinRecord({ group, writer: k, on: true }))
    return k
  })
  store.writeGroups(ctx.dataDir, [...store.readGroups(ctx.dataDir).filter((g) => g.group !== group), { group, writer: key, nonce }])
  return key
}

function ownWriter (ctx, group) {
  return store.readGroups(ctx.dataDir).find((g) => g.group === group).writer
}

function texts (r) {
  return r.items.filter((p) => !p.hidden).map((p) => p.text).sort()
}

async function privateGroup (t) {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Segredo', join: 'open', visibility: 'private' })
  await exchange(a, b)
  await joinGroup(b, { group })
  await exchange(b, a)
  return { kp, a, b, group }
}

module.exports = { hex, person, communityOfGroup, communityFor, cwOf, createGroup, joinGroup, exchange, sync, rootEntries, filesOf, rawAppend, plantWriter, ownWriter, texts, privateGroup }
