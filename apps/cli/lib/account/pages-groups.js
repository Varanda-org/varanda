'use strict'

// Pages in communities and groups (docs/protocol.md §12, "Páginas em
// comunidades"). The page diary is the member: every writer core a page
// holds names the page in its header and is bound by a group-join the
// service appends to the page diary through pages-writer.append. The page
// never creates, admits, bans, appoints, hides, edits or rekeys a group
// ('sem-permissao' is the only answer to those); an approval group keeps it
// 'requested' until the group's admins admit it.
//
// Writer cores: one random Ed25519 pair per writer, the secret in the page's
// page-keys row (`writers`, at most MAX_PAGE_WRITERS per page: 'limite'),
// each a standalone Hypercore 11 compat core under
// <dir>/pages-groups/<page>/writer-<hex> opened with the PUBLIC key only;
// the secret is set in memory for one append and cleared after. Private
// groups: one X25519 pair per page (groupBoxSecretKey, created lazily,
// never the DM box) is the box of every page writer header.
//
// The link: ONE WebSocket to the loopback seeder, a NoiseSecretStream with
// a persistent pair of its own, the admission channel in the member role
// with an EMPTY inventory and no announce, the seeder's hello verified
// before anything is replicated, then on the SAME protomux: the writer
// cores, the replica Corestore <dir>/pages-replicas (at most MAX_REPLICAS
// cores, the least recently used purged) and the groups channel that lists
// a group's writers. It reconnects with a 1 s .. 60 s backoff.
//
// The fold is buildCommunity / buildGroup over the root, the listed writers
// whose header names the group, the page's own writers and every binding
// diary that verifies under the association and the current revoked
// issuers, blocked keys left out (the shape of member.js readCoreParts).
//
// Nothing logged ever names a key or holds a secret.

const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const { WebSocket, createWebSocketStream } = require('ws')
const { writeJsonAtomic, appendRecord, readAll, readBlocks, openReplica, purgeReplica } = require('@varanda/core/lib/store')
const { refuseSymlinkDir, certForKey, seederCertForKey, isPlainObject } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { attachGroups, GROUPS_LIMIT_MAX } = require('@varanda/core/lib/groups-net')
const { generateNoiseKeyPair } = require('@varanda/core/lib/net')
const { groupJoinRecord, latestProfile, validateRecord, MAX_LOG_BLOCKS } = require('@varanda/core/lib/records')
const { latestUsername } = require('@varanda/core/lib/username')
const groups = require('@varanda/core/lib/group')
const groupCrypto = require('@varanda/core/lib/group-crypto')
const { MAX_PAGE_WRITERS } = require('./pages-store')
const { parseSeederWs } = require('./pages-writer')

const coreDir = path.dirname(require.resolve('@varanda/core/lib/seeder'))
const NoiseSecretStream = require(require.resolve('@hyperswarm/secret-stream', { paths: [coreDir] }))
const sodium = require(require.resolve('sodium-universal', { paths: [coreDir] }))

const GROUPS_DIR = 'pages-groups'
const REPLICAS_DIR = 'pages-replicas'
const NOISE_FILE = 'noise-key.json'
const MAX_REPLICAS = 1024
const MAX_WRITER_PAGES = Math.ceil(groups.MAX_GROUP_WRITERS / GROUPS_LIMIT_MAX)
const FETCH_TIMEOUT_MS = 10000
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 60000
const HANDSHAKE_TIMEOUT_MS = 10000
const HEX64_RE = /^[0-9a-f]{64}$/
const WRITER_RE = /^writer-([0-9a-f]{64})$/

function noop () {}

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function readFileNoFollow (file) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw fail('indisponivel')
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw fail('indisponivel')
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function timeout (promise, ms) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) })
  ]).finally(() => clearTimeout(timer))
}

// null when the revocation list cannot be read: no certificate is judged
// without it.
function toSet (value) {
  if (value === null || value === undefined) return new Set()
  try {
    const v = typeof value === 'function' ? value() : value
    if (v instanceof Set) return new Set(v)
    if (Array.isArray(v)) return new Set(v)
  } catch {}
  return null
}

function capOf (value, max) {
  return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, max) : max
}

// The groups named by the group-join records of a diary.
function joinedGroups (entries) {
  const out = new Set()
  for (const e of entries || []) {
    const r = e && e.record
    if (r !== null && typeof r === 'object' && r.type === 'group-join' && typeof r.group === 'string' && HEX64_RE.test(r.group)) out.add(r.group)
  }
  return out
}

// writerHex -> its latest join { group, on } in the diary.
function latestJoins (entries) {
  const out = new Map()
  for (const g of joinedGroups(entries)) {
    for (const j of groups.groupJoinHistory(entries, g)) {
      const prev = out.get(j.writer)
      if (prev === undefined || j.seq >= prev.seq) out.set(j.writer, { group: g, on: j.on, seq: j.seq })
    }
  }
  return out
}

function boxPublic (secretKey) {
  const publicKey = b4a.alloc(32)
  sodium.crypto_scalarmult_base(publicKey, secretKey)
  return publicKey
}

const refId = (r) => r.writer + ':' + r.seq
const isLeave = (e) => e.record !== null && typeof e.record === 'object' && e.record.type === 'group-leave'

