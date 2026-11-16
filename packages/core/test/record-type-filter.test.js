'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const certLib = require('../lib/cert')
const records = require('../lib/records')
const {
  validRecordCopy, validRecordCopyOfType, latestProfile, profileRecord, postRecord, followRecord, likeRecord,
  groupJoinRecord, groupConfirmRecord, groupCutRecord, isPlainObject, plainCopy
} = records
const { latestUsernameRecord, heldUsernames } = require('../lib/username')
const {
  groupJoins, groupJoinHistory, groupConfirmHistory, groupCutHistory, diaryGroupKeys, MAX_GROUPS_PER_DIARY, MAX_GROUP_WRITERS_PER_DIARY
} = require('../lib/group')

const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)
const G = 'c'.repeat(64)
const W = 'd'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const DIGEST = 'e'.repeat(64)

// The walkers as they were before the type pre-filter: copy and validate
// every record, then drop the ones of another type.
function oracleProfile (entries) {
  let best = null
  for (const { seq, record } of entries) {
    const copy = validRecordCopy(record, seq)
    if (copy === null || copy.type !== 'profile') continue
    if (best === null || seq > best.seq) best = { seq, name: copy.name, bio: copy.bio, avatar: copy.avatar }
  }
  if (!best) return null
  return { name: best.name, bio: best.bio, avatar: best.avatar === undefined ? null : best.avatar }
}

function oracleUsernameRecord (entries, memberHex, associationHex, opts) {
  try {
    const member = certLib.normalizeHex(memberHex)
    if (member === null) return null
    let best = null
    let bestSeq = -1
    for (const { seq, record } of entries) {
      if (!Number.isSafeInteger(seq) || seq <= bestSeq) continue
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'username' || copy.member !== member) continue
      best = copy
      bestSeq = seq
    }
    if (best === null) return null
    return certLib.verifyUsernameRecord(best, member, associationHex, opts).ok ? best : null
  } catch {
    return null
  }
}

function oracleHeld (entries, memberHex, associationHex, opts) {
  const held = new Map()
  try {
    const member = certLib.normalizeHex(memberHex)
    if (member === null) return held
    const bySeq = new Map()
    for (const { seq, record } of entries) {
      if (!Number.isSafeInteger(seq) || bySeq.has(seq)) continue
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'username' || copy.member !== member) continue
      bySeq.set(seq, copy)
    }
    const newest = [...bySeq.keys()].sort((a, b) => b - a).slice(0, 64)
    for (const seq of newest) {
      const record = bySeq.get(seq)
      if (held.has(record.username)) continue
      if (certLib.verifyUsernameRecord(record, member, associationHex, opts).ok) held.set(record.username, record.issuer)
    }
    return held
  } catch {
    return new Map()
  }
}

// Same entry reading as group.js eachEntry.
function oracleEach (entries, fn) {
  if (!Array.isArray(entries)) return
  for (let i = 0; i < entries.length; i++) {
    const e = plainCopy(entries[i])
    if (e === null) {
      let seq = null
      try {
        if (isPlainObject(entries[i]) && Number.isSafeInteger(entries[i].seq) && entries[i].seq >= 0) seq = entries[i].seq
      } catch {}
      if (seq !== null) fn(seq, null)
      continue
    }
    if (!Number.isSafeInteger(e.seq) || e.seq < 0) continue
    fn(e.seq, e.record)
  }
}

function oracleJoins (entries) {
  const latest = new Map()
  try {
    oracleEach(entries, (seq, record) => {
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-join') return
      const prev = latest.get(copy.writer)
      if (!prev || seq > prev.seq) latest.set(copy.writer, { group: copy.group, writer: copy.writer, on: copy.on, seq, at: copy.at })
    })
  } catch {}
  const out = new Map()
  for (const writer of [...latest.keys()].sort()) {
    const j = latest.get(writer)
    if (j.on) out.set(writer, { group: j.group, writer, seq: j.seq, at: j.at })
  }
  return out
}

