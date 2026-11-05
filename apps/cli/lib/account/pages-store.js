'use strict'

// The page ACL the account service enforces: for each page key its owner,
// admins, current roster generation and seq, the length the service last
// appended, pending admin invites (private statements, never in the diary),
// the open transfer offer, the close and move markers, the follow and media
// counts and the community writers. Also the core-node delegates and the
// spent-nonce table that makes a replayed request answer the seq it already
// produced. Never a secret key, never a core. And the detached page-moved
// statements of pages moved while paused (served by the successor route).
//
// ONE sidecar file, <dataDir>/pages.json (mode 0o600): { v, seq, pages,
// delegates, nonces, statements }, always replaced whole through writeJsonAtomic
// (packages/core/lib/store.js: O_EXCL temp, fsync, rename, dir fsync), as
// invites-store.js does; at most 256 pages keeps it small. It is NOT part of
// account/store.js on purpose: that store's applyEntry throws on an op it
// does not know, so a separate file keeps older builds able to open the same
// data dir.
//
// Opening never creates anything, and a readOnly store never writes.
// Validation is total: a file this module would not have written is never
// rewritten, and every method then throws { code: 'indisponivel' }.
//
// Every write runs in one in-process queue against a copy of the state and
// first re-reads the file. `seq` grows by one per write, so a disk seq other
// than memory's means another holder (the service lock goes stale after
// 30 s) replaced the file meanwhile. ACL rows mutate, so unlike invites they
// cannot be union-merged: the store fails closed without writing. The state
// is swapped only after the write returned and guard() still holds. Any
// failure once writeJsonAtomic was called (it can throw after the rename, a
// directory fsync, or the lock was lost meanwhile) fails the holder closed,
// reads included, until reopened: the file may already hold the new state,
// so stale memory must not authorize anything.
//
// Residual window, accepted as in invites-store.js and terms-store.js: the
// service lock goes stale after 30 s and writeJsonAtomic renames
// unconditionally, so a holder that stalls inside a write past a takeover
// can overwrite a newer file. The seq check then makes the next writer of
// either holder fail closed, and an operator reopens.
//
// Errors carry only a token in `code`; bad argument shapes throw TypeError.

const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isCanonicalIso, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { NONCE_RE } = require('@varanda/core/lib/account-link')

const FILE = 'pages.json'
const VERSION = 1
const MAX_PAGES_PER_OWNER = 8
const MAX_PAGE_ADMINS = 16
const MAX_PAGES = 256
const MAX_PAGE_WRITERS = 16
const MAX_FOLLOWS = 4095
const MAX_DELEGATES = 4096
const MAX_NONCES = 4096
const MAX_TERMS_VERSION = 9999
const MAX_GEN = 4294967295
const NONCE_TTL_MS = 600 * 1000
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000
const OFFER_TTL_MS = 7 * 24 * 3600 * 1000
const MAX_PAGE_MOVES = 4
const WRITER_KINDS = ['community', 'group']
const WRITER_STATES = ['member', 'requested']

const ROW_KEYS = ['owner', 'admins', 'gen', 'rosterSeq', 'length', 'paused', 'createdAt', 'invites', 'offer',
  'closed', 'movedTo', 'movedFrom', 'follows', 'media', 'writers']
const INVITE_KEYS = ['gen', 'rosterSignature', 'expiresAt']
const OFFER_KEYS = ['to', 'exp', 'gen', 'seq']
const WRITER_KEYS = ['group', 'writer', 'kind', 'state']
const DELEGATE_KEYS = ['diary', 'length', 'termsVersion']
const NONCE_KEYS = ['seq', 'expiresAt']
const MAX_STATEMENT_BYTES = 4096

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function has (map, key) {
  return Object.prototype.hasOwnProperty.call(map, key)
}

function exactKeys (obj, keys) {
  return isPlainObject(obj) && Object.keys(obj).length === keys.length && keys.every((k) => has(obj, k))
}

function validKey (k) {
  return isLowerHex(k, 32)
}

function validSig (s) {
  return isLowerHex(s, 64)
}

function validInt (n, min, max) {
  return Number.isSafeInteger(n) && n >= min && n <= max
}

function validNonce (n) {
  return typeof n === 'string' && NONCE_RE.test(n)
}

function iso (ms) {
  return new Date(ms).toISOString()
}

function needKey (k, name) {
  if (!validKey(k)) throw new TypeError(name + ' must be 64 lowercase hex characters')
}

