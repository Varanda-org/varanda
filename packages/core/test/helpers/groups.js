'use strict'

// Fixtures for group and community folds (v2 headers): keys, times, and
// builders that keep cores as { key, diary, entries } with the diaries'
// group-join histories, the inputs buildGroup and buildCommunity take.

const {
  groupHeader, writerHeader, groupAdmin, groupLeave,
  groupCreateRecord, communityAdmit, communityBan, leaveDigest
} = require('../../lib/group')

const K = (n) => n.toString(16).padStart(64, '0')
const BASE = Date.parse('2026-01-01T00:00:00.000Z')
const AT = (s) => new Date(BASE + s * 1000).toISOString()
const NOW = BASE + 365 * 86400000

// Cores and joins shared by both builders: `root` is the root core's key.
function cores (root) {
  const logs = new Map()
  const joins = new Map()
  const bind = (diary, key, rejoin = null) => {
    const list = joins.get(diary) || []
    list.push({ writer: key, on: true, seq: list.length + 1, rejoin })
    joins.set(diary, list)
  }
  // The diary's off join for a writer, after its on join.
  const unbind = (diary, key) => {
    const list = joins.get(diary) || []
    list.push({ writer: key, on: false, seq: list.length + 1 })
    joins.set(diary, list)
  }
  return {
    logs,
    joins,
    bind,
    unbind,
    push (key, record) {
      const log = logs.get(key)
      const seq = log.entries.length
      log.entries.push({ seq, record })
      return { writer: key, seq }
    },
    len (key) {
      return logs.get(key).entries.length
    },
    writers ({ drop = [] } = {}) {
      return [...logs.values()].filter((l) => l.key !== root && !drop.includes(l.key))
    }
  }
}

// A community C with a creator (its root is the creator's CW), members
// [{ diary, cw, status }] each with one CW (status 'member', 'requested',
// 'left' or 'banned'; in an approval community 'member' is admitted from the
// root), root admin grants for `admins` (cuts on each admin's CW) and
// `creates` [{ by, group }] written in the root (only the creator creates
// groups). Records are timed after each other from AT(1) on.
function community ({ key = K(0xc0), creator, join = 'open', name = 'Bairro', members = [], admins = [], creates = [], bindRoot = true } = {}) {
  const c = cores(key)
  const cw = new Map([[creator, key]])
  const confirms = new Map()
  const confirmLeave = (diary, wkey, dseq) => {
    const entries = c.logs.get(wkey).entries
    let leave = null
    for (const e of entries) if (e.record && e.record.type === 'group-leave') leave = e
    if (leave !== null) {
      const list = confirms.get(diary) || []
      const e = { writer: wkey, seq: leave.seq, digest: leaveDigest(leave.record) }
      if (dseq !== undefined) e.dseq = dseq
      list.push(e)
      confirms.set(diary, list)
    }
    c.unbind(diary, wkey)
  }
  let t = 0
  const at = () => AT(++t)
  c.logs.set(key, { key, diary: creator, entries: [{ seq: 0, record: groupHeader({ kind: 'community', diary: creator, join, name, at: AT(0) }) }] })
  if (bindRoot) c.joins.set(creator, [{ writer: key, on: true, seq: 1 }])
  for (const m of members) {
    cw.set(m.diary, m.cw)
    c.logs.set(m.cw, { key: m.cw, diary: m.diary, entries: [{ seq: 0, record: writerHeader({ group: key, diary: m.diary, at: AT(0) }) }] })
    c.bind(m.diary, m.cw)
  }
  for (const m of members) {
    if (join === 'approval' && m.status === 'member') {
      c.push(key, communityAdmit({ member: m.diary, on: true, cuts: [{ writer: m.cw, seq: 1 }], at: at() }))
    }
  }
  for (const d of admins) c.push(key, groupAdmin({ member: d, on: true, cuts: [{ writer: cw.get(d), seq: 1 }], at: at() }))
  for (const m of members) {
    if (m.status === 'banned') c.push(key, communityBan({ member: m.diary, on: true, cuts: [{ writer: m.cw, seq: c.len(m.cw) }], at: at() }))
    // An honest leave: the leave plus the diary turning that CW off.
    if (m.status === 'left') {
      c.push(m.cw, groupLeave({ cuts: [{ writer: m.cw, seq: c.len(m.cw) }], at: at() }))
      confirmLeave(m.diary, m.cw)
    }
  }
  // Only the creator creates groups, in the root (`by` is kept for older
  // fixtures and must be the creator).
  for (const { group } of creates) c.push(key, groupCreateRecord({ group, at: at() }))
  const C = {
    key,
    creator,
    logs: c.logs,
    joins: c.joins,
    push: c.push,
    len: c.len,
    at,
    cwOf: (diary) => cw.get(diary),
    // An honest leave's diary side: a group-confirm naming the latest leave
    // on that writer (its seq and digest), and the off join. `dseq`, when
    // given, is the confirm's own seq in the diary.
    confirm: (diary, wkey, dseq) => confirmLeave(diary, wkey, dseq),
    // A diary's group-confirm as given (e.g. one naming a divergent copy).
    confirmRaw (diary, writer, seq, digest) {
      const list = confirms.get(diary) || []
      list.push({ writer, seq, digest })
      confirms.set(diary, list)
    },
    // A new CW for a diary (a second device, or a rejoin naming a leave).
    // An honest rejoin names its leave in the diary's join too; `joinRejoin`
    // overrides what the join names.
    addWriter (diary, wkey, { rejoin = null, joinRejoin = rejoin } = {}) {
      c.logs.set(wkey, { key: wkey, diary, entries: [{ seq: 0, record: writerHeader({ group: key, diary, rejoin, at: at() }) }] })
      c.bind(diary, wkey, joinRejoin)
      if (!cw.has(diary) || rejoin !== null) cw.set(diary, wkey)
      return wkey
    },
    rootHeaderFor (group, diary, opts = {}) {
      return groupHeader({ diary, community: key, member: cw.get(diary), name: 'Geral', at: AT(0), ...opts, kind: 'group' })
    },
    input ({ drop = [] } = {}) {
      return { root: c.logs.get(key), writers: c.writers({ drop }), joins: c.joins, confirms, now: NOW }
    }
  }
  return C
}