function oracleConfirm (entries, group) {
  const out = []
  try {
    oracleEach(entries, (seq, record) => {
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-confirm' || copy.group !== group) return
      out.push({ writer: copy.writer, seq: copy.seq, digest: copy.digest, dseq: seq })
    })
  } catch {}
  return out
}

function oracleCut (entries, group) {
  const out = []
  let next = 0
  let gap = false
  try {
    oracleEach(entries, (seq, record) => {
      if (seq !== next) gap = true
      next = seq + 1
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-cut' || copy.group !== group) return
      out.push({ writer: copy.writer, cut: copy.cut, seq })
    })
  } catch {
    gap = true
  }
  if (gap) out.push({ gap: true })
  return out
}

function oracleJoinHistory (entries, group) {
  const out = []
  try {
    oracleEach(entries, (seq, record) => {
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-join' || copy.group !== group) return
      out.push({ writer: copy.writer, on: copy.on, seq, rejoin: copy.rejoin === undefined ? null : copy.rejoin })
    })
  } catch {}
  return out.sort((a, b) => a.seq - b.seq || (a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0))
}

// diaryGroupKeys as it was: two copy-then-check passes (the second is
// groupJoins).
function oracleKeys (entries, max = MAX_GROUPS_PER_DIARY) {
  try {
    if (!Array.isArray(entries)) return []
    const first = new Map()
    oracleEach(entries, (seq, record) => {
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'group-join' || copy.on !== true) return
      let writers = first.get(copy.group)
      if (writers === undefined) {
        writers = new Map()
        first.set(copy.group, writers)
      }
      if (!writers.has(copy.writer) || seq < writers.get(copy.writer)) writers.set(copy.writer, seq)
    })
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
    const allowed = new Set()
    for (const [group, writers] of first) {
      const list = [...writers].sort((a, b) => a[1] - b[1] || cmp(a[0], b[0]))
      let room = MAX_GROUP_WRITERS_PER_DIARY
      if (writers.has(group)) {
        allowed.add(group + ':' + group)
        room--
      }
      for (const [writer] of list) {
        if (writer === group) continue
        if (room <= 0) break
        allowed.add(group + ':' + writer)
        room--
      }
    }
    const live = [...oracleJoins(entries).values()].sort((a, b) => a.seq - b.seq)
    const groups = new Set()
    const out = []
    for (const j of live) {
      if (!allowed.has(j.group + ':' + j.writer)) continue
      if (groups.has(j.group)) continue
      if (groups.size >= max) continue
      groups.add(j.group)
      out.push(j.group)
    }
    return out
  } catch {
    return []
  }
}

function issuerSetup () {
  const assocKp = crypto.keyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = certLib.createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex'), date: AT }, assocKp)
  return { assocHex: issuerCert.association, issuerKp, issuerCert }
}

function rng (seed) {
  let s = seed
  return (n) => {
    s = (s * 1103515245 + 12345) % 2147483648
    return (s >>> 8) % n
  }
}

