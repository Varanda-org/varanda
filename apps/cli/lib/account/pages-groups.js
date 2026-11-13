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
// groups: the box of every page writer header is the page's group box
// public key from its ACL row (dm.groupBox), whose secret only the devices
// of the owner and admins hold. The service folds a private group without
// keys: it never reads a sealed post or a media key, and a post there is a
// sealed envelope the device built ('group-seal'). A page with no dm.groupBox
// joins no private group ('sem-caixa'). When the group box rotates, every
// private membership moves to a new writer boxed to the new key
// ('group-rebox'), and the legacy service-held groupBoxSecretKey of a page
// from before is deleted.
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
const { keyTag, keyCommit, wipe } = require('@varanda/core/lib/group-crypto')
const { MAX_PAGE_WRITERS } = require('./pages-store')
const { parseSeederWs } = require('./pages-writer')

const coreDir = path.dirname(require.resolve('@varanda/core/lib/seeder'))
const NoiseSecretStream = require(require.resolve('@hyperswarm/secret-stream', { paths: [coreDir] }))

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
const REBOX_FILE = 'rebox.json'

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
  const pageOpening = new Map() // page -> pending openPageState
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
    groupSeal,
    groupRebox,
    reboxNeeded,
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
    await dropLegacyGroupBoxes()
    if (url !== null && !closed) {
      noisePair = loadNoisePair()
      connect()
    }
  }

  // The service-held group box of pages from before it moved to devices:
  // nothing reads it any more (a private membership boxed to it moves only
  // through 'group-rebox' to the device-held box), so every start deletes it.
  async function dropLegacyGroupBoxes () {
    if (typeof writer.ready === 'function') await writer.ready().catch(noop)
    if (typeof writer.pageKeys !== 'function') return
    for (const page of writer.pageKeys()) {
      const row = keys.get(page)
      try {
        if (row === null || !row.groupBoxSecretKey) continue
        const next = { ...row }
        delete next.groupBoxSecretKey
        check()
        keys.put(page, next)
      } catch {
        note('legacy-box-failed')
      } finally {
        zero(row)
      }
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

  // A page's state is cached only once its writer cores are open: callers
  // that arrive meanwhile share the same opening.
  function pageState (page) {
    const p = pages.get(page)
    if (p !== undefined) return Promise.resolve(p)
    let pending = pageOpening.get(page)
    if (pending === undefined) {
      pending = openPageState(page).finally(() => pageOpening.delete(page))
      pageOpening.set(page, pending)
    }
    return pending
  }

  async function openPageState (page) {
    const p = { writers: new Map(), chain: Promise.resolve() }
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
    if (closed) {
      for (const core of p.writers.values()) await core.close().catch(noop)
      throw fail('fechado')
    }
    pages.set(page, p)
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

  // The page's dm row in the ACL, or null before its Conversas keys moved
  // to devices.
  function dmOf (page) {
    const acl = pagesStore.get(page)
    return acl !== null && isPlainObject(acl.dm) ? acl.dm : null
  }

  // The page's group box public key (hex) from its ACL row: the devices hold
  // its secret, the service never does.
  function groupBoxPublic (page) {
    const d = dmOf(page)
    const box = d === null ? null : d.groupBox
    if (typeof box !== 'string' || !HEX64_RE.test(box) || groups.isWeakBoxKey(box)) throw fail('sem-caixa')
    return box
  }

  // While a group box rotation is pending, nothing runs in a private group
  // but the rotation itself.
  function gate (page, loaded) {
    if (!loaded.private) return
    const d = dmOf(page)
    if (d !== null && d.reboxPending === true) throw fail('aguardando-chave')
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

  // A private group folds without keys (no box secret, no onKey), so the view
  // holds no plaintext of a sealed record and `sealed` counts them.
  async function loadGroup (page, p, G) {
    const g = await parts(page, p, G, 'group')
    let cparts = null
    try {
      cparts = await parts(page, p, g.header.community, 'community')
    } catch {}
    const input = { ...g.input, community: cparts === null ? null : cparts.input }
    const priv = g.header.visibility === 'private'
    const view = groups.buildGroup(input)
    const cw = cparts === null ? null : liveOwn(page, { group: g.header.community, ...cparts })
    const partial = g.incomplete || cparts === null || cparts.incomplete || view.incomplete === true
    return { group: G, ...g, foldInput: input, view, private: priv, cw, partial }
  }

  // The box a writer's header names, or null.
  function headerBox (loaded, w) {
    const l = loaded.input.writers.find((x) => x.key === w)
    const h = l && l.entries[0] && l.entries[0].record
    return h && typeof h.box === 'string' ? h.box : null
  }

  function isKeyBlock (r) {
    return r !== null && typeof r === 'object' && r.type === 'group-key' && Array.isArray(r.keys) && (r.kid === null || isPlainObject(r.kid))
  }

  // The epoch the members' fold makes eligible for the page writer `w` now:
  // { epoch, rekeyPending }, by the fold's own rules (covering every leave
  // and removal, sent by a distributor in office, to entitled writers only).
  // Those rules read the epochs a reader holds, and the service holds none:
  // on a copy of the logs, each entry sealed to `w` is replaced by a random
  // stand-in key of its own (the epoch's first block commitment rewritten to
  // match), so only the kids and the recipient lists, plaintext structure,
  // decide. No envelope opens under a stand-in key, and the keys are wiped.
  function eligibleEpoch (loaded, page, w) {
    const input = loaded.foldInput
    const logs = [{ key: loaded.group, log: input.root }, ...input.writers.map((l) => ({ key: l.key, log: l }))]
    const kidOf = (key, e) => e.record.kid === null ? { writer: key, seq: e.seq } : e.record.kid
    const ids = new Set()
    for (const { key, log } of logs) {
      for (const e of log.entries || []) {
        if (e && isKeyBlock(e.record) && e.record.keys.some((k) => k && k.writer === w)) ids.add(refId(kidOf(key, e)))
      }
    }
    const stand = new Map()
    const plain = new Map()
    try {
      const keyFor = (id) => {
        if (!stand.has(id)) stand.set(id, hcrypto.randomBytes(32))
        return stand.get(id)
      }
      const copyLog = ({ key, log }) => {
        let changed = false
        const entries = (log.entries || []).map((e) => {
          if (!e || !isKeyBlock(e.record)) return e
          const kid = kidOf(key, e)
          const id = refId(kid)
          if (!ids.has(id)) return e
          const k = keyFor(id)
          const r = e.record
          const next = {
            ...r,
            keys: r.keys.map((x) => {
              if (!x || x.writer !== w || typeof x.sealed !== 'string') return x
              const sealed = b4a.toString(hcrypto.randomBytes(b4a.byteLength(x.sealed, 'base64')), 'base64')
              plain.set(sealed, b4a.concat([k, keyTag(loaded.group, kid.writer, kid.seq)]))
              return { writer: x.writer, sealed }
            })
          }
          if (r.kid === null) next.commit = hex(keyCommit(k, loaded.group, kid))
          changed = true
          return { ...e, record: next }
        })
        return changed ? { ...log, entries } : log
      }
      const [root, ...writers] = logs.map(copyLog)
      const mine = new Set(input.writers.filter((l) => l.diary === page).map((l) => l.key))
      const view = groups.buildGroup({
        ...input,
        root,
        writers,
        keys: { writers: mine, unseal: (sealed) => plain.has(sealed) ? b4a.from(plain.get(sealed)) : null }
      })
      return { epoch: view.epoch ? { writer: view.epoch.writer, seq: view.epoch.seq } : null, rekeyPending: view.rekeyPending === true }
    } finally {
      for (const k of stand.values()) wipe(k)
      for (const v of plain.values()) wipe(v)
    }
  }

  // The last group-leave on writer `w` in the fold's logs, as a rejoin ref.
  function leaveOf (loaded, w) {
    const l = loaded.input.writers.find((x) => x.key === w)
    let out = null
    for (const e of (l && l.entries) || []) if (e && isLeave(e)) out = { writer: w, seq: e.seq }
    return out
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
    gate(page, loaded)
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
    const seq = await appendOn(page, core, loaded.group, groups.groupLeave({ seen: loaded.view.last, cuts }), { priv: loaded.private, community: loaded.community === true })
    await diaryJoin(page, loaded.group, w, false)
    setState(p, w, null)
    await syncWriters(page)
    return { state: 'left', leave: { writer: w, seq } }
  }

  // A group that no longer folds (dropped by its community, or unreadable)
  // is left even while a rebox is pending.
  async function groupLeave (page, G) {
    needKey(G)
    return withPage(page, async (p) => {
      knownStates(page, p)
      let loaded
      try {
        loaded = await loadGroup(page, p, G)
      } catch (err) {
        const w = writerIn(p, G)
        if (err.code !== 'nao-encontrada' || w === null) throw err
        await dropMembership(page, p, G, w, null)
        return leftFor(page, p, G)
      }
      if (gone(loaded)) {
        const w = writerIn(p, G)
        if (w !== null) await dropMembership(page, p, G, w, loaded)
        return leftFor(page, p, G)
      }
      // A leave is always safe: never held by a pending rebox nor a
      // partial fold.
      await leaveNow(page, p, loaded)
      return leftFor(page, p, G)
    })
  }

  // After the owner's leave, a rebox step filed for G goes too (with the
  // old writer's diary join off if a failure left it on), so no later
  // rebox rejoins a group the owner left.
  async function leftFor (page, p, G) {
    const steps = readSteps(page)
    const prior = steps.get(G)
    if (prior !== undefined) {
      const last = latestJoins(await writer.readEntries(page)).get(prior)
      if (last !== undefined && last.on === true) await diaryJoin(page, G, prior, false)
      setState(p, prior, null)
      await syncWriters(page)
      endStep(page, steps, G)
    }
    return { state: 'left' }
  }

  function gone (loaded) {
    return loaded.view.orphan === true || (loaded.view.community === null && !loaded.partial)
  }

  // The page's writer in G as the ACL rows know it, or null.
  function writerIn (p, G) {
    for (const [w, st] of p.state || new Map()) if (st.group === G && st.kind === 'group' && p.writers.has(w)) return w
    return null
  }

  // Ends a membership the fold cannot act on: a leave when it still folds,
  // the diary join off, the writer secret and core dropped.
  async function dropMembership (page, p, G, w, loaded) {
    if (loaded !== null && liveOwn(page, loaded) === w) {
      try {
        await leaveNow(page, p, loaded)
      } catch (err) {
        note('leave-failed', { reason: err.code || 'erro' })
      }
    }
    const last = latestJoins(await writer.readEntries(page)).get(w)
    if (last !== undefined && last.on === true) await diaryJoin(page, G, w, false)
    await dropWriter(p, page, w)
    await syncWriters(page)
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

  async function groupPost (page, G, { text, replyTo = null, fwd = 0 } = {}) {
    needKey(G)
    return withPage(page, async (p) => {
      const loaded = await loadGroup(page, p, G)
      // A private group's posts are sealed on a device ('group-seal').
      if (loaded.private) throw fail('privado')
      if (loaded.view.community === null || loaded.view.orphan || loaded.partial) throw fail('indisponivel')
      const w = liveOwn(page, loaded)
      if (w === null || loaded.view.members.get(page) !== 'member') throw fail('sem-permissao')
      if (!loaded.view.writers.has(w)) throw fail('limite')
      let record
      try {
        record = groups.groupPost({ text, replyTo, fwd, seen: loaded.view.last })
      } catch {
        throw fail('invalido')
      }
      const seq = await appendOn(page, p.writers.get(w), G, record)
      return { seq }
    })
  }

  // A sealed envelope a device of the owner or an admin built for the page's
  // live writer at `seq` (its inner record binds writer, group, kid and at).
  // A writer or length other than the device read is 'sequencia': the device
  // reads again and seals again only on the person's tap.
  async function groupSeal (page, G, { kid, nonce, box, at, writer: w0, seq: at0 } = {}) {
    needKey(G)
    let record
    try {
      record = groups.groupSealed({ kid, nonce, box, at })
    } catch {
      throw fail('invalido')
    }
    if (!Number.isSafeInteger(at0) || at0 < 1 || typeof w0 !== 'string' || !HEX64_RE.test(w0)) throw fail('invalido')
    if (groups.validateGroupRecord(record, at0, { root: false, private: true }) !== null) throw fail('invalido')
    return withPage(page, async (p) => {
      const loaded = await loadGroup(page, p, G)
      if (!loaded.private) throw fail('invalido')
      gate(page, loaded)
      if (loaded.view.community === null || loaded.view.orphan || loaded.partial) throw fail('indisponivel')
      const w = liveOwn(page, loaded)
      if (w === null || loaded.view.members.get(page) !== 'member') throw fail('sem-permissao')
      if (!loaded.view.writers.has(w)) throw fail('limite')
      if (w !== w0) throw fail('sequencia')
      if (headerBox(loaded, w) !== groupBoxPublic(page)) throw fail('aguardando-chave')
      // Only the epoch the members' nodes would send under now: an envelope
      // sealed before a removal, under a key the removed member holds, waits.
      const pick = eligibleEpoch(loaded, page, w)
      if (pick.rekeyPending || pick.epoch === null || refId(pick.epoch) !== refId(record.kid)) throw fail('aguardando-chave')
      const core = p.writers.get(w)
      if (core === undefined) throw fail('chave-ausente')
      if (core.length !== at0) throw fail('sequencia')
      const seq = await appendOn(page, core, G, record, { priv: true })
      return { seq }
    })
  }

  // Moves every private membership of the page to a writer boxed to its
  // current group box (dm.groupBox). Per group: the step is filed first
  // (<page dir>/rebox.json: group -> old writer), then the leave on the old
  // writer (the only end of a membership), a new writer whose header names
  // that leave and the new box, and its diary join; the step goes once that
  // finished. A filed step whose leave landed is completed by the next call
  // from the leave in the fold. The page waits for the group's admins to
  // admit it again and for an epoch that covers the leave. A group with no
  // room for the new writer, or one that no longer folds, is left (`left`),
  // never kept on the old box. reboxPending clears, and the legacy
  // groupBoxSecretKey is deleted, only once every group moved or was left
  // and no step is filed; a failure keeps it pending for the next call.
  async function groupRebox (page) {
    return withPage(page, (p) => reboxNow(page, p))
  }

  function stepsFile (page) {
    return path.join(pageDir(page), REBOX_FILE)
  }

  function readSteps (page) {
    const raw = readFileNoFollow(stepsFile(page))
    const out = new Map()
    if (raw === null) return out
    let data
    try {
      data = JSON.parse(b4a.toString(raw, 'utf8'))
    } catch {
      throw fail('indisponivel')
    }
    if (!isPlainObject(data) || !isPlainObject(data.steps)) throw fail('indisponivel')
    for (const [G, w] of Object.entries(data.steps)) {
      if (!HEX64_RE.test(G) || typeof w !== 'string' || !HEX64_RE.test(w)) throw fail('indisponivel')
      out.set(G, w)
    }
    return out
  }

  function writeSteps (page, steps) {
    check()
    refuseSymlinkDir(groupsDir)
    fs.mkdirSync(pageDir(page), { recursive: true, mode: 0o700 })
    writeJsonAtomic(stepsFile(page), { v: 1, steps: Object.fromEntries([...steps].sort((a, b) => a[0].localeCompare(b[0]))) }, 0o600)
  }

  function endStep (page, steps, G) {
    if (!steps.has(G)) return
    steps.delete(G)
    writeSteps(page, steps)
  }

  async function reboxNow (page, p) {
    const box = groupBoxPublic(page)
    knownStates(page, p)
    const steps = readSteps(page)
    const todo = new Map(steps)
    for (const [w, st] of p.state || new Map()) {
      if (st.kind === 'group' && p.writers.has(w) && !todo.has(st.group)) todo.set(st.group, w)
    }
    const moved = []
    const left = []
    let failures = 0
    const ctx = { touched: false }
    for (const [G, old] of todo) {
      try {
        const out = await reboxGroup(page, p, G, old, box, steps, ctx)
        if (out === 'moved') moved.push(G)
        else if (out === 'left') left.push(G)
      } catch (err) {
        failures++
        note('rebox-failed', { reason: err.code || 'erro' })
      }
    }
    // Once a move started, a block may have landed: the outcome is unknown.
    if (failures > 0 || steps.size > 0) throw fail(ctx.touched ? 'incerto' : 'indisponivel')
    check()
    await pagesStore.settleRebox(page, box)
    const row = keys.get(page)
    try {
      if (row !== null && row.groupBoxSecretKey) {
        const next = { ...row }
        delete next.groupBoxSecretKey
        check()
        keys.put(page, next)
      }
    } finally {
      zero(row)
    }
    return { groups: moved.sort(), left: left.sort() }
  }

  // -> 'moved', 'left', or 'skip' (nothing to move in G).
  async function reboxGroup (page, p, G, old, box, steps, ctx) {
    const stepped = steps.has(G)
    let loaded = null
    try {
      loaded = await loadGroup(page, p, G)
    } catch (err) {
      if (err.code !== 'nao-encontrada') throw err
    }
    if (loaded !== null && !loaded.private) {
      endStep(page, steps, G)
      return 'skip'
    }
    if (loaded === null || gone(loaded)) {
      ctx.touched = true
      if (p.writers.has(old)) await dropMembership(page, p, G, old, loaded)
      endStep(page, steps, G)
      return 'left'
    }
    const live = liveOwn(page, loaded)
    if (live !== null && headerBox(loaded, live) === box) {
      // A replacement bound before a crash: its row is persisted again
      // before the step goes.
      if (p.writers.has(live)) {
        const s = loaded.view.members.get(page) === 'member' && loaded.view.writers.has(live) ? 'member' : 'requested'
        setState(p, live, { group: G, kind: 'group', state: s })
        await syncWriters(page)
      }
      endStep(page, steps, G)
      return stepped && live !== old ? 'moved' : 'skip'
    }
    // A partial fold still ends the old membership now (the leave reads only
    // the page's own writer and diary); the new writer waits for a complete
    // fold, the filed step for the next call or the sweep.
    if (loaded.partial) {
      if (live !== null) {
        if (!stepped) {
          steps.set(G, live)
          writeSteps(page, steps)
        }
        ctx.touched = true
        await leaveNow(page, p, loaded)
      }
      throw fail('indisponivel')
    }
    // A membership whose writer the fold no longer counts as live, still
    // boxed to an old key: left, never skipped.
    if (live === null && !stepped) {
      const h = await localHeader(p, old)
      if (h === null || h.group !== G || typeof h.box !== 'string' || h.box === box) return 'skip'
      ctx.touched = true
      await dropMembership(page, p, G, old, loaded)
      return 'left'
    }
    if (!stepped) {
      steps.set(G, live)
      writeSteps(page, steps)
    }
    let leave
    if (live !== null) {
      ctx.touched = true
      leave = (await leaveNow(page, p, loaded)).leave
    } else {
      // The leave landed before a failure: the old writer's diary join off
      // and its row come first, as leaveNow does them.
      const prior = steps.get(G)
      leave = leaveOf(loaded, prior)
      if (leave) {
        ctx.touched = true
        const last = latestJoins(await writer.readEntries(page)).get(prior)
        if (last !== undefined && last.on === true) await diaryJoin(page, G, prior, false)
        setState(p, prior, null)
        await syncWriters(page)
      }
    }
    // The leave is not in the fold yet: the step stays for the next call.
    if (!leave) throw fail('indisponivel')
    if (loaded.cw === null) {
      endStep(page, steps, G)
      return 'left'
    }
    let core
    try {
      roomFor(loaded, page, G)
      core = await newWriter(p, page)
    } catch (err) {
      if (err.code !== 'limite') throw err
      endStep(page, steps, G)
      return 'left'
    }
    ctx.touched = true
    const w = hex(core.key)
    await bindWriter(p, page, core, G, groups.writerHeader({ group: G, diary: page, member: loaded.cw, rejoin: leave, box }), { priv: true }, null)
    setState(p, w, { group: G, kind: 'group', state: 'requested' })
    await syncWriters(page)
    endStep(page, steps, G)
    return 'moved'
  }

  // Block 0 of one of the page's own writer cores, or null.
  async function localHeader (p, w) {
    const core = p.writers.get(w)
    if (core === undefined || core.length === 0) return null
    try {
      const h = await core.get(0, { wait: false })
      return groups.validateWriterHeader(h) === null ? h : null
    } catch {
      return null
    }
  }

  // How many of the page's private memberships still have a writer boxed to
  // another key than dm.groupBox (every one when the page has none): what
  // 'group-rebox' would move. Read from the page's own cores, no fold.
  async function reboxNeeded (page) {
    await opening
    if (closed) throw fail('fechado')
    if (typeof page !== 'string' || !HEX64_RE.test(page)) throw fail('nao-encontrada')
    const p = await pageState(page)
    // On the page's queue, so it never reads beside a rebox in progress.
    const run = async () => {
      knownStates(page, p)
      const d = dmOf(page)
      const box = d === null ? null : d.groupBox
      let n = 0
      for (const [w, st] of p.state || new Map()) {
        if (st.kind !== 'group') continue
        const h = await localHeader(p, w)
        if (h !== null && typeof h.box === 'string' && h.box !== box) n++
      }
      return n
    }
    const next = p.chain.then(run, run)
    p.chain = next.catch(noop)
    return next
  }

  // rpc.md 5.40's shape for a public group. A private group answers no
  // item: its posts are sealed and only the devices open them.
  async function groupRead (page, G, { before = null, limit = 30 } = {}) {
    needKey(G)
    const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 30
    return withPage(page, async (p) => {
      const loaded = await loadGroup(page, p, G)
      const v = loaded.view
      if (loaded.private) {
        gate(page, loaded)
        const w = liveOwn(page, loaded)
        const role = v.members.get(page) || 'left'
        const pick = w !== null && role === 'member' && v.writers.has(w) ? eligibleEpoch(loaded, page, w) : { epoch: null, rekeyPending: true }
        return {
          private: true,
          items: [],
          next: null,
          hidden: 0,
          incomplete: v.incomplete || loaded.partial,
          sealed: v.sealed || 0,
          epoch: pick.epoch,
          state: pick.epoch !== null && !pick.rekeyPending ? 'ok' : 'rekey-pending',
          role
        }
      }
      let posts = v.posts.filter((x) => loaded.profiles.has(x.diary))
      if (before !== null && before !== undefined) {
        const i = posts.findIndex((x) => x.writer === before.writer && x.seq === before.seq)
        if (i >= 0) posts = posts.slice(0, i)
        else {
          const k = groups.orderKey(before.at, before.writer, before.seq)
          posts = posts.filter((x) => groups.compareOrder(groups.orderKey(x.at, x.writer, x.seq), k) < 0)
        }
      }
      const start = Math.max(0, posts.length - n)
      // rpc.md 5.40's compact summary: the fold's `by` lists would outgrow
      // a read (500 reactors on 32 posts is over 1 MiB), so never forwarded.
      const items = posts.slice(start).reverse().map(({ reactions, ...x }) => ({
        ...x,
        ...(Array.isArray(reactions) && reactions.length > 0 ? { reactions: reactions.map((r) => ({ emoji: r.emoji, count: r.count, mine: r.by.includes(page) })) } : {}),
        text: x.hidden ? '' : x.text,
        media: x.hidden || !x.media ? null : x.media.map((media) => ({ ...media })),
        card: x.hidden || !x.card ? null : x.card,
        ...loaded.profiles.get(x.diary)
      }))
      const last = items[items.length - 1]
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
    await Promise.all([...pageOpening.values()].map((x) => x.catch(noop)))
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