// A group G inside community C, created by `diary` (its root names C and
// the creator's CW). `add` gives a member diary a writer naming its CW in C.
function groupIn (C, { key = K(0x100), diary = C.creator, join = 'open', visibility = 'public', name = null, box = null, bindRoot = true } = {}) {
  const g = cores(key)
  const header = groupHeader({
    diary,
    community: C.key,
    member: C.cwOf(diary),
    visibility,
    join,
    name: visibility === 'private' ? null : name === null ? 'Varanda' : name,
    box,
    at: AT(0)
  })
  g.logs.set(key, { key, diary, entries: [{ seq: 0, record: header }] })
  if (bindRoot) g.joins.set(diary, [{ writer: key, on: true, seq: 1 }])
  const marks = new Map()
  const w = {
    key,
    logs: g.logs,
    joins: g.joins,
    push: g.push,
    len: g.len,
    add (member, wkey, { rejoin = null, at = AT(0), box: wbox = null, cw = C.cwOf(member) } = {}) {
      g.logs.set(wkey, { key: wkey, diary: member, entries: [{ seq: 0, record: writerHeader({ group: key, diary: member, member: cw, box: wbox, rejoin, at }) }] })
      g.bind(member, wkey)
      return w
    },
    // A diary's group-cut mark for this group (the diary vouches that its
    // writer's records at seq >= cut carry no authority). `seq` is the
    // mark's own seq in the diary.
    mark (diary, writer, cut, seq) {
      const list = marks.get(diary) || []
      list.push({ writer, cut, seq: seq === undefined ? list.length + 1 : seq })
      marks.set(diary, list)
      return w
    },
    input ({ drop = [], community = C.input() } = {}) {
      return { root: g.logs.get(key), writers: g.writers({ drop }), joins: g.joins, marks, community, now: NOW }
    }
  }
  return w
}

module.exports = { K, BASE, AT, NOW, community, groupIn }