// writer: a pages-writer; pagesStore: the page ACL; keys: page-keys;
// blocklist: { has(key) } or null; revokedIssuers: () => Set | Array.
// maxWritersPerGroup and maxGroups only lower the protocol caps (tests).
function createPagesGroups ({ dir, writer, pagesStore, keys, association, blocklist = null, revokedIssuers = null, seederWs = null, log = noop, guard = () => true, fetchTimeoutMs = FETCH_TIMEOUT_MS, maxReplicas = MAX_REPLICAS, maxWritersPerGroup = groups.MAX_GROUP_WRITERS_PER_DIARY, maxGroups = groups.MAX_GROUPS_PER_DIARY } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('dir must be a path')
  if (!writer || typeof writer.append !== 'function') throw new TypeError('writer must be a pages writer')
  if (!pagesStore || typeof pagesStore.setWriters !== 'function') throw new TypeError('pagesStore must be a pages store')
  if (!keys || typeof keys.get !== 'function') throw new TypeError('keys must be a page-keys table')
  if (typeof association !== 'string' || !HEX64_RE.test(association)) throw new TypeError('association must be 64 lowercase hex characters')
  if (typeof guard !== 'function') throw new TypeError('guard must be a function')
  const url = seederWs === null || seederWs === undefined ? null : parseSeederWs(seederWs)
  if (seederWs !== null && seederWs !== undefined && url === null) throw new TypeError('seederWs must be a loopback http or ws URL with a port')

  const writersCap = capOf(maxWritersPerGroup, groups.MAX_GROUP_WRITERS_PER_DIARY)
  const groupsCap = capOf(maxGroups, groups.MAX_GROUPS_PER_DIARY)

  refuseSymlinkDir(dir)
  const groupsDir = path.join(dir, GROUPS_DIR)
  const pages = new Map() // page -> { writers: Map writerHex -> core, chain }
  const replicas = new Map() // key -> { core, refs }, in use order
  const openingReplicas = new Map() // key -> pending open
  const purging = new Map() // key -> pending close and purge
  let store = null
  let conn = null
  let closed = false
  let failed = false
  let backoff = BACKOFF_MIN_MS
  let reconnectTimer = null
  let noisePair = null
  let groupsQueue = Promise.resolve()

  const opening = open()
  opening.catch(noop)

  return {
    ready: () => opening,
    communityJoin,
    communityLeave,
    groupJoin,
    groupLeave,
    groupPost,
    groupRead,
    leaveAll,
    refuse,
    groupBoxPublic,
    writersOf,
    connected: () => conn !== null && conn.ready,
    fail: () => { failed = true },
    close
  }

  function check () {
    let ok = false
    try {
      ok = !failed && guard() === true
    } catch {}
    if (!ok) throw fail('indisponivel')
  }

  function note (event, extra = {}) {
    try { log({ event: 'page-groups', ...extra, step: event }) } catch {}
  }

  function isBlocked (key) {
    try {
      return blocklist !== null && typeof blocklist.has === 'function' && blocklist.has(key) === true
    } catch {
      return true
    }
  }

  // Everything that would make the page act with authority it does not have.
  function refuse () {
    throw fail('sem-permissao')
  }

  async function open () {
    refuseSymlinkDir(groupsDir)
    fs.mkdirSync(groupsDir, { recursive: true, mode: 0o700 })
    store = new Corestore(path.join(dir, REPLICAS_DIR))
    await store.ready()
    if (url !== null && !closed) {
      noisePair = loadNoisePair()
      connect()
    }
  }

  function loadNoisePair () {
    const file = path.join(groupsDir, NOISE_FILE)
    const raw = readFileNoFollow(file)
    try {
      const data = raw === null ? null : JSON.parse(b4a.toString(raw, 'utf8'))
      if (isPlainObject(data) && HEX64_RE.test(data.publicKey) && /^[0-9a-f]{128}$/.test(data.secretKey)) {
        return { publicKey: b4a.from(data.publicKey, 'hex'), secretKey: b4a.from(data.secretKey, 'hex') }
      }
    } catch {}
    const kp = generateNoiseKeyPair()
    check()
    writeJsonAtomic(file, { publicKey: hex(kp.publicKey), secretKey: hex(kp.secretKey) }, 0o600)
    return kp
  }

  // ---- the page's writer cores ----------------------------------------

  function pageDir (page) {
    return path.join(groupsDir, page)
  }

  async function openWriterCore (page, writerHex) {
    const publicKey = b4a.from(writerHex, 'hex')
    const core = new Hypercore(path.join(pageDir(page), 'writer-' + writerHex), { keyPair: { publicKey }, compat: true, valueEncoding: 'json' })
    try {
      await core.ready()
      if (!b4a.equals(core.key, publicKey)) throw new Error('núcleo de outra chave')
    } catch (err) {
      await core.close().catch(noop)
      throw err
    }
    return core
  }

  async function pageState (page) {
    let p = pages.get(page)
    if (p !== undefined) return p
    p = { writers: new Map(), chain: Promise.resolve() }
    pages.set(page, p)
    const row = keys.get(page)
    const own = row && row.writers ? Object.keys(row.writers) : []
    zero(row)
    let names = []
    try {
      refuseSymlinkDir(pageDir(page))
      names = fs.readdirSync(pageDir(page))
    } catch {}
    for (const name of names) {
      const m = WRITER_RE.exec(name)
      if (m === null || !own.includes(m[1])) continue
      try {
        const core = await openWriterCore(page, m[1])
        p.writers.set(m[1], core)
        if (conn !== null && conn.ready) core.replicate(conn.noise)
      } catch {
        note('writer-open-failed')
      }
    }
    // A service that restarted knows every membership from the ACL rows
    // before any operation runs (a leave or a key move must see them all).
    knownStates(page, p)
    return p
  }

  function zero (row) {
    if (!row) return
    for (const k of ['secretKey', 'mediaSecretKey', 'boxSecretKey', 'groupBoxSecretKey']) if (row[k]) row[k].fill(0)
    if (row.writers) for (const w of Object.keys(row.writers)) row.writers[w].fill(0)
  }

  // Runs fn on the page's chain, the page live, unpaused and keyed.
  async function withPage (page, fn) {
    await opening
    if (closed) throw fail('fechado')
    check()
    if (typeof page !== 'string' || !HEX64_RE.test(page)) throw fail('nao-encontrada')
    const p = await pageState(page)
    const run = async () => {
      if (closed) throw fail('fechado')
      check()
      const acl = pagesStore.get(page)
      if (acl === null) throw fail('nao-encontrada')
      if (acl.closed) throw fail('encerrada')
      if (acl.paused || writer.info(page).paused) throw fail('pausada')
      if (keys.get(page) === null) throw fail('chave-ausente')
      return fn(p)
    }
    const next = p.chain.then(run, run)
    p.chain = next.catch(noop)
    return next
  }

  // The page's X25519 group box, created on first use and kept in its row.
  function groupBox (page) {
    const row = keys.get(page)
    if (row === null) throw fail('chave-ausente')
    try {
      if (!row.groupBoxSecretKey) {
        let kp = null
        for (let i = 0; i < 4 && kp === null; i++) {
          const next = groupCrypto.newBoxKeyPair()
          if (groups.isWeakBoxKey(hex(next.publicKey))) groupCrypto.wipe(next.secretKey)
          else kp = next
        }
        if (kp === null) throw fail('indisponivel')
        check()
        keys.put(page, { ...row, groupBoxSecretKey: kp.secretKey })
        groupCrypto.wipe(kp.secretKey)
        return groupBox(page)
      }
      const secretKey = b4a.from(row.groupBoxSecretKey)
      const publicKey = boxPublic(secretKey)
      if (groups.isWeakBoxKey(hex(publicKey))) {
        groupCrypto.wipe(secretKey)
        throw fail('indisponivel')
      }
      return { publicKey, secretKey }
    } finally {
      zero(row)
    }
  }

  function groupBoxPublic (page) {
    const box = groupBox(page)
    groupCrypto.wipe(box.secretKey)
    return hex(box.publicKey)
  }

  // A new writer pair filed in the page's row, then its core. The secrets
  // of writers that left (latest join off) or never joined are pruned
  // first; a writer whose latest join is on is always kept.
  async function newWriter (p, page) {
    await pruneWriters(p, page)
    const row = keys.get(page)
    if (row === null) throw fail('chave-ausente')
    let kp = null
    try {
      const writers = row.writers || {}
      if (Object.keys(writers).length >= MAX_PAGE_WRITERS) throw fail('limite')
      kp = hcrypto.keyPair()
      const writerHex = hex(kp.publicKey)
      check()
      keys.put(page, { ...row, writers: { ...writers, [writerHex]: kp.secretKey } })
      try {
        refuseSymlinkDir(groupsDir)
        fs.mkdirSync(pageDir(page), { recursive: true, mode: 0o700 })
        const core = await openWriterCore(page, writerHex)
        p.writers.set(writerHex, core)
        if (conn !== null && conn.ready) core.replicate(conn.noise)
        return core
      } catch (err) {
        await dropWriter(p, page, writerHex)
        throw err
      }
    } finally {
      if (kp !== null) kp.secretKey.fill(0)
      zero(row)
    }
  }

  // Writes the header and the diary join of a new writer; on a failure the
  // writer is dropped unless the diary holds its join on (an append whose
  // outcome was unknown may have landed).
  async function bindWriter (p, page, core, group, header, opts, rejoin) {
    const w = hex(core.key)
    try {
      await appendOn(page, core, group, header, opts)
      await diaryJoin(page, group, w, true, rejoin)
    } catch (err) {
      let on = false
      try {
        const last = latestJoins(await writer.readEntries(page)).get(w)
        on = last !== undefined && last.on === true
      } catch {
        on = true
      }
      if (!on) await dropWriter(p, page, w).catch(noop)
      throw err
    }
  }

  // The secret out of the page's row, the local core closed and removed.
  async function dropWriter (p, page, writerHex) {
    const row = keys.get(page)
    try {
      if (row !== null && row.writers && row.writers[writerHex]) {
        const writers = {}
        for (const w of Object.keys(row.writers)) if (w !== writerHex) writers[w] = row.writers[w]
        keys.put(page, { ...row, writers })
      }
    } finally {
      zero(row)
    }
    const core = p.writers.get(writerHex)
    p.writers.delete(writerHex)
    setState(p, writerHex, null)
    if (core !== undefined) await core.close().catch(noop)
    try {
      fs.rmSync(path.join(pageDir(page), 'writer-' + writerHex), { recursive: true, force: true })
    } catch {}
  }

  // Secrets of writers that left or never joined. A left writer's core stays
  // open so the fold still sees its leave; after a restart the seeder lists it.
  async function pruneWriters (p, page) {
    const row = keys.get(page)
    if (row === null) return
    const own = row.writers ? Object.keys(row.writers) : []
    zero(row)
    if (own.length === 0) return
    const last = latestJoins(await writer.readEntries(page))
    const gone = own.filter((w) => {
      const j = last.get(w)
      return j === undefined || j.on !== true
    })
    if (gone.length === 0) return
    const fresh = keys.get(page)
    if (fresh === null) return
    try {
      const writers = {}
      for (const w of Object.keys(fresh.writers || {})) if (!gone.includes(w)) writers[w] = fresh.writers[w]
      check()
      keys.put(page, { ...fresh, writers })
    } finally {
      zero(fresh)
    }
    for (const w of gone) {
      const j = last.get(w)
      setState(p, w, null)
      if (j !== undefined) continue
      const core = p.writers.get(w)
      p.writers.delete(w)
      if (core !== undefined) await core.close().catch(noop)
      try {
        fs.rmSync(path.join(pageDir(page), 'writer-' + w), { recursive: true, force: true })
      } catch {}
    }
  }

  // One record on a page writer, the secret set for this append only.
  async function appendOn (page, core, group, record, { priv = false, community = false } = {}) {
    const row = keys.get(page)
    const writerHex = hex(core.key)
    const secret = row && row.writers ? row.writers[writerHex] : undefined
    if (!secret) {
      zero(row)
      throw fail('chave-ausente')
    }
    let copy = null
    try {
      check()
      copy = b4a.from(secret)
      zero(row)
      core.setKeyPair({ publicKey: core.key, secretKey: copy })
      return await appendRecord(core, record, { validator: (r, seq) => groups.validateGroupRecord(r, seq, { root: false, private: priv, community }) })
    } catch (err) {
      throw err.code === 'INVALID_RECORD' ? fail('invalido') : err
    } finally {
      zero(row)
      core.setKeyPair({ publicKey: core.key, secretKey: null })
      if (copy !== null) copy.fill(0)
    }
  }

  async function diaryJoin (page, group, writerHex, on, rejoin = null) {
    const record = groupJoinRecord({ group, writer: writerHex, on, ...(rejoin ? { rejoin } : {}) })
    await writer.append(page, [record])
  }

  async function syncWriters (page) {
    const p = pages.get(page)
    const rows = []
    for (const [w, core] of p.writers) {
      const st = p.state && p.state.get(w)
      if (st === undefined || core.length === 0) continue
      rows.push({ group: st.group, writer: w, kind: st.kind, state: st.state })
    }
    await pagesStore.setWriters(page, rows)
  }

  function setState (p, writerHex, value) {
    if (!p.state) p.state = new Map()
    if (value === null) p.state.delete(writerHex)
    else p.state.set(writerHex, value)
  }

  // ---- replicas -------------------------------------------------------

  // A replica held by the caller until release(key): opened once per key
  // (concurrent callers share the open), never evicted while held.
  async function hold (key) {
    for (;;) {
      if (closed) throw fail('fechado')
      const entry = replicas.get(key)
      if (entry !== undefined) {
        replicas.delete(key)
        replicas.set(key, entry)
        entry.refs++
        return entry.core
      }
      const pending = openingReplicas.get(key) || purging.get(key)
      if (pending !== undefined) {
        await pending.catch(noop)
        continue
      }
      const opened = openReplica(store, key).then((core) => {
        replicas.set(key, { core, refs: 0 })
      }).finally(() => openingReplicas.delete(key))
      openingReplicas.set(key, opened)
      await opened
    }
  }

  function release (key) {
    const entry = replicas.get(key)
    if (entry !== undefined && entry.refs > 0) entry.refs--
    evict()
  }

  // The least recently used replicas nobody holds, past the cap.
  function evict () {
    const cap = Math.min(maxReplicas, MAX_REPLICAS)
    for (const [key, entry] of [...replicas]) {
      if (replicas.size <= cap) break
      if (entry.refs > 0) continue
      replicas.delete(key)
      const done = entry.core.close().catch(noop)
        .then(() => purgeReplica(store, key)).catch(noop)
        .finally(() => purging.delete(key))
      purging.set(key, done)
    }
  }

  // The core at the length the seeder offers, held (release it), or null
  // when nothing arrived in time. `complete` is false while a block up to
  // min(length, MAX_LOG_BLOCKS) is missing.
  async function fetch (key, held) {
    const core = await hold(key)
    held.push(key)
    await timeout(core.update({ wait: true }).catch(noop), fetchTimeoutMs)
    if (core.length === 0) return null
    const end = Math.min(core.length, MAX_LOG_BLOCKS)
    await timeout(core.download({ start: 0, end }).done().catch(noop), fetchTimeoutMs)
    if (core.contiguousLength === 0) return null
    return { core, complete: core.contiguousLength >= end }
  }

  function localWriter (key) {
    for (const q of pages.values()) {
      const core = q.writers.get(key)
      if (core !== undefined && core.length > 0) return { core, complete: core.contiguousLength >= Math.min(core.length, MAX_LOG_BLOCKS) }
    }
    return null
  }

  // The group's writers the seeder lists, and whether the listing is whole.
  function listWriters (group) {
    const run = async () => {
      const items = new Map()
      if (conn === null || !conn.ready || conn.groups === null) return { items, complete: false }
      let after = null
      let complete = false
      for (let n = 0; n < MAX_WRITER_PAGES; n++) {
        let page
        try {
          page = await conn.groups.requestWriters({ group, after, limit: GROUPS_LIMIT_MAX })
        } catch {
          if (conn !== null) conn.finish()
          break
        }
        for (const it of page.items) if (!items.has(it.key)) items.set(it.key, it)
        if (page.incomplete) break
        if (page.next === null) {
          complete = true
          break
        }
        if (after !== null && page.next <= after) break
        after = page.next
      }
      return { items, complete }
    }
    const next = groupsQueue.then(run, run)
    groupsQueue = next.catch(noop)
    return next
  }

  // ---- the fold -------------------------------------------------------

  // member.js readCoreParts for root `key` of `kind`, the page diary read
  // from the writer and the page's own writers from their cores.
  async function parts (page, p, key, kind) {
    if (isBlocked(key)) throw fail('nao-encontrada')
    const held = []
    try {
      return await partsHeld(page, p, key, kind, held)
    } finally {
      for (const k of held) release(k)
    }
  }

  async function partsHeld (page, p, key, kind, held) {
    const revoked = toSet(revokedIssuers)
    if (revoked === null) throw fail('indisponivel')
    const rootFetched = await fetch(key, held)
    if (rootFetched === null) throw fail('indisponivel')
    const rootCore = rootFetched.core
    let incomplete = !rootFetched.complete
    const rootEntries = await readBlocks(rootCore)
    const header = rootEntries[0] && rootEntries[0].record
    if (rootCore.fork !== 0 || groups.validateGroupHeader(header) !== null || header.kind !== kind) throw fail('nao-encontrada')
    const logs = [{ key, diary: header.diary, entries: rootEntries, length: rootCore.contiguousLength, signed: rootCore.length }]
    const seen = new Set([key])
    for (const [w, core] of p.writers) {
      if (core.length === 0) continue
      const entries = await readBlocks(core)
      const h = entries[0] && entries[0].record
      if (groups.validateWriterHeader(h) !== null || h.group !== key || h.diary !== page) continue
      seen.add(w)
      logs.push({ key: w, diary: page, entries, length: core.contiguousLength, signed: core.length })
    }
    const listed = await listWriters(key)
    if (!listed.complete) incomplete = true
    // A page writer whose secret was pruned is read like any listed writer.
    for (const it of listed.items.values()) {
      if (seen.has(it.key) || p.writers.has(it.key) || isBlocked(it.key) || isBlocked(it.diary)) continue
      seen.add(it.key)
      // Another hosted page's writer already replicates on this stream: a
      // replica of the same key would never get a channel, so read it here.
      let got = localWriter(it.key)
      try {
        if (got === null) got = await fetch(it.key, held)
      } catch {
        incomplete = true
        continue
      }
      if (got === null) {
        incomplete = true
        continue
      }
      if (!got.complete) incomplete = true
      const core = got.core
      if (core.fork !== 0) continue
      const entries = await readBlocks(core)
      const h = entries[0] && entries[0].record
      if (groups.validateWriterHeader(h) !== null || h.group !== key) continue
      logs.push({ key: it.key, diary: h.diary, entries, length: core.contiguousLength, signed: core.length })
    }
    const profiles = new Map()
    const joins = new Map()
    const marks = new Map()
    const confirms = new Map()
    const diaryEntries = new Map()
    for (const d of new Set([page, ...logs.map((l) => l.diary)])) {
      if (isBlocked(d)) continue
      let entries
      if (d === page) {
        entries = await writer.readEntries(page)
      } else {
        let got
        try {
          got = await fetch(d, held)
        } catch {
          incomplete = true
          continue
        }
        if (got === null) {
          incomplete = true
          continue
        }
        if (!got.complete) incomplete = true
        const core = got.core
        if (core.fork !== 0) continue
        entries = await readAll(core)
        const first = entries[0] && entries[0].record
        if (validateRecord(first, 0) !== null || !certForKey(first.cert, d, association, { revokedIssuers: revoked }).ok) continue
      }
      diaryEntries.set(d, entries)
      joins.set(d, groups.groupJoinHistory(entries, key))
      marks.set(d, groups.groupCutHistory(entries, key))
      confirms.set(d, groups.groupConfirmHistory(entries, key))
      const profile = latestProfile(entries)
      profiles.set(d, {
        name: profile === null ? null : profile.name,
        username: latestUsername(entries, d, association, { revokedIssuers: revoked })
      })
    }
    const accepted = logs.filter((l) => diaryEntries.has(l.diary))
    const root = { key, entries: diaryEntries.has(header.diary) ? rootEntries : rootEntries.slice(0, 1) }
    const writers = accepted.filter((l) => l.key !== key)
    const bound = accepted.filter((l) => (joins.get(l.diary) || []).some((j) => j.writer === l.key && j.on))
    return { header, input: { root, writers, joins, marks, confirms }, bound, profiles, diaryEntries, incomplete }
  }

  // The page's live writer in the folded root: bound, no leave in its log,
  // its diary join still on.
  function liveOwn (page, loaded) {
    const joins = loaded.input.joins.get(page) || []
    for (const l of loaded.bound) {
      if (l.diary !== page || l.key === loaded.group || l.entries.some(isLeave)) continue
      const last = joins.filter((j) => j.writer === l.key).pop()
      if (last && last.on) return l.key
    }
    return null
  }

  async function loadCommunity (page, p, C) {
    const c = await parts(page, p, C, 'community')
    const view = groups.buildCommunity(c.input)
    return { group: C, community: true, ...c, view, private: false, held: null, partial: c.incomplete || view.incomplete === true }
  }

  async function loadGroup (page, p, G, { secrets = false } = {}) {
    const g = await parts(page, p, G, 'group')
    let cparts = null
    try {
      cparts = await parts(page, p, g.header.community, 'community')
    } catch {}
    const input = { ...g.input, community: cparts === null ? null : cparts.input }
    const priv = g.header.visibility === 'private'
    let view
    let held = null
    if (priv) {
      const box = groupBox(page)
      const pk = hex(box.publicKey)
      const mine = new Set()
      for (const l of g.input.writers) {
        const h = l.entries[0] && l.entries[0].record
        if (l.diary === page && h && h.box === pk) mine.add(l.key)
      }
      const kept = new Map()
      const keysOpt = {
        writers: mine,
        unseal: (sealed) => groupCrypto.openFrom(b4a.from(sealed, 'base64'), box)
      }
      if (secrets) {
        keysOpt.onKey = (kid, key) => {
          const id = refId(kid)
          if (kept.has(id)) return groupCrypto.wipe(key)
          kept.set(id, key)
        }
      }
      try {
        view = groups.buildGroup({ ...input, keys: keysOpt })
      } finally {
        groupCrypto.wipe(box.secretKey)
      }
      if (secrets) held = kept
    } else {
      view = groups.buildGroup(input)
    }
    const cw = cparts === null ? null : liveOwn(page, { group: g.header.community, ...cparts })
    const partial = g.incomplete || cparts === null || cparts.incomplete || view.incomplete === true
    return { group: G, ...g, view, private: priv, held, cw, partial }
  }

  function wipeHeld (loaded) {
    if (!loaded || !loaded.held) return
    for (const key of loaded.held.values()) groupCrypto.wipe(key)
    loaded.held = null
  }

  function rejoinOf (view, page) {
    const r = view.lastLeave instanceof Map ? view.lastLeave.get(page) : undefined
    return r ? { writer: r.writer, seq: r.seq } : null
  }

  // The fold's state of the page; a diary not folded yet is 'requested'.
  function stateOf (view, page, w) {
    const s = view.members.get(page)
    if (s === 'banned') throw fail('sem-permissao')
    if (s === 'requested' || s === 'left') return s
    if (s === 'member' && view.writers.has(w)) return 'member'
    if (s === 'member') throw fail('limite')
    return 'requested'
  }

  // The ACL row of a writer whose join is on: 'left' is kept as 'requested'
  // (the join still binds it, so a leave must still see it).
  function rowState (state) {
    return state === 'member' ? 'member' : 'requested'
  }

  // Before a new writer for `group`: at most writersCap writers ever bound
  // by the page diary in it (the fold keeps the earliest), at most groupsCap
  // groups and communities with a live join.
  function roomFor (loaded, page, group) {
    const bound = new Set((loaded.input.joins.get(page) || []).filter((j) => j.on).map((j) => j.writer))
    if (bound.size >= writersCap) throw fail('limite')
    const entries = loaded.diaryEntries.get(page) || []
    let live = 0
    for (const g of joinedGroups(entries)) {
      if (g === group) continue
      const last = new Map()
      for (const j of groups.groupJoinHistory(entries, g)) last.set(j.writer, j.on)
      if ([...last.values()].includes(true)) live++
    }
    if (live >= groupsCap) throw fail('limite')
  }

  // ---- API ------------------------------------------------------------

  function needKey (k) {
    if (typeof k !== 'string' || !HEX64_RE.test(k)) throw fail('invalido')
  }

  async function communityJoin (page, C) {
    needKey(C)
    return withPage(page, async (p) => {
      let c = await loadCommunity(page, p, C)
      if (c.view.bans.has(page)) throw fail('sem-permissao')
      if (c.partial) throw fail('indisponivel')
      let w = liveOwn(page, c)
      if (w === null) {
        roomFor(c, page, C)
        const rejoin = rejoinOf(c.view, page)
        const core = await newWriter(p, page)
        w = hex(core.key)
        await bindWriter(p, page, core, C, groups.writerHeader({ group: C, diary: page, member: null, rejoin }), { community: true }, rejoin)
        c = await loadCommunity(page, p, C)
      }
      const state = stateOf(c.view, page, w)
      setState(p, w, { group: C, kind: 'community', state: rowState(state) })
      await syncWriters(page)
      let general = null
      if (state === 'member' && c.view.general !== null) {
        try {
          await joinGroupNow(page, p, c.view.general)
          general = c.view.general
        } catch (err) {
          note('geral-failed', { reason: err.code || 'erro' })
        }
      }
      return { state, group: general }
    })
  }

  async function joinGroupNow (page, p, G) {
    const loaded = await loadGroup(page, p, G)
    if (loaded.view.bans.has(page)) throw fail('sem-permissao')
    if (loaded.view.community === null || loaded.view.orphan) throw fail('indisponivel')
    if (loaded.cw === null) throw fail('fora-da-comunidade')
    if (loaded.partial) throw fail('indisponivel')
    let w = liveOwn(page, loaded)
    let view = loaded.view
    if (w === null) {
      roomFor(loaded, page, G)
      const rejoin = rejoinOf(loaded.view, page)
      const box = loaded.private ? groupBoxPublic(page) : null
      const core = await newWriter(p, page)
      w = hex(core.key)
      await bindWriter(p, page, core, G, groups.writerHeader({ group: G, diary: page, member: loaded.cw, rejoin, box }), { priv: loaded.private }, null)
      view = (await loadGroup(page, p, G)).view
    }
    const state = stateOf(view, page, w)
    setState(p, w, { group: G, kind: 'group', state: rowState(state) })
    await syncWriters(page)
    return { state }
  }

  async function groupJoin (page, G) {
    needKey(G)
    return withPage(page, (p) => joinGroupNow(page, p, G))
  }

  // A leave on the page's live writer, cuts over every counted page writer,
  // then the diary join off.
  async function leaveNow (page, p, loaded) {
    const w = liveOwn(page, loaded)
    if (w === null) return { state: 'left' }
    const cuts = loaded.bound.filter((l) => l.diary === page && loaded.view.writers.has(l.key))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((l) => ({ writer: l.key, seq: l.length }))
    const core = p.writers.get(w)
    if (core === undefined) throw fail('chave-ausente')
    await appendOn(page, core, loaded.group, groups.groupLeave({ seen: loaded.view.last, cuts }), { priv: loaded.private, community: loaded.community === true })
    await diaryJoin(page, loaded.group, w, false)
    setState(p, w, null)
    await syncWriters(page)
    return { state: 'left' }
  }

  async function groupLeave (page, G) {
    needKey(G)
    return withPage(page, async (p) => leaveNow(page, p, await loadGroup(page, p, G)))
  }

  // Every group of C the page is in, then C.
  async function communityLeave (page, C) {
    needKey(C)
    return withPage(page, (p) => leaveCommunityNow(page, p, C))
  }

  async function leaveCommunityNow (page, p, C) {
    for (const [w, st] of [...(p.state || new Map())]) {
      if (st.kind !== 'group' || !p.writers.has(w)) continue
      try {
        const loaded = await loadGroup(page, p, st.group)
        if (loaded.header.community === C) await leaveNow(page, p, loaded)
      } catch (err) {
        note('leave-failed', { reason: err.code || 'erro' })
      }
    }
    return leaveNow(page, p, await loadCommunity(page, p, C))
  }

  // For a closing or moving page: every group, then every community.
  async function leaveAll (page) {
    return withPage(page, async (p) => {
      knownStates(page, p)
      const communities = new Set()
      for (const st of (p.state || new Map()).values()) if (st.kind === 'community') communities.add(st.group)
      let failures = 0
      const left = []
      for (const C of communities) {
        try {
          await leaveCommunityNow(page, p, C)
          left.push(C)
        } catch {
          failures++
        }
      }
      return { left: left.length, failures, communities: left.sort() }
    })
  }

  // The rows the ACL holds, for a service that restarted.
  function knownStates (page, p) {
    const acl = pagesStore.get(page)
    for (const r of (acl && acl.writers) || []) {
      if (p.writers.has(r.writer) && !(p.state && p.state.has(r.writer))) setState(p, r.writer, { group: r.group, kind: r.kind, state: r.state })
    }
  }

  async function groupPost (page, G, { text, replyTo = null } = {}) {
    needKey(G)
    return withPage(page, async (p) => {
      const loaded = await loadGroup(page, p, G, { secrets: true })
      try {
        if (loaded.view.community === null || loaded.view.orphan || loaded.partial) throw fail('indisponivel')
        const w = liveOwn(page, loaded)
        if (w === null || loaded.view.members.get(page) !== 'member') throw fail('sem-permissao')
        if (!loaded.view.writers.has(w)) throw fail('limite')
        let record
        try {
          record = groups.groupPost({ text, replyTo, seen: loaded.view.last })
        } catch {
          throw fail('invalido')
        }
        if (loaded.private) {
          const key = loaded.view.epoch === null ? undefined : loaded.held.get(refId(loaded.view.epoch))
          if (loaded.view.rekeyPending || key === undefined) throw fail('aguardando-chave')
          let sealed
          try {
            sealed = groupCrypto.sealRecord(groups.sealedInner(record, { writer: w, group: G, kid: loaded.view.epoch }), key)
          } catch {
            throw fail('invalido')
          }
          record = groups.groupSealed({ kid: loaded.view.epoch, nonce: sealed.nonce, box: sealed.box, at: record.at })
        }
        const seq = await appendOn(page, p.writers.get(w), G, record, { priv: loaded.private })
        return { seq }
      } finally {
        wipeHeld(loaded)
      }
    })
  }

  // rpc.md 5.40's shape; plaintext of a private group the page is in.
  async function groupRead (page, G, { before = null, limit = 30 } = {}) {
    needKey(G)
    const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 30
    return withPage(page, async (p) => {
      const loaded = await loadGroup(page, p, G)
      let posts = loaded.view.posts.filter((x) => loaded.profiles.has(x.diary))
      if (before !== null && before !== undefined) {
        const i = posts.findIndex((x) => x.writer === before.writer && x.seq === before.seq)
        if (i >= 0) posts = posts.slice(0, i)
        else {
          const k = groups.orderKey(before.at, before.writer, before.seq)
          posts = posts.filter((x) => groups.compareOrder(groups.orderKey(x.at, x.writer, x.seq), k) < 0)
        }
      }
      const start = Math.max(0, posts.length - n)
      const items = posts.slice(start).reverse().map((x) => ({
        ...x,
        text: x.hidden ? '' : x.text,
        media: x.hidden || !x.media ? null : x.media.map((media) => ({ ...media })),
        ...loaded.profiles.get(x.diary)
      }))
      const last = items[items.length - 1]
      const v = loaded.view
      return {
        items,
        next: start > 0 && last ? { at: last.at, writer: last.writer, seq: last.seq } : null,
        hidden: items.filter((x) => x.hidden).length,
        incomplete: v.incomplete || loaded.partial,
        sealed: v.sealed || 0,
        epoch: v.epoch ? { writer: v.epoch.writer, seq: v.epoch.seq } : null,
        state: v.rekeyPending ? 'rekey-pending' : 'ok',
        role: v.members.get(page) || 'left'
      }
    })
  }

  // The page's writer rows as the ACL keeps them.
  function writersOf (page) {
    const acl = pagesStore.get(page)
    return acl === null ? [] : acl.writers
  }

  async function close () {
    if (closed) return
    closed = true
    await opening.catch(noop)
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    if (conn !== null) conn.finish()
    for (const p of pages.values()) {
      await p.chain
      for (const core of p.writers.values()) await core.close().catch(noop)
    }
    pages.clear()
    await Promise.all([...openingReplicas.values()].map((x) => x.catch(noop)))
    for (const entry of replicas.values()) await entry.core.close().catch(noop)
    replicas.clear()
    await Promise.all([...purging.values()])
    if (store !== null) await store.close().catch(noop)
    if (noisePair) noisePair.secretKey.fill(0)
  }

  // ---- link -----------------------------------------------------------

  function scheduleReconnect () {
    if (closed || url === null || reconnectTimer !== null) return
    const delay = backoff
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
    if (reconnectTimer.unref) reconnectTimer.unref()
  }

  function connect () {
    if (closed) return
    const c = { ws: null, duplex: null, noise: null, groups: null, ready: false, done: false, finish }
    conn = c
    function finish () {
      if (c.done) return
      c.done = true
      if (conn === c) conn = null
      if (c.ready) note('link', { state: 'down' })
      try { if (c.noise) c.noise.destroy() } catch {}
      try { if (c.duplex) c.duplex.destroy() } catch {}
      try { c.ws.terminate() } catch {}
      scheduleReconnect()
    }
    try {
      c.ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
      c.ws.on('error', finish)
      c.ws.once('close', finish)
      c.duplex = createWebSocketStream(c.ws)
      c.duplex.on('error', finish)
      c.noise = new NoiseSecretStream(true, c.duplex, { keyPair: noisePair })
      c.noise.on('error', finish)
      c.noise.once('close', finish)
    } catch {
      finish()
      return
    }
    c.noise.once('connect', () => {
      if (c.done) return
      try {
        Hypercore.createProtocolStream(c.noise, { keepAlive: true })
        attachAdmission(c.noise, { role: 'member', have: [], onclose: finish, onmessage })
      } catch {
        finish()
      }
    })

    function onmessage (msg) {
      if (c.done || c.ready || msg.type !== 'hello') return
      const verdict = msg.role === 'seeder' ? seederCertForKey(msg.cert, hex(c.noise.remotePublicKey), association) : null
      if (!verdict || verdict.ok !== true) return finish()
      try {
        // One protomux: the store and the writer cores replicate on it
        // first, then the groups channel pairs on the same muxer.
        store.replicate(c.noise)
        for (const p of pages.values()) for (const core of p.writers.values()) core.replicate(c.noise)
        c.groups = attachGroups(c.noise, { role: 'member' })
      } catch {
        return finish()
      }
      c.ready = true
      backoff = BACKOFF_MIN_MS
      note('link', { state: 'up' })
    }
  }
}

module.exports = { createPagesGroups, GROUPS_DIR, REPLICAS_DIR, MAX_REPLICAS }