function validAdmins (admins, owner) {
  if (!Array.isArray(admins) || admins.length > MAX_PAGE_ADMINS) return false
  for (let i = 0; i < admins.length; i++) {
    if (!(i in admins) || !validKey(admins[i]) || admins[i] === owner) return false
    if (i > 0 && !(admins[i - 1] < admins[i])) return false
  }
  return true
}

function validInvite (v) {
  return exactKeys(v, INVITE_KEYS) && validInt(v.gen, 2, MAX_GEN) && validSig(v.rosterSignature) && isCanonicalIso(v.expiresAt)
}

function validOffer (o) {
  return exactKeys(o, OFFER_KEYS) && validKey(o.to) && isCanonicalIso(o.exp) && validInt(o.gen, 1, MAX_GEN) &&
    (o.seq === null || validInt(o.seq, 1, Number.MAX_SAFE_INTEGER))
}

function validWriter (w) {
  return exactKeys(w, WRITER_KEYS) && validKey(w.group) && validKey(w.writer) &&
    WRITER_KINDS.includes(w.kind) && WRITER_STATES.includes(w.state)
}

function validWriters (list) {
  if (!Array.isArray(list) || list.length > MAX_PAGE_WRITERS) return false
  const seen = new Set()
  for (let i = 0; i < list.length; i++) {
    const w = list[i]
    if (!(i in list) || !validWriter(w) || seen.has(w.writer)) return false
    seen.add(w.writer)
  }
  return true
}

function validRow (page, r) {
  if (!exactKeys(r, ROW_KEYS)) return false
  if (!validKey(r.owner) || r.owner === page || !validAdmins(r.admins, r.owner) || r.admins.includes(page)) return false
  if (!validInt(r.gen, 1, MAX_GEN) || !validInt(r.rosterSeq, 1, Number.MAX_SAFE_INTEGER)) return false
  if (!validInt(r.length, 0, Number.MAX_SAFE_INTEGER) || typeof r.paused !== 'boolean' || !isCanonicalIso(r.createdAt)) return false
  if (!isPlainObject(r.invites)) return false
  for (const [m, v] of Object.entries(r.invites)) {
    if (!validKey(m) || !validInvite(v)) return false
  }
  if (r.offer !== null && !validOffer(r.offer)) return false
  if (r.closed !== null && !isCanonicalIso(r.closed)) return false
  if (r.movedTo !== null && (!validKey(r.movedTo) || r.movedTo === page || r.closed === null)) return false
  if (r.movedFrom !== null && (!validKey(r.movedFrom) || r.movedFrom === page)) return false
  if (!validInt(r.follows, 0, MAX_FOLLOWS)) return false
  if (!exactKeys(r.media, ['items']) || !validInt(r.media.items, 0, Number.MAX_SAFE_INTEGER)) return false
  return validWriters(r.writers)
}

function validDelegate (actor, d) {
  return exactKeys(d, DELEGATE_KEYS) && validKey(d.diary) && d.diary !== actor &&
    validInt(d.length, 0, Number.MAX_SAFE_INTEGER) && validInt(d.termsVersion, 1, MAX_TERMS_VERSION)
}

// An issuer-countersigned page-moved of `page`; its signatures are checked
// by the caller before it is stored and by every reader.
function validStatement (page, s) {
  if (!isPlainObject(s) || s.type !== 'page-moved' || s.page !== page || !validKey(s.to) || s.to === page) return false
  try {
    return JSON.stringify(s).length <= MAX_STATEMENT_BYTES
  } catch {
    return false
  }
}

function nonceId (member, nonce) {
  return member + ':' + nonce
}

function validNonceRow (id, v) {
  const i = id.indexOf(':')
  return i === 64 && validKey(id.slice(0, i)) && validNonce(id.slice(i + 1)) &&
    exactKeys(v, NONCE_KEYS) && validInt(v.seq, 0, Number.MAX_SAFE_INTEGER) && isCanonicalIso(v.expiresAt)
}

function copy (v) {
  return v === null || v === undefined ? null : JSON.parse(JSON.stringify(v))
}

function emptyState () {
  return { v: VERSION, seq: 0, tag: '', pages: {}, delegates: {}, nonces: {}, statements: {} }
}