// Makers of valid records of many types, wrong types, wanted types that fail
// validation, and junk of every shape the pre-filter must read.
function pool (setup) {
  const named = (name) => certLib.createUsernameRecord({ member: K1, username: name, date: AT }, setup.issuerKp, setup.issuerCert)
  const getter = { ...profileRecord({ name: 'Ana', at: AT }) }
  Object.defineProperty(getter, 'type', { enumerable: true, get () { return 'profile' } })
  const throwing = { ...profileRecord({ name: 'Ana', at: AT }) }
  Object.defineProperty(throwing, 'type', { enumerable: true, get () { throw new Error('boom') } })
  const inherited = Object.create({ type: 'profile' })
  Object.assign(inherited, { name: 'Ana', bio: '', at: AT })
  const proxy = new Proxy(profileRecord({ name: 'Ana', at: AT }), { getOwnPropertyDescriptor () { throw new Error('trap') } })
  return [
    () => profileRecord({ name: 'Ana', bio: 'oi', at: AT }),
    () => profileRecord({ name: 'Bia', at: AT }),
    () => postRecord({ text: 'oi', at: AT }),
    () => followRecord({ key: K2, on: true, at: AT }),
    () => likeRecord({ to: { author: K2, seq: 1 }, on: true, at: AT }),
    () => groupJoinRecord({ group: G, writer: W, on: true, at: AT }),
    () => groupJoinRecord({ group: G, writer: K2, on: false, at: AT }),
    () => groupJoinRecord({ group: K2, writer: W, on: true, at: AT }),
    () => groupConfirmRecord({ group: G, writer: W, seq: 3, digest: DIGEST, at: AT }),
    () => groupCutRecord({ group: G, writer: W, cut: 2, at: AT }),
    () => named('ana'),
    () => named('bia'),
    () => ({ ...named('cat'), member: K2 }),
    () => ({ ...named('dan'), signature: 'f'.repeat(128) }),
    () => ({ ...profileRecord({ name: 'Ana', at: AT }), extra: 1 }),
    () => ({ type: 'profile', name: 5 }),
    () => ({ type: 'username' }),
    () => ({ type: 'group-join' }),
    () => ({ type: 'group-cut', group: G }),
    () => ({ type: 'group-confirm', group: G }),
    () => ({ type: 'nope' }),
    () => ({ type: 7 }),
    () => ({ type: null }),
    () => ({ name: 'sem tipo' }),
    () => ({}),
    () => null,
    () => 3,
    () => 'texto',
    () => [],
    () => [profileRecord({ name: 'Ana', at: AT })],
    () => getter,
    () => throwing,
    () => inherited,
    () => proxy,
    () => Object.create(null)
  ]
}

function genesis (setup) {
  const v2 = certLib.createIssuedCert({ member: K1, date: AT }, setup.issuerKp, setup.issuerCert)
  return { seq: 0, record: { type: 'member-cert', cert: v2 } }
}

function randomEntries (rand, makers, setup) {
  const entries = [genesis(setup)]
  const count = rand(30)
  let seq = 1
  for (let i = 0; i < count; i++) {
    seq += rand(8) === 0 ? 1 + rand(3) : 1
    entries.push({ seq, record: makers[rand(makers.length)]() })
  }
  if (rand(4) === 0) entries.push({ seq: -1, record: profileRecord({ name: 'Z', at: AT }) })
  if (rand(4) === 0) entries.push({ seq: 1.5, record: profileRecord({ name: 'Z', at: AT }) })
  return entries
}

function oracleRounds (t) {
  const rand = rng(11)
  const setup = issuerSetup()
  const makers = pool(setup)
  let profiles = 0
  let names = 0
  let joins = 0
  let cuts = 0
  for (let round = 0; round < 300; round++) {
    const entries = randomEntries(rand, makers, setup)
    const p = latestProfile(entries)
    t.alike(p, oracleProfile(entries), 'profile ' + round)
    if (p !== null) profiles++
    const u = latestUsernameRecord(entries, K1, setup.assocHex)
    t.alike(u, oracleUsernameRecord(entries, K1, setup.assocHex), 'username ' + round)
    if (u !== null) names++
    t.alike([...heldUsernames(entries, K1, setup.assocHex)], [...oracleHeld(entries, K1, setup.assocHex)], 'held ' + round)
    t.alike([...groupJoins(entries)], [...oracleJoins(entries)], 'joins ' + round)
    t.alike(groupConfirmHistory(entries, G), oracleConfirm(entries, G), 'confirms ' + round)
    t.alike(groupCutHistory(entries, G), oracleCut(entries, G), 'cuts ' + round)
    t.alike(groupJoinHistory(entries, G), oracleJoinHistory(entries, G), 'join history ' + round)
    if (groupJoins(entries).size > 0) joins++
    if (groupCutHistory(entries, G).some((c) => !c.gap)) cuts++
    t.alike(diaryGroupKeys(entries), oracleKeys(entries), 'keys ' + round)
  }
  t.ok(profiles > 50 && names > 20 && joins > 50 && cuts > 50, 'the rounds exercised the wanted types')
}

test('type pre-filter: every walker answers as copy-then-check on random diaries', (t) => {
  oracleRounds(t)
})