function checkMaps (obj) {
  for (const [k, r] of Object.entries(obj.pages)) {
    if (!validKey(k) || !validRow(k, r)) throw new Error('páginas inválidas')
  }
  for (const [k, d] of Object.entries(obj.delegates)) {
    if (!validKey(k) || !validDelegate(k, d)) throw new Error('páginas inválidas')
  }
  for (const [k, n] of Object.entries(obj.nonces)) {
    if (!validNonceRow(k, n)) throw new Error('páginas inválidas')
  }
  for (const [k, st] of Object.entries(obj.statements)) {
    if (!validKey(k) || !validStatement(k, st) || !has(obj.pages, k) || obj.pages[k].movedTo !== st.to) throw new Error('páginas inválidas')
  }
}

// A file written before the statements table had none: it reads as empty.
function fromJson (raw) {
  const obj = isPlainObject(raw) && !has(raw, 'statements') ? { ...raw, statements: {} } : raw
  if (!exactKeys(obj, ['v', 'seq', 'tag', 'pages', 'delegates', 'nonces', 'statements']) || obj.v !== VERSION) throw new Error('páginas inválidas')
  if (!validInt(obj.seq, 0, Number.MAX_SAFE_INTEGER)) throw new Error('páginas inválidas')
  if (typeof obj.tag !== 'string' || !/^([0-9a-f]{32})?$/.test(obj.tag)) throw new Error('páginas inválidas')
  if (!isPlainObject(obj.pages) || !isPlainObject(obj.delegates) || !isPlainObject(obj.nonces) || !isPlainObject(obj.statements)) throw new Error('páginas inválidas')
  checkMaps(obj)
  return copy(obj)
}

// The file's state, or null when it does not exist. Anything else that is
// not a valid regular file throws.
function readState (file) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  if (!st.isFile()) throw new Error('páginas inválidas')
  return fromJson(JSON.parse(fs.readFileSync(file, 'utf8')))
}

// Index loop on purpose: every() and for-of skip or hide the holes of a
// sparse array, and a hole would be written as null and brick the file.
function denseKeys (list) {
  if (!Array.isArray(list)) return false
  for (let i = 0; i < list.length; i++) {
    if (!(i in list) || !validKey(list[i])) return false
  }
  return true
}

function sortedUnique (list) {
  return [...new Set(list)].sort()
}

function openPagesStore (dataDir, { now = Date.now, readOnly = false, guard = () => true, writeJson = writeJsonAtomic, maxNonces = MAX_NONCES } = {}) {
  const nonceCap = Number.isSafeInteger(maxNonces) && maxNonces >= 1 ? Math.min(maxNonces, MAX_NONCES) : MAX_NONCES
  refuseSymlinkDir(dataDir)
  const file = path.join(dataDir, FILE)
  let state = emptyState()
  let failed = false
  try {
    state = readState(file) || emptyState()
  } catch {
    failed = true
  }
  let tail = Promise.resolve()

  function enqueue (fn) {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }

  function usable () {
    if (failed) throw fail('indisponivel')
  }

  function writable () {
    usable()
    if (readOnly || !guard()) throw fail('indisponivel')
  }

  // The single write path: `change` holds the changed rows (null removes).
  // Expired nonces are dropped in the same write.
  function commit (change) {
    const nowMs = now()
    const next = copy(state)
    for (const name of ['pages', 'delegates', 'nonces', 'statements']) {
      for (const [k, v] of Object.entries(change[name] || {})) {
        if (v === null) delete next[name][k]
        else next[name][k] = copy(v)
      }
    }
    for (const [k, v] of Object.entries(next.nonces)) {
      if (!has(change.nonces || {}, k) && Date.parse(v.expiresAt) <= nowMs) delete next.nonces[k]
    }
    // Every commit rewrites the whole file, so live nonces are capped like
    // every other table; only a commit that adds a nonce meets the cap, and
    // at the cap it drops the live rows that expire first rather than fail
    // an unrelated page. A dropped row only guarded a replay inside its TTL:
    // that resend runs again as new, and the writer's own idempotence (the
    // diary nonces) still answers it with the seq already appended.
    const adding = Object.keys(change.nonces || {}).filter((k) => change.nonces[k] !== null && !has(state.nonces, k))
    if (adding.length > 0) {
      const ids = Object.keys(next.nonces)
      let over = ids.length - nonceCap
      if (over > 0) {
        const added = new Set(adding)
        const old = ids.filter((k) => !added.has(k)).sort((a, b) => Date.parse(next.nonces[a].expiresAt) - Date.parse(next.nonces[b].expiresAt))
        for (const k of old) {
          if (over <= 0) break
          delete next.nonces[k]
          over--
        }
        if (over > 0) throw fail('limite')
      }
    }
    next.seq = state.seq + 1
    let disk
    try {
      disk = readState(file)
    } catch {
      failed = true
      throw fail('indisponivel')
    }
    // seq alone cannot tell two stale holders apart (both write N + 1); the
    // random tag of the last write this holder made can.
    next.tag = randomBytes(16).toString('hex')
    if ((disk ? disk.seq : 0) !== state.seq || (disk ? disk.tag : '') !== state.tag) {
      failed = true
      throw fail('indisponivel')
    }
    try {
      writeJson(file, next, 0o600)
    } catch {
      failed = true
      throw fail('indisponivel')
    }
    if (!guard()) {
      failed = true
      throw fail('indisponivel')
    }
    state = next
  }

  // The seq an earlier request with this spend produced, or null.
  function replayOf (spend) {
    if (spend === undefined || spend === null) return null
    spendChange(spend, 0)
    return spent(spend.member, spend.nonce)
  }

  function spendChange (spend, nowMs) {
    if (spend === undefined || spend === null) return {}
    if (!isPlainObject(spend)) throw new TypeError('spend must be { member, nonce, seq }')
    needKey(spend.member, 'spend.member')
    if (!validNonce(spend.nonce)) throw new TypeError('spend.nonce must match NONCE_RE')
    if (!validInt(spend.seq, 0, Number.MAX_SAFE_INTEGER)) throw new TypeError('spend.seq must be a non-negative integer')
    return { [nonceId(spend.member, spend.nonce)]: { seq: spend.seq, expiresAt: iso(nowMs + NONCE_TTL_MS) } }
  }

  function rowOf (page) {
    needKey(page, 'page')
    const r = state.pages[page]
    if (!r) throw fail('pedido-invalido')
    return r
  }

  function live (r) {
    return r.closed === null
  }

  function openRow (page) {
    const r = rowOf(page)
    if (!live(r)) throw fail('encerrada')
    return r
  }

  // C: a paused page refuses every ACL step before the caller appends.
  function activeRow (page) {
    const r = openRow(page)
    if (r.paused) throw fail('pausada')
    return r
  }

  // Every role a key already plays. One key is only ever one of: a page, a
  // person (owner, admin, invitee, offer target; a core delegate actor is a
  // person too), a core member's diary, or a writer/group core.
  function rolesOf (key) {
    const nowMs = now()
    const u = { page: has(state.pages, key), person: has(state.delegates, key), diary: false, core: false }
    for (const r of Object.values(state.pages)) {
      if (r.owner === key || r.admins.includes(key)) u.person = true
      // An expired invite or offer grants nothing, so it reserves nothing.
      if (has(r.invites, key) && Date.parse(r.invites[key].expiresAt) > nowMs) u.person = true
      if (r.offer !== null && r.offer.to === key && Date.parse(r.offer.exp) > nowMs) u.person = true
      if (r.writers.some((w) => w.writer === key || w.group === key)) u.core = true
    }
    for (const d of Object.values(state.delegates)) if (d.diary === key) u.diary = true
    return u
  }

  function freshKey (key) {
    const u = rolesOf(key)
    return !u.page && !u.person && !u.diary && !u.core
  }

  function personKey (key) {
    const u = rolesOf(key)
    return !u.page && !u.diary && !u.core
  }

  function coreKey (key) {
    const u = rolesOf(key)
    return !u.page && !u.person && !u.diary
  }

  // Bounded, so a damaged chain cannot loop (as account/store.js counts).
  function moveDepth (page) {
    let depth = 0
    let r = state.pages[page]
    while (r && r.movedFrom !== null && depth <= MAX_PAGE_MOVES) {
      depth++
      r = state.pages[r.movedFrom]
    }
    return depth
  }

  function depthOf (page) {
    needKey(page, 'page')
    usable()
    return moveDepth(page)
  }

  // The detached page-moved of a page moved while paused, kept for as long
  // as its row (which never leaves the file).
  function setStatement (page, record) {
    return enqueue(() => {
      needKey(page, 'page')
      if (!validStatement(page, record)) throw new TypeError('record must be a page-moved of the page')
      writable()
      const r = rowOf(page)
      if (r.movedTo !== record.to) throw fail('pedido-invalido')
      commit({ statements: { [page]: record } })
      return true
    })
  }

  function statement (page) {
    needKey(page, 'page')
    usable()
    return copy(state.statements[page] || null)
  }

  function isPage (key) {
    usable()
    return validKey(key) && has(state.pages, key)
  }

  function ownedCount (member) {
    let n = 0
    for (const r of Object.values(state.pages)) {
      if (live(r) && r.owner === member) n++
    }
    return n
  }

  function liveCount () {
    let n = 0
    for (const r of Object.values(state.pages)) {
      if (live(r)) n++
    }
    return n
  }

  function freshInvites (r, nowMs) {
    const out = {}
    for (const [m, v] of Object.entries(r.invites)) {
      if (Date.parse(v.expiresAt) > nowMs && v.gen === r.gen + 1) out[m] = v
    }
    return out
  }

  function newRow (owner, admins, nowMs, movedFrom) {
    return {
      owner,
      admins,
      gen: 1,
      rosterSeq: 2,
      length: movedFrom ? 4 : 3,
      paused: false,
      createdAt: iso(nowMs),
      invites: {},
      offer: null,
      closed: null,
      movedTo: null,
      movedFrom,
      follows: 0,
      media: { items: 0 },
      writers: []
    }
  }

  function create ({ page, owner, spend } = {}) {
    return enqueue(() => {
      needKey(page, 'page')
      needKey(owner, 'owner')
      writable()
      const nowMs = now()
      const nonces = spendChange(spend, nowMs)
      const prior = replayOf(spend)
      if (prior !== null) return prior
      if (owner === page || !freshKey(page) || !personKey(owner)) throw fail('pedido-invalido')
      if (liveCount() >= MAX_PAGES) throw fail('limite')
      if (ownedCount(owner) >= MAX_PAGES_PER_OWNER) throw fail('limite')
      const row = newRow(owner, [], nowMs, null)
      commit({ pages: { [page]: row }, nonces })
      return copy(row)
    })
  }

  function get (page) {
    needKey(page, 'page')
    usable()
    return copy(state.pages[page] || null)
  }

  function role (page, member) {
    needKey(page, 'page')
    needKey(member, 'member')
    usable()
    const r = state.pages[page]
    if (!r) return null
    if (r.owner === member) return 'owner'
    if (r.admins.includes(member)) return 'admin'
    return null
  }

  // need: 'owner' or 'admin' (the owner is also an admin here).
  function authorize (page, member, need = 'admin') {
    const got = role(page, member)
    if (!got || (need === 'owner' && got !== 'owner')) throw fail('sem-permissao')
    return got
  }

  function summary (page, r) {
    return { page, owner: r.owner, gen: r.gen, paused: r.paused, closed: r.closed !== null, movedTo: r.movedTo, movedFrom: r.movedFrom }
  }

  function listFor (member) {
    needKey(member, 'member')
    usable()
    const nowMs = now()
    const out = { owned: [], admin: [], invites: [], offers: [] }
    for (const page of Object.keys(state.pages).sort()) {
      const r = state.pages[page]
      if (r.owner === member) out.owned.push(summary(page, r))
      else if (r.admins.includes(member)) out.admin.push(summary(page, r))
      if (!live(r)) continue
      const inv = freshInvites(r, nowMs)[member]
      if (inv) out.invites.push({ page, owner: r.owner, gen: inv.gen, rosterSignature: inv.rosterSignature, expiresAt: inv.expiresAt })
      const o = r.offer
      if (o && o.to === member && Date.parse(o.exp) > nowMs && o.gen === r.gen) {
        out.offers.push({ page, owner: r.owner, to: o.to, exp: o.exp, gen: o.gen, seq: o.seq })
      }
    }
    return out
  }

  // A pending invite is a private statement: the roster it signs is
  // appended only at accept, so admins plus pending never pass the cap.
  function invite (page, member, { gen, rosterSignature, spend } = {}) {
    return enqueue(() => {
      needKey(member, 'member')
      if (!validSig(rosterSignature)) throw new TypeError('rosterSignature must be 128 lowercase hex characters')
      writable()
      const nowMs = now()
      const nonces = spendChange(spend, nowMs)
      const prior = replayOf(spend)
      if (prior !== null) return prior
      const r = activeRow(page)
      if (!personKey(member) || member === page) throw fail('pedido-invalido')
      if (member === r.owner || r.admins.includes(member)) throw fail('pedido-invalido')
      if (gen !== r.gen + 1) throw fail('expirado')
      const pending = freshInvites(r, nowMs)
      delete pending[member]
      if (r.admins.length + Object.keys(pending).length >= MAX_PAGE_ADMINS) throw fail('limite')
      const next = copy(r)
      next.invites = { ...pending, [member]: { gen, rosterSignature, expiresAt: iso(nowMs + INVITE_TTL_MS) } }
      commit({ pages: { [page]: next }, nonces })
      return copy(next.invites[member])
    })
  }

  function rosterFields (page, r, owner, admins) {
    return { page, gen: r.gen + 1, owner, admins: sortedUnique(admins), prev: r.rosterSeq }
  }

  // Read-only: the ACL changes only at setRoster, after the caller appended.
  function accept (page, member) {
    needKey(member, 'member')
    usable()
    const r = activeRow(page)
    const nowMs = now()
    const inv = r.invites[member]
    if (!inv) throw fail('sem-permissao')
    if (!(Date.parse(inv.expiresAt) > nowMs) || inv.gen !== r.gen + 1) throw fail('expirado')
    if (!personKey(member)) throw fail('pedido-invalido')
    if (r.admins.length >= MAX_PAGE_ADMINS) throw fail('limite')
    return { ...rosterFields(page, r, r.owner, [...r.admins, member]), rosterSignature: inv.rosterSignature }
  }

  function remove (page, member) {
    needKey(member, 'member')
    usable()
    const r = activeRow(page)
    if (!r.admins.includes(member)) throw fail('pedido-invalido')
    return rosterFields(page, r, r.owner, r.admins.filter((a) => a !== member))
  }

  function offer (page, to, exp, { seq = null, spend } = {}) {
    return enqueue(() => {
      needKey(to, 'to')
      if (!isCanonicalIso(exp)) throw new TypeError('exp must be a canonical ISO date')
      if (seq !== null && !validInt(seq, 1, Number.MAX_SAFE_INTEGER)) throw new TypeError('seq must be null or a positive integer')
      writable()
      const nowMs = now()
      const nonces = spendChange(spend, nowMs)
      const prior = replayOf(spend)
      if (prior !== null) return prior
      const r = activeRow(page)
      if (to === r.owner || to === page || !personKey(to)) throw fail('pedido-invalido')
      const expMs = Date.parse(exp)
      if (!(expMs > nowMs)) throw fail('expirado')
      if (expMs > nowMs + OFFER_TTL_MS) throw fail('pedido-invalido')
      const next = copy(r)
      next.offer = { to, exp, gen: r.gen, seq }
      commit({ pages: { [page]: next }, nonces })
      return copy(next.offer)
    })
  }

  function cancel (page, { spend } = {}) {
    return enqueue(() => {
      writable()
      const nonces = spendChange(spend, now())
      const prior = replayOf(spend)
      if (prior !== null) return prior
      // A paused page cannot append the cancelling page-offer, so the ACL
      // must keep the offer the diary still shows.
      const r = activeRow(page)
      if (r.offer === null && Object.keys(nonces).length === 0) return false
      const next = copy(r)
      next.offer = null
      commit({ pages: { [page]: next }, nonces })
      return true
    })
  }

  function transferAccept (page, to) {
    needKey(to, 'to')
    usable()
    const r = activeRow(page)
    const nowMs = now()
    const o = r.offer
    if (!o || o.to !== to) throw fail('sem-permissao')
    if (!(Date.parse(o.exp) > nowMs) || o.gen !== r.gen) throw fail('expirado')
    if (!personKey(to) || to === page) throw fail('pedido-invalido')
    if (ownedCount(to) >= MAX_PAGES_PER_OWNER) throw fail('limite')
    const admins = sortedUnique([...r.admins.filter((a) => a !== to), r.owner])
    if (admins.length > MAX_PAGE_ADMINS) throw fail('limite')
    return rosterFields(page, r, to, admins)
  }

  // The only owner/admins write. gen + 1 commits a new roster (invites for
  // that gen or below and the offer are spent with it); the same gen with
  // the same owner and admins only moves rosterSeq (a re-append).
  function setRoster (page, { gen, seq, owner, admins, spend } = {}) {
    return enqueue(() => {
      if (!validInt(gen, 1, MAX_GEN)) throw new TypeError('gen must be an integer from 1 to ' + MAX_GEN)
      if (!validInt(seq, 1, Number.MAX_SAFE_INTEGER)) throw new TypeError('seq must be a positive integer')
      needKey(owner, 'owner')
      if (!denseKeys(admins)) throw new TypeError('admins must be a dense array of keys')
      writable()
      const nowMs = now()
      const nonces = spendChange(spend, nowMs)
      const prior = replayOf(spend)
      if (prior !== null) return prior
      const r = activeRow(page)
      const sorted = sortedUnique(admins)
      if (sorted.length !== admins.length || sorted.includes(owner)) throw fail('pedido-invalido')
      if (owner === page || sorted.includes(page) || !personKey(owner) || sorted.some((a) => !personKey(a))) {
        throw fail('pedido-invalido')
      }
      if (sorted.length > MAX_PAGE_ADMINS) throw fail('limite')
      if (!(seq > r.rosterSeq)) throw fail('pedido-invalido')
      const next = copy(r)
      if (gen === r.gen) {
        if (owner !== r.owner || sorted.join(',') !== r.admins.join(',')) throw fail('expirado')
        next.rosterSeq = seq
      } else {
        if (gen !== r.gen + 1) throw fail('expirado')
        if (owner !== r.owner && ownedCount(owner) >= MAX_PAGES_PER_OWNER) throw fail('limite')
        next.gen = gen
        next.rosterSeq = seq
        next.owner = owner
        next.admins = sorted
        next.offer = null
        next.invites = {}
        for (const [m, v] of Object.entries(r.invites)) {
          if (v.gen > gen && Date.parse(v.expiresAt) > nowMs && m !== owner && !sorted.includes(m)) next.invites[m] = v
        }
      }
      commit({ pages: { [page]: next }, nonces })
      return copy(next)
    })
  }

  function setFlag (page, fn, opts = {}) {
    return enqueue(() => {
      writable()
      const nonces = spendChange(opts.spend, now())
      const prior = replayOf(opts.spend)
      if (prior !== null) return prior
      const r = rowOf(page)
      const next = copy(r)
      if (fn(next, r) === false && Object.keys(nonces).length === 0) return copy(r)
      commit({ pages: { [page]: next }, nonces })
      return copy(next)
    })
  }

  function pause (page, { spend } = {}) {
    return setFlag(page, (next, r) => {
      if (!live(r)) throw fail('encerrada')
      if (r.paused) return false
      next.paused = true
    }, { spend })
  }

  function expectLength (page, n, { spend } = {}) {
    if (!validInt(n, 0, Number.MAX_SAFE_INTEGER)) throw new TypeError('n must be a non-negative integer')
    return setFlag(page, (next, r) => {
      // A paused page's length is frozen at the service's last append: a
      // longer core is the leak pause records, never the new expected length.
      if (!live(r)) throw fail('encerrada')
      if (r.paused) throw fail('pausada')
      if (n < r.length) throw fail('pedido-invalido')
      if (n === r.length) return false
      next.length = n
    }, { spend })
  }

  function close (page, { spend } = {}) {
    return setFlag(page, (next, r) => {
      if (!live(r)) throw fail('encerrada')
      next.closed = iso(now())
      next.invites = {}
      next.offer = null
    }, { spend })
  }

  // One write moves the ACL: the new row starts at the copied genesis roster
  // (gen 1, seq 2), the old one is closed and points at it. The owner's live
  // count is unchanged because the old row stops counting in the same write.
  function move (from, to, { spend } = {}) {
    return enqueue(() => {
      needKey(to, 'to')
      writable()
      const nowMs = now()
      const nonces = spendChange(spend, nowMs)
      const prior = replayOf(spend)
      if (prior !== null) return prior
      const r = openRow(from)
      if (to === from || !freshKey(to) || moveDepth(from) >= MAX_PAGE_MOVES) throw fail('pedido-invalido')
      const old = copy(r)
      old.closed = iso(nowMs)
      old.movedTo = to
      old.invites = {}
      old.offer = null
      const row = newRow(r.owner, [...r.admins], nowMs, from)
      commit({ pages: { [from]: old, [to]: row }, nonces })
      return { from: copy(old), to: copy(row) }
    })
  }

  function setFollows (page, n, { spend } = {}) {
    if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('n must be a non-negative integer')
    return setFlag(page, (next, r) => {
      if (!live(r)) throw fail('encerrada')
      if (r.paused) throw fail('pausada')
      if (n > MAX_FOLLOWS) throw fail('limite')
      if (n === r.follows) return false
      next.follows = n
    }, { spend })
  }

  function setMedia (page, items, { spend } = {}) {
    if (!Number.isSafeInteger(items) || items < 0) throw new TypeError('items must be a non-negative integer')
    return setFlag(page, (next, r) => {
      if (!live(r)) throw fail('encerrada')
      if (r.paused) throw fail('pausada')
      if (items === r.media.items) return false
      next.media = { items }
    }, { spend })
  }

  function setWriters (page, writers, { spend } = {}) {
    if (!Array.isArray(writers)) throw new TypeError('writers must be an array')
    if (writers.length <= MAX_PAGE_WRITERS && !validWriters(writers)) throw new TypeError('writers must be unique { group, writer, kind, state } rows')
    // Copied now: a caller that changes its array before the queue runs must
    // not get an unchecked row into the file.
    const rows = writers.length <= MAX_PAGE_WRITERS ? writers.map((w) => ({ group: w.group, writer: w.writer, kind: w.kind, state: w.state })) : null
    return setFlag(page, (next, r) => {
      if (!live(r)) throw fail('encerrada')
      if (r.paused) throw fail('pausada')
      if (rows === null) throw fail('limite')
      if (!validWriters(rows)) throw fail('pedido-invalido')
      for (const w of rows) {
        if (w.writer === page || w.group === page || !coreKey(w.writer) || !coreKey(w.group)) throw fail('pedido-invalido')
      }
      next.writers = rows
    }, { spend })
  }

  function clearWriters (page, { spend } = {}) {
    return setWriters(page, [], { spend })
  }

  function delegate (actor) {
    needKey(actor, 'actor')
    usable()
    return copy(state.delegates[actor] || null)
  }

  // Kept apart from the directory's links: a delegate is never a member.
  function setDelegate (actor, row) {
    return enqueue(() => {
      needKey(actor, 'actor')
      if (row !== null && !validDelegate(actor, row)) throw new TypeError('row must be null or { diary, length, termsVersion }')
      writable()
      if (row !== null && !has(state.delegates, actor) && Object.keys(state.delegates).length >= MAX_DELEGATES) throw fail('limite')
      if (row === null && !has(state.delegates, actor)) return null
      if (row !== null) {
        const d = rolesOf(row.diary)
        if (!personKey(actor) || d.page || d.person || d.core) throw fail('pedido-invalido')
      }
      const value = row === null ? null : { diary: row.diary, length: row.length, termsVersion: row.termsVersion }
      commit({ delegates: { [actor]: value } })
      return copy(value)
    })
  }

  // The seq an earlier request with this (member, nonce) produced, or null.
  function spent (member, nonce) {
    needKey(member, 'member')
    if (!validNonce(nonce)) throw new TypeError('nonce must match NONCE_RE')
    usable()
    const v = state.nonces[nonceId(member, nonce)]
    if (!v || !(Date.parse(v.expiresAt) > now())) return null
    return v.seq
  }

  // Idempotent: a nonce already spent answers its stored seq and writes nothing.
  function spend (member, nonce, seq) {
    return enqueue(() => {
      writable()
      const nonces = spendChange({ member, nonce, seq }, now())
      const prior = spent(member, nonce)
      if (prior !== null) return prior
      commit({ nonces })
      return seq
    })
  }

  function stats () {
    usable()
    const out = { pages: 0, closed: 0, moved: 0, paused: 0, admins: 0, invites: 0, offers: 0, writers: 0, delegates: 0, nonces: 0 }
    for (const r of Object.values(state.pages)) {
      if (r.movedTo !== null) out.moved++
      else if (!live(r)) out.closed++
      else out.pages++
      if (!live(r)) continue
      if (r.paused) out.paused++
      out.admins += r.admins.length
      out.invites += Object.keys(r.invites).length
      if (r.offer) out.offers++
      out.writers += r.writers.length
    }
    out.delegates = Object.keys(state.delegates).length
    out.nonces = Object.keys(state.nonces).length
    return out
  }

  return {
    create,
    get,
    role,
    authorize,
    listFor,
    invite,
    accept,
    remove,
    offer,
    cancel,
    transferAccept,
    setRoster,
    pause,
    expectLength,
    isPage,
    close,
    move,
    moveDepth: depthOf,
    setStatement,
    statement,
    setFollows,
    setMedia,
    setWriters,
    clearWriters,
    delegate,
    setDelegate,
    spent,
    spend,
    stats,
    snapshot () {
      usable()
      return copy(state)
    },
    fail () { failed = true },
    available () { return !failed }
  }
}

module.exports = {
  openPagesStore,
  FILE,
  MAX_PAGES_PER_OWNER,
  MAX_PAGE_ADMINS,
  MAX_PAGES,
  MAX_PAGE_WRITERS,
  MAX_FOLLOWS,
  NONCE_TTL_MS,
  INVITE_TTL_MS,
  OFFER_TTL_MS,
  MAX_PAGE_MOVES,
  MAX_STATEMENT_BYTES
}