test('type pre-filter: same answers on the plainClone fallback (no structuredClone)', (t) => {
  const original = globalThis.structuredClone
  t.teardown(() => { globalThis.structuredClone = original })
  globalThis.structuredClone = undefined
  oracleRounds(t)
})

test('validRecordCopyOfType: same copy as validRecordCopy for the wanted type, null otherwise', (t) => {
  const setup = issuerSetup()
  for (const make of pool(setup)) {
    for (const type of ['profile', 'username', 'group-join', 'group-cut', 'group-confirm']) {
      const full = validRecordCopy(make(), 4)
      const expected = full !== null && full.type === type ? full : null
      t.alike(validRecordCopyOfType(make(), 4, type), expected)
    }
  }
})

test('type pre-filter: a diary of N records with one profile clones one', (t) => {
  const original = globalThis.structuredClone
  let clones = 0
  globalThis.structuredClone = (v) => { clones++; return original(v) }
  try {
    const N = 200
    const entries = [{ seq: 0, record: { type: 'member-cert', cert: {} } }]
    for (let i = 1; i < N; i++) entries.push({ seq: i, record: i === 120 ? profileRecord({ name: 'Ana', at: AT }) : postRecord({ text: 'p' + i, at: AT }) })
    t.alike(latestProfile(entries), { name: 'Ana', bio: '', avatar: null })
    t.is(clones, 1, 'one clone for N records')
    clones = 0
    t.is(latestUsernameRecord(entries, K1, issuerSetup().assocHex), null)
    t.is(clones, 0, 'no clone when no record is a username')
  } finally {
    globalThis.structuredClone = original
  }
})

// Counts structuredClone calls of one walker run. A group walker clones each
// entry once (eachEntry) and then only the records of its own type.
function clonesOf (fn) {
  const original = globalThis.structuredClone
  let clones = 0
  globalThis.structuredClone = (v) => { clones++; return original(v) }
  try {
    fn()
  } finally {
    globalThis.structuredClone = original
  }
  return clones
}

test('type pre-filter: heldUsernames and the group walkers copy only records of their type', (t) => {
  const setup = issuerSetup()
  const N = 100
  const entries = [genesis(setup)]
  for (let i = 1; i < N; i++) entries.push({ seq: i, record: postRecord({ text: 'p' + i, at: AT }) })
  const put = (seq, record) => { entries[seq] = { seq, record } }
  put(10, certLib.createUsernameRecord({ member: K1, username: 'ana', date: AT }, setup.issuerKp, setup.issuerCert))
  put(20, certLib.createUsernameRecord({ member: K1, username: 'bia', date: AT }, setup.issuerKp, setup.issuerCert))
  put(30, groupJoinRecord({ group: G, writer: W, on: true, at: AT }))
  put(31, groupJoinRecord({ group: G, writer: W, on: false, at: AT }))
  put(32, groupJoinRecord({ group: K2, writer: W, on: true, at: AT }))
  put(40, groupConfirmRecord({ group: G, writer: W, seq: 3, digest: DIGEST, at: AT }))
  put(50, groupCutRecord({ group: G, writer: W, cut: 2, at: AT }))
  t.is(clonesOf(() => heldUsernames(entries, K1, setup.assocHex)), 2, 'heldUsernames: the 2 username records, not N')
  t.is(clonesOf(() => groupJoins(entries)), N + 3, 'groupJoins: N entries + 3 joins')
  t.is(clonesOf(() => groupJoinHistory(entries, G)), N + 3, 'groupJoinHistory: N entries + 3 joins')
  t.is(clonesOf(() => groupConfirmHistory(entries, G)), N + 1, 'groupConfirmHistory: N entries + 1 confirm')
  t.is(clonesOf(() => groupCutHistory(entries, G)), N + 1, 'groupCutHistory: N entries + 1 cut')
  t.is(clonesOf(() => diaryGroupKeys(entries)), 2 * (N + 3), 'diaryGroupKeys: two passes of N entries + 3 joins')
})
