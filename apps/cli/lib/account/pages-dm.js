'use strict'

// Conversas as a page (docs/protocol.md §12 'Conversas como página', docs/rpc.md
// 5.84): the page's box keys live on the devices of its owner and admins,
// never here. The account service keeps three duties:
//
//   - the digest oracle: 'dm-sign' signs DM_V3_PREFIX || digest with the
//     page key (core dm.js signDigest), the digest of a drop a device built
//     and sealed. The service never sees the text, the recipient or the
//     sealed bytes. Rate limited per page and per host.
//   - opaque shares: 'dm-box' publishes the page's new box as its dm-key
//     (gen + 1, through the writer's own hook) and stores the public boxes
//     and each member's sealed share in the ACL row (./pages-store.js dm);
//     'dm-box-share' adds one share, 'dm-box-read' hands a member its own.
//     The service checks shapes only: the devices verify every signature.
//   - legacy: a page that existed before keeps its gen 1 box secret
//     (page-keys boxSecretKey, never created any more) and its sealed rows
//     file until the owner's first 'dm-box'. That 'dm-box' first seals one
//     bundle (the secret, every old row and every old folder op) to the
//     owner's own box in chunks, records it with the rotation, and only
//     then deletes the rows and the secret. The service keeps the sealed
//     chunks, which it cannot open, until the owner's device confirms the
//     import ('dm-legacy-done') or the page closes.
//
// A refresh tick appends the stored dm-key again whenever it falls out of
// the newest DM_KEY_REFRESH_BLOCKS blocks, from stored public values only.
//
// Every function that changes a page runs under the caller's page lock
// (./pages-routes.js withLock), so the gen check and the writes are one step.
//
// Logs carry { event: 'page-dm', reason } only: never a text, digest, key or
// peer.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const dm = require('@varanda/core/lib/dm')
const dmFold = require('@varanda/core/lib/dm-fold')
const { PAGE_SECRETS_SEALED_BYTES } = require('@varanda/core/lib/page-secrets')
const { isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { copyLinkCard } = require('@varanda/core/lib/link-card')
const { isWeakBoxKey } = require('@varanda/core/lib/group')
const { ENV } = require('./page-keys')

const coreDir = path.dirname(require.resolve('@varanda/core/lib/seeder'))
const sodium = require(require.resolve('sodium-universal', { paths: [coreDir] }))

const STATE_DIR = 'pages-dm'
const VERSION = 1
const AAD = b4a.from('varanda-page-dm-v1')
const KEY_LABEL = 'varanda-page-dm-rows-v1'
const REFRESH_EVERY_MS = 60000
const PREVIEW_MAX = 140
const SIGN_PER_PAGE = 30
const SIGN_PER_HOST = 240
const SIGN_WINDOW_MS = 60000
const MAX_GEN = 4294967295
// The legacy bundle: chunks of at most BUNDLE_CHUNK_BYTES plaintext, each
// bundleId (32) || uint16be index || uint16be count || bytes, sealed to the
// owner's own box. More than BUNDLE_MAX_CHUNKS is refused, never cut.
const BUNDLE_V = 1
const BUNDLE_CHUNK_BYTES = 40000
const BUNDLE_MAX_CHUNKS = 1024
const BUNDLE_READ_CHUNKS = 8
const BUNDLE_OPS = ['accepted', 'declined', 'blocked', 'unblocked', 'deleted']
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
// Below this a filedAt is a counter from an older state file, not ms.
const FILED_MS_FLOOR = 1e12

function noop () {}

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function exactKeys (obj, required, optional = []) {
  if (!isPlainObject(obj)) return false
  const keys = Object.keys(obj)
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k))
}

function preview (text) {
  return Array.from(text).slice(0, PREVIEW_MAX).join('')
}

function mediaOf (m) {
  return Array.isArray(m.media) && m.media.length > 0 ? m.media : null
}

// A stored card is checked again on load, as rows outlive code versions: a
// bad image drops only the image, any other fault the whole card.
function cardOf (card) {
  if (!isPlainObject(card)) return null
  const c = copyLinkCard(card, (d) => ({ ...d }))
  if (dm.validDmCard(c)) return c
  if (c.image === null) return null
  const bare = { ...c, image: null }
  return dm.validDmCard(bare) ? bare : null
}

function validState (s) {
  return isPlainObject(s) && s.v === VERSION && Number.isSafeInteger(s.filed) && Array.isArray(s.messages) &&
    Array.isArray(s.ops) && Array.isArray(s.seen)
}

function isBoxKey (v) {
  return typeof v === 'string' && HEX64_RE.test(v) && !isWeakBoxKey(v)
}

// Canonical base64 of exactly PAGE_SECRETS_SEALED_BYTES: one envelope, one
// encoding.
function isSealed (s) {
  if (typeof s !== 'string' || s.length !== Math.ceil(PAGE_SECRETS_SEALED_BYTES / 3) * 4 || !BASE64_RE.test(s)) return false
  const buf = Buffer.from(s, 'base64')
  return buf.length === PAGE_SECRETS_SEALED_BYTES && buf.toString('base64') === s
}

function isSig (s) {
  return typeof s === 'string' && HEX128_RE.test(s)
}

// The shape of a share sent with an invite: { sealed, sig }, or null.
function parseInviteShare (share) {
  if (share === undefined) return null
  if (!exactKeys(share, ['sealed', 'sig']) || !isSealed(share.sealed) || !isSig(share.sig)) throw fail('pedido-invalido')
  return { sealed: share.sealed, sig: share.sig }
}

// A 'dm-box' op, or the dmBox of a remove or a move: exactly { expectedGen,
// box, groupBox, ownBox, shares }. shares name a subset of `roster` that
// includes `owner`, each member at most once.
function parseBox (raw, { roster, owner }) {
  if (!exactKeys(raw, ['expectedGen', 'box', 'groupBox', 'ownBox', 'shares'])) throw fail('pedido-invalido')
  if (!Number.isSafeInteger(raw.expectedGen) || raw.expectedGen < 0 || raw.expectedGen >= MAX_GEN) throw fail('pedido-invalido')
  if (!isBoxKey(raw.box) || !isBoxKey(raw.groupBox) || !isBoxKey(raw.ownBox) || raw.box === raw.groupBox) throw fail('pedido-invalido')
  if (!Array.isArray(raw.shares) || raw.shares.length < 1 || raw.shares.length > roster.length) throw fail('pedido-invalido')
  const shares = []
  const seen = new Set()
  for (let i = 0; i < raw.shares.length; i++) {
    const s = raw.shares[i]
    if (!(i in raw.shares) || !exactKeys(s, ['member', 'sealed', 'sig'])) throw fail('pedido-invalido')
    if (typeof s.member !== 'string' || !roster.includes(s.member) || seen.has(s.member)) throw fail('pedido-invalido')
    if (!isSealed(s.sealed) || !isSig(s.sig)) throw fail('pedido-invalido')
    seen.add(s.member)
    shares.push({ member: s.member, sealed: s.sealed, sig: s.sig })
  }
  if (!seen.has(owner)) throw fail('pedido-invalido')
  return { expectedGen: raw.expectedGen, box: raw.box, groupBox: raw.groupBox, ownBox: raw.ownBox, shares }
}

// JSON with the keys of every object sorted: one bundle, one encoding.
function canonical (v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (isPlainObject(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  return JSON.stringify(v === undefined ? null : v)
}

// Writes `buf` to `file` through a temporary file: fsync, rename, then the
// directory's fsync, so a crash leaves the old file or the whole new one.
function writeDurable (file, buf) {
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600)
  try {
    let done = 0
    while (done < buf.byteLength) done += fs.writeSync(fd, buf, done, buf.byteLength - done)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  syncDir(path.dirname(file))
}

// Only a platform that cannot fsync a directory is tolerated; any other
// failure (EIO, ENOSPC) must stop the caller before it deletes the only copy.
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'])

function syncDir (dir) {
  let fd
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } catch (err) {
    if (!(err && DIR_SYNC_UNSUPPORTED.has(err.code))) throw err
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function readNoFollow (file) {
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

function zeroRow (row) {
  if (row === null) return
  for (const k of ['secretKey', 'mediaSecretKey', 'boxSecretKey', 'groupBoxSecretKey']) if (row[k]) row[k].fill(0)
  if (row.writers) for (const w of Object.values(row.writers)) w.fill(0)
}

// limits (tests): refreshEveryMs, signPerPage, signPerHost, signWindowMs.
// hooks (tests): afterLegacyPersist(page), run after the legacy bundle is
// recorded and promoted and before the legacy secret and rows are deleted;
// afterBundleChunks(page), run after the chunks are written and before the
// store write that records them.
// seederWs, blocklist, revokedIssuers and tmpRoot are accepted for the
// callers' sake and unused: the service no longer reaches the drop pool.
function createPagesDm ({ writer, pagesStore = null, keys, association, dir, env = process.env, guard = () => true, log = noop, limits = {}, hooks = {} } = {}) {
  if (!writer || typeof writer.ensureDmKey !== 'function') throw new TypeError('writer must be a pages writer')
  if (!keys || typeof keys.get !== 'function') throw new TypeError('keys must be a page-keys table')
  if (typeof association !== 'string' || !HEX64_RE.test(association)) throw new TypeError('association must be 64 lowercase hex characters')
  if (typeof dir !== 'string' || dir === '') throw new TypeError('dir must be a path')
  const raw = env && typeof env[ENV] === 'string' ? env[ENV] : ''
  if (!HEX64_RE.test(raw)) throw new TypeError(ENV + ' ausente')
  const L = {
    refreshEveryMs: REFRESH_EVERY_MS,
    signPerPage: SIGN_PER_PAGE,
    signPerHost: SIGN_PER_HOST,
    signWindowMs: SIGN_WINDOW_MS,
    ...(limits || {})
  }
  // Only a derived key is kept, never the env value itself.
  const envKey = b4a.from(raw, 'hex')
  const master = nodeCrypto.createHmac('sha256', envKey).update(KEY_LABEL).digest()
  envKey.fill(0)

  refuseSymlinkDir(dir)
  const stateDir = path.join(dir, STATE_DIR)
  const signs = new Map() // page -> [ms]
  const chains = new Map() // page -> Promise
  const hostSigns = []
  let refreshing = null
  let timer = null
  let closed = false
  const inflight = new Set()

  const starting = start()
  starting.catch(noop)

  return {
    ready: () => starting,
    signDigest: tracked(signDigest),
    applyBox: tracked(applyBox),
    complete: tracked(complete),
    prepareRemove: tracked(prepareRemove),
    moveDm,
    carryBundle,
    share: tracked(share),
    read: tracked(read),
    gen: tracked(genOf),
    legacy: tracked(async (page) => hasRows(page)),
    legacyRead: tracked(legacyRead),
    legacyDone: tracked(legacyDone),
    list: tracked(list),
    thread: tracked(thread),
    forget: tracked(forget),
    refresh: tracked(refresh),
    close
  }

  function note (reason) {
    try { log({ event: 'page-dm', reason }) } catch {}
  }

  function tracked (fn) {
    return (...args) => {
      if (closed) return Promise.reject(fail('fechado'))
      const p = Promise.resolve().then(() => fn(...args))
      inflight.add(p)
      const done = () => { inflight.delete(p) }
      p.then(done, done)
      return p
    }
  }

  function check () {
    let ok = false
    try {
      ok = !closed && guard() === true
    } catch {}
    if (!ok) throw fail('indisponivel')
  }

  function pageParam (page) {
    if (typeof page !== 'string' || !HEX64_RE.test(page)) throw fail('pedido-invalido')
    return page
  }

  function needStore () {
    if (pagesStore === null) throw fail('indisponivel')
  }

  function aclRow (page) {
    needStore()
    let row
    try {
      row = pagesStore.get(page)
    } catch {
      throw fail('indisponivel')
    }
    if (row === null) throw fail('pedido-invalido')
    return row
  }

  // ---- the legacy secret --------------------------------------------------

  // The public half of the legacy gen 1 box, or null when none is held.
  function legacyBox (page) {
    const row = keys.get(page)
    try {
      if (row === null || !row.boxSecretKey) return null
      const pk = b4a.alloc(32)
      sodium.crypto_scalarmult_base(pk, row.boxSecretKey)
      return hex(pk)
    } finally {
      zeroRow(row)
    }
  }

  // The legacy secret leaves page-keys and the old rows leave the disk. The
  // row is put back in the same synchronous step that read it. The rows go
  // first: a crash between the two leaves only the secret, which the start
  // removes again (the legacy envelope being on record).
  function dropLegacy (page) {
    check()
    refuseSymlinkDir(dir)
    if (fs.existsSync(stateDir)) refuseSymlinkDir(stateDir)
    fs.rmSync(fileOf(page), { force: true })
    syncDir(stateDir)
    if (typeof hooks.afterRowsDropped === 'function') hooks.afterRowsDropped(page)
    check()
    const row = keys.get(page)
    if (row !== null && row.boxSecretKey) {
      try {
        row.boxSecretKey.fill(0)
        delete row.boxSecretKey
        keys.put(page, row)
      } finally {
        zeroRow(row)
      }
    } else {
      zeroRow(row)
    }
  }

  // Legacy material still on the service: the old rows or the gen 1 secret.
  function legacyHeld (page) {
    return hasRows(page) || legacyBox(page) !== null
  }

  // ---- the digest oracle --------------------------------------------------

  function admitSign (page) {
    const t = Date.now()
    const floor = t - L.signWindowMs
    while (hostSigns.length > 0 && hostSigns[0] <= floor) hostSigns.shift()
    const list = (signs.get(page) || []).filter((x) => x > floor)
    if (list.length >= L.signPerPage || hostSigns.length >= L.signPerHost) {
      signs.set(page, list)
      throw fail('limite')
    }
    list.push(t)
    hostSigns.push(t)
    signs.set(page, list)
    for (const [k, v] of signs) if (v.length === 0 || v[v.length - 1] <= floor) signs.delete(k)
  }

  // -> { signature, expiresAt }: the page's signature over DM_V3_PREFIX ||
  // digest || uint64be(expiresAt). The service picks expiresAt, never the
  // caller, so an admin cannot stockpile signatures that outlive its role by
  // more than DM_V3_STALE_MS (receivers drop a stale v3).
  async function signDigest (page, digest) {
    pageParam(page)
    if (typeof digest !== 'string' || !HEX64_RE.test(digest)) throw fail('pedido-invalido')
    // A rotation in progress (a removed admin among the old holders): no
    // signature until it completes.
    if (pagesStore !== null) {
      const row = aclRow(page)
      if (row.dm && row.dm.rotatePending !== null) throw fail('rotacao-necessaria')
    }
    try {
      admitSign(page)
    } catch (err) {
      note('limite')
      throw err
    }
    const row = keys.get(page)
    if (row === null) throw fail('pausada')
    try {
      const expiresAt = Date.now() + dm.DM_V3_TTL_MS
      return { signature: dm.signDigest(digest, row.secretKey, expiresAt), expiresAt }
    } catch {
      throw fail('pedido-invalido')
    } finally {
      zeroRow(row)
    }
  }

  // ---- shares -------------------------------------------------------------

  // One page at a time, here as well as under the routes' page lock, so the
  // refresh tick and the start never race a route's rotation.
  function chained (page, fn) {
    const prev = chains.get(page) || Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.then(noop, noop)
    chains.set(page, tail)
    tail.then(() => { if (chains.get(page) === tail) chains.delete(page) })
    return next
  }

  // The current gen: the device-held one, else 1 for a legacy page whose
  // gen 1 box the service still holds, else 0.
  function currentGen (page, row) {
    if (row.dm && row.dm.gen > 0) return row.dm.gen
    return legacyBox(page) !== null ? 1 : 0
  }

  async function genOf (page) {
    pageParam(page)
    return currentGen(page, aclRow(page))
  }

  function sharesOf (shares, gen, by, at) {
    const out = {}
    for (const s of shares) out[s.member] = { gen, sealed: s.sealed, by, sig: s.sig, at }
    return out
  }

  function emptyDm () {
    return { gen: 0, box: null, groupBox: null, shares: {}, pending: {}, reboxPending: false, legacyBundle: null, rotatePending: null }
  }

  // A rotation (from 'dm-box' or a remove), prepared and persisted before
  // its dm-key is published. kind 'remove' is committed by the routes with
  // the roster (pagesStore.setRoster rotate); this builds it.
  function prepare (page, row, { kind, idem, by, dmBox, gen }) {
    return { kind, idem, gen, box: dmBox.box, groupBox: dmBox.groupBox, shares: sharesOf(dmBox.shares, gen, by, new Date().toISOString()) }
  }

  // Publishes the persisted rotation (a no-op when that exact dm-key is
  // already the newest) and promotes it to current, then drops the legacy
  // material it replaces. -> { seq, gen } or null with none.
  async function completeNow (page) {
    check()
    const row = aclRow(page)
    const d = row.dm || null
    if (d === null || d.rotatePending === null) {
      if (d !== null && d.legacyBundle !== null && legacyHeld(page)) dropLegacy(page)
      return null
    }
    const P = d.rotatePending
    if (typeof hooks.beforePublish === 'function') await hooks.beforePublish(page)
    let res
    try {
      res = await writer.ensureDmKey(page, { box: P.box, gen: P.gen })
    } catch (err) {
      note('dm-key-falhou')
      throw err
    }
    if (typeof hooks.afterPublish === 'function') await hooks.afterPublish(page)
    const i = P.idem.indexOf(':')
    const spend = P.kind === 'box' ? { member: P.idem.slice(0, i), nonce: P.idem.slice(i + 1), seq: res.seq === null ? 0 : res.seq } : undefined
    let promoted
    try {
      if (res.seq !== null) {
        try { await pagesStore.expectLength(page, res.length) } catch {}
      }
      // Compare-and-set in the store: only the rotation this run read is
      // promoted, so a newer one (a remove committed while this run waited
      // on the publish) is left for its own request.
      promoted = await pagesStore.promoteDm(page, { idem: P.idem, gen: P.gen, spend })
    } catch (err) {
      note('armazenamento-indisponivel')
      throw err
    }
    if (promoted === null) {
      note('rotacao-superada')
      return null
    }
    if (promoted.legacyBundle !== null && legacyHeld(page)) {
      if (typeof hooks.afterLegacyPersist === 'function') await hooks.afterLegacyPersist(page)
      dropLegacy(page)
      note('legado-removido')
    }
    return { seq: res.seq, gen: P.gen }
  }

  function complete (page) {
    pageParam(page)
    return chained(page, () => completeNow(page))
  }

  // 'dm-box', under the caller's page lock. dmBox: parseBox output; by: the
  // owner; idem: { member, nonce }. The new { gen, box, groupBox, shares }
  // is persisted first, then published, then promoted, so a device is never
  // handed shares that do not match the newest published box. A resend of
  // the same request completes its own rotation. On a legacy page the
  // bundle of the old Conversas is sealed and recorded in the same write as
  // the rotation, before anything legacy is deleted. -> { seq, gen }.
  function applyBox (page, { by, dmBox, idem }) {
    pageParam(page)
    return chained(page, async () => {
      check()
      const id = idem.member + ':' + idem.nonce
      let row = aclRow(page)
      if (row.dm && row.dm.rotatePending !== null) {
        const mine = row.dm.rotatePending.idem === id
        const done = await completeNow(page)
        if (mine) {
          if (done === null) throw fail('conflito')
          return done
        }
        row = aclRow(page)
      }
      const cur = currentGen(page, row)
      if (dmBox.expectedGen !== cur) throw fail('conflito')
      const base = row.dm ? JSON.parse(JSON.stringify(row.dm)) : emptyDm()
      // A bundle already on record was built from the same frozen rows: it
      // is kept, so its chunks on disk always match the record.
      if (base.legacyBundle === null && !(row.dm && row.dm.gen > 0) && cur === 1) {
        base.legacyBundle = writeBundle(page, by, dmBox.ownBox)
        if (typeof hooks.afterBundleChunks === 'function') await hooks.afterBundleChunks(page)
      }
      base.rotatePending = prepare(page, row, { kind: 'box', idem: id, by, dmBox, gen: cur + 1 })
      await pagesStore.setDm(page, base)
      const done = await completeNow(page)
      if (done === null) throw fail('conflito')
      return done
    })
  }

  // The prepared rotation of a remove, for pagesStore.setRoster's rotate:
  // exactly expectedGen + 1, the gen the device sealed the shares for. The
  // routes refuse a remove while another rotation is pending.
  function prepareRemove (page, { by, dmBox, idem }) {
    pageParam(page)
    const row = aclRow(page)
    if (row.dm.rotatePending !== null || dmBox.expectedGen !== row.dm.gen) throw fail('rotacao-necessaria')
    return prepare(page, row, { kind: 'remove', idem: idem.member + ':' + idem.nonce, by, dmBox, gen: dmBox.expectedGen + 1 })
  }

  // The dm row of a move's K2: its gen 1 dm-key is already on K2. K1's
  // legacy bundle (carryBundle) comes along unchanged, still sealed to the
  // same member; without a dmBox it is K2's only dm (gen 0). -> row or null.
  function moveDm ({ by, dmBox = null, legacyBundle = null }) {
    const bundle = legacyBundle === null ? null : { for: legacyBundle.for, id: legacyBundle.id, count: legacyBundle.count }
    if (dmBox === null) return bundle === null ? null : { ...emptyDm(), legacyBundle: bundle }
    return { gen: 1, box: dmBox.box, groupBox: dmBox.groupBox, shares: sharesOf(dmBox.shares, 1, by, new Date().toISOString()), pending: {}, reboxPending: false, legacyBundle: bundle, rotatePending: null }
  }

  // One more member's share of the current gen ('dm-box-share').
  // idem { member, nonce }: spent in the same write as the share, so a
  // replay after a restart is answered from the spent nonce, never applied
  // again over a newer share. owner: the route found `by` is the page's
  // owner. Only the owner replaces a share of the current gen or writes its
  // own; an admin only adds a missing one, so it cannot overwrite another
  // holder's share and stop the key from reaching them.
  function share (page, { by, owner = false, member, gen, sealed, sig, idem = null } = {}) {
    pageParam(page)
    if (!isSealed(sealed) || !isSig(sig) || typeof member !== 'string' || !HEX64_RE.test(member)) throw fail('pedido-invalido')
    if (!Number.isSafeInteger(gen) || gen < 1) throw fail('pedido-invalido')
    return chained(page, async () => {
      const row = aclRow(page)
      if (row.owner !== member && !row.admins.includes(member)) throw fail('pedido-invalido')
      if (row.dm && row.dm.rotatePending !== null) throw fail('rotacao-necessaria')
      if (!row.dm || row.dm.gen !== gen) throw fail('conflito')
      const byOwner = owner === true && by === row.owner
      const held = row.dm.shares[member]
      if (!byOwner && (member === row.owner || (held && held.gen === gen))) throw fail('conflito')
      const next = JSON.parse(JSON.stringify(row.dm))
      next.shares[member] = { gen, sealed, by, sig, at: new Date().toISOString() }
      await pagesStore.setDm(page, next, { spend: idem === null ? undefined : { member: idem.member, nonce: idem.nonce, seq: 0 } })
      return { ok: true }
    })
  }

  // 'dm-box-read' for an owner or admin (the caller checked the role).
  function read (page, { member, owner = false, cert = null } = {}) {
    pageParam(page)
    return chained(page, async () => {
      let row = aclRow(page)
      // A legacy cleanup a crash cut short finishes now, the bundle being
      // on record.
      if (row.dm && row.dm.rotatePending === null && row.dm.legacyBundle !== null && legacyHeld(page)) {
        dropLegacy(page)
        row = aclRow(page)
      }
      const d = row.dm && row.dm.gen > 0 ? row.dm : null
      const rotating = Boolean(row.dm && row.dm.rotatePending !== null)
      const legacyPub = d === null ? legacyBox(page) : null
      const bundle = row.dm ? row.dm.legacyBundle : null
      const out = {
        gen: d !== null ? d.gen : legacyPub !== null ? 1 : 0,
        box: d !== null ? d.box : legacyPub,
        groupBox: d !== null ? d.groupBox : null,
        // Mid rotation the newest published box may already be the pending
        // one: no share is handed out until it is promoted.
        share: d !== null && !rotating && d.shares[member] ? { ...d.shares[member] } : null,
        cert,
        legacy: hasRows(page),
        rotatePending: rotating,
        // Only to the member it is sealed to: a later owner cannot open it.
        legacyBundle: bundle !== null && bundle.for === member ? { id: bundle.id, count: bundle.count } : null
      }
      if (owner) {
        out.shared = d !== null ? Object.keys(d.shares).sort() : []
      }
      return out
    })
  }

  // ---- legacy rows, read only ---------------------------------------------

  function keyOf (page) {
    return nodeCrypto.createHmac('sha256', master).update(page).digest()
  }

  function fileOf (page) {
    return path.join(stateDir, page + '.json')
  }

  function hasRows (page) {
    try {
      return fs.lstatSync(fileOf(page)).isFile()
    } catch {
      return false
    }
  }

  function loadState (page) {
    const buf = readNoFollow(fileOf(page))
    if (buf === null) return null
    const key = keyOf(page)
    let plain = null
    let s
    try {
      const outer = JSON.parse(b4a.toString(buf, 'utf8'))
      const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(outer.iv, 'base64'), { authTagLength: 16 })
      decipher.setAAD(AAD)
      decipher.setAuthTag(Buffer.from(outer.tag, 'base64'))
      plain = b4a.concat([decipher.update(Buffer.from(outer.data, 'base64')), decipher.final()])
      s = JSON.parse(b4a.toString(plain, 'utf8'))
    } catch {
      throw fail('indisponivel')
    } finally {
      key.fill(0)
      if (plain !== null) plain.fill(0)
    }
    if (!validState(s)) throw fail('indisponivel')
    let mtime = Date.now()
    try { mtime = fs.lstatSync(fileOf(page)).mtimeMs } catch {}
    migrateFiled(s, mtime)
    for (const m of s.messages) {
      if (isPlainObject(m) && Object.hasOwn(m, 'card')) m.card = cardOf(m.card)
    }
    return s
  }

  // Older files numbered rows 1, 2, 3. Those counters become ms just before
  // the file's last write, in the same order, so no row reads as 1970.
  function migrateFiled (s, mtime) {
    const rows = [...s.messages, ...s.ops]
    if (!rows.some((r) => isPlainObject(r) && typeof r.filedAt === 'number' && r.filedAt < FILED_MS_FLOOR)) return
    const legacy = s.filed < FILED_MS_FLOOR
    let top = legacy ? s.filed : 0
    for (const r of rows) if (isPlainObject(r) && Number.isSafeInteger(r.filedAt) && r.filedAt < FILED_MS_FLOOR && r.filedAt > top) top = r.filedAt
    const base = Math.floor(Math.min(mtime, Date.now())) - top - 1
    for (const r of rows) {
      if (!isPlainObject(r) || typeof r.filedAt !== 'number') continue
      if (r.filedAt < FILED_MS_FLOOR) r.filedAt = base + r.filedAt
    }
  }

  // ---- the legacy bundle ----------------------------------------------------

  function bundleDir (page) {
    return path.join(stateDir, page + '.legacy')
  }

  function dropBundleFiles (page) {
    refuseSymlinkDir(dir)
    if (fs.existsSync(stateDir)) refuseSymlinkDir(stateDir)
    fs.rmSync(bundleDir(page), { recursive: true, force: true })
    syncDir(stateDir)
  }

  // Rows and ops together in the order they were filed (filedAt, ties in
  // stored order, rows before ops): a 'deleted' op hides only what was
  // filed before it, so their relative order must survive the bundle.
  function filed (messages, ops) {
    const all = [...messages.map((r) => ({ kind: 'row', r })), ...ops.map((r) => ({ kind: 'op', r }))]
    return all.map((x, i) => ({ ...x, i, at: isPlainObject(x.r) && typeof x.r.filedAt === 'number' ? x.r.filedAt : 0 }))
      .sort((a, b) => a.at - b.at || a.i - b.i)
  }

  // The plaintext of the bundle: the gen 1 box secret, every old row and
  // every old folder op, canonical JSON. -> Buffer (the caller wipes it).
  function bundleBytes (page) {
    const krow = keys.get(page)
    let box
    try {
      if (krow === null || !krow.boxSecretKey) throw fail('pedido-invalido')
      box = hex(krow.boxSecretKey)
    } finally {
      zeroRow(krow)
    }
    const st = loadState(page)
    const rows = []
    const ops = []
    if (st !== null) {
      // n: one filing position shared by rows and ops.
      let n = 0
      for (const { kind, r } of filed(st.messages, st.ops)) {
        if (kind === 'op') {
          // Only folder, block and delete ops: the device refuses the whole
          // bundle on any other shape.
          if (isPlainObject(r) && BUNDLE_OPS.includes(r.op) && typeof r.peer === 'string' && HEX64_RE.test(r.peer) && r.peer !== page) {
            ops.push({ op: r.op, peer: r.peer, n: n++ })
          }
          continue
        }
        const m = r
        if (!isPlainObject(m)) continue
        rows.push({
          id: m.id,
          from: m.from,
          to: m.mine ? m.peer : page,
          text: m.text,
          at: m.at,
          replyTo: m.replyTo === undefined ? null : m.replyTo,
          media: mediaOf(m),
          card: m.card === undefined ? null : m.card,
          fwd: m.fwd === 1 ? 1 : 0,
          n: n++
        })
      }
    }
    return b4a.from(canonical({ v: BUNDLE_V, page, box, rows, ops }), 'utf8')
  }

  // Seals the bundle to the owner's own box and writes its chunks, each
  // durable, before the caller records it. A partial set left by a crash
  // has no record and is removed here or at the next start.
  // -> { for, id, count }.
  function writeBundle (page, by, ownBox) {
    check()
    const plain = bundleBytes(page)
    try {
      const count = Math.max(1, Math.ceil(plain.byteLength / BUNDLE_CHUNK_BYTES))
      if (count > BUNDLE_MAX_CHUNKS) {
        note('legado-grande')
        throw fail('limite')
      }
      const id = nodeCrypto.randomBytes(32)
      const pk = b4a.from(ownBox, 'hex')
      refuseSymlinkDir(dir)
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      refuseSymlinkDir(stateDir)
      dropBundleFiles(page)
      fs.mkdirSync(bundleDir(page), { mode: 0o700 })
      refuseSymlinkDir(bundleDir(page))
      for (let i = 0; i < count; i++) {
        const part = plain.subarray(i * BUNDLE_CHUNK_BYTES, Math.min(plain.byteLength, (i + 1) * BUNDLE_CHUNK_BYTES))
        const msg = b4a.alloc(36 + part.byteLength)
        msg.set(id, 0)
        msg.writeUInt16BE(i, 32)
        msg.writeUInt16BE(count, 34)
        msg.set(part, 36)
        const sealed = b4a.alloc(msg.byteLength + sodium.crypto_box_SEALBYTES)
        sodium.crypto_box_seal(sealed, msg, pk)
        msg.fill(0)
        writeDurable(path.join(bundleDir(page), String(i)), sealed)
      }
      syncDir(stateDir)
      return { for: by, id: hex(id), count }
    } catch (err) {
      try { dropBundleFiles(page) } catch {}
      if (err && ['limite', 'indisponivel', 'pedido-invalido'].includes(err.code)) throw err
      note('legado-falhou')
      throw fail('indisponivel')
    } finally {
      plain.fill(0)
    }
  }

  // A move, before its commit: K1's sealed chunks are copied, each durable,
  // to K2's directory, and K1's record is returned for K2's dm row. K1's
  // chunks stay until K1's row is closed (the move's commit), so a crash
  // at any point leaves a row naming a complete directory; a copy no row
  // names yet is removed at the next start and made again by the resend.
  // -> { for, id, count } or null without a bundle.
  function carryBundle (from, to) {
    pageParam(from)
    pageParam(to)
    check()
    const row = aclRow(from)
    const b = row.dm ? row.dm.legacyBundle : null
    if (b === null) return null
    try {
      refuseSymlinkDir(dir)
      refuseSymlinkDir(stateDir)
      refuseSymlinkDir(bundleDir(from))
      fs.mkdirSync(bundleDir(to), { recursive: true, mode: 0o700 })
      refuseSymlinkDir(bundleDir(to))
      for (let i = 0; i < b.count; i++) {
        const buf = readNoFollow(path.join(bundleDir(from), String(i)))
        if (buf === null) throw fail('indisponivel')
        writeDurable(path.join(bundleDir(to), String(i)), buf)
      }
      syncDir(stateDir)
    } catch {
      note('legado-mover-falhou')
      throw fail('indisponivel')
    }
    return { for: b.for, id: b.id, count: b.count }
  }

  // The bundle recorded for `member`, or 'nao-encontrado'.
  function bundleFor (page, member) {
    const row = aclRow(page)
    const b = row.dm ? row.dm.legacyBundle : null
    if (b === null || b.for !== member) throw fail('nao-encontrado')
    return b
  }

  // 'dm-legacy-read' (the caller checked the role): up to
  // BUNDLE_READ_CHUNKS sealed chunks from `from`.
  function legacyRead (page, { member, from } = {}) {
    pageParam(page)
    if (!Number.isSafeInteger(from) || from < 0) throw fail('pedido-invalido')
    return chained(page, async () => {
      const b = bundleFor(page, member)
      const chunks = []
      for (let i = from; i < Math.min(b.count, from + BUNDLE_READ_CHUNKS); i++) {
        const buf = readNoFollow(path.join(bundleDir(page), String(i)))
        if (buf === null) throw fail('indisponivel')
        chunks.push({ index: i, sealed: b4a.toString(buf, 'base64') })
      }
      return { id: b.id, count: b.count, chunks }
    })
  }

  // 'dm-legacy-done': the owner's device imported the bundle. The record
  // goes first, then the chunks (stray chunks without a record are removed
  // at the next start). An absent bundle answers ok.
  function legacyDone (page, { member, id } = {}) {
    pageParam(page)
    if (typeof id !== 'string' || !HEX64_RE.test(id)) throw fail('pedido-invalido')
    return chained(page, async () => {
      check()
      const row = aclRow(page)
      const b = row.dm ? row.dm.legacyBundle : null
      if (b === null) return { ok: true }
      if (b.for !== member || b.id !== id) throw fail('conflito')
      // The cleanup the bundle was recorded for comes first: once the
      // record is gone nothing would remove the old rows and the secret.
      if (row.dm.rotatePending !== null) throw fail('rotacao-necessaria')
      if (legacyHeld(page)) dropLegacy(page)
      const next = JSON.parse(JSON.stringify(row.dm))
      next.legacyBundle = null
      // A moved page's gen 0 row held only the bundle: nothing is left.
      await pagesStore.setDm(page, next.gen === 0 && next.rotatePending === null ? null : next)
      dropBundleFiles(page)
      note('legado-importado')
      return { ok: true }
    })
  }

  // Chunk directories no row names (a crash before the record, a page
  // gone): removed. A bundle a row names is never touched.
  function sweepBundles () {
    if (pagesStore === null) return
    let names = []
    try {
      if (!fs.existsSync(stateDir)) return
      refuseSymlinkDir(stateDir)
      names = fs.readdirSync(stateDir)
    } catch {
      return
    }
    for (const name of names) {
      const page = name.endsWith('.legacy') ? name.slice(0, -7) : null
      if (page === null || !HEX64_RE.test(page)) continue
      let row = null
      try {
        row = pagesStore.get(page)
      } catch {
        continue
      }
      if (row !== null && row.closed === null && row.dm && row.dm.legacyBundle !== null) continue
      try { dropBundleFiles(page) } catch { note('legado-sobra') }
    }
  }

  function followKeys (page) {
    try {
      return writer.follows(page).map((f) => typeof f === 'string' ? f : f && f.key).filter((k) => typeof k === 'string')
    } catch {
      return []
    }
  }

  function folded (page, s) {
    return dmFold.fold({
      self: page,
      followSet: followKeys(page),
      seen: s.seen,
      ops: s.ops,
      messages: s.messages.map((m) => ({ id: m.id, from: m.from, to: m.mine ? m.peer : page, text: m.text, replyTo: m.replyTo, fwd: m.fwd === 1 ? 1 : 0, media: mediaOf(m), card: m.card === undefined ? null : m.card, at: m.at, filedAt: m.filedAt }))
    })
  }

  async function list (page, { folder = 'inbox', limit = 30, before = null } = {}) {
    pageParam(page)
    const s = loadState(page)
    if (s === null) throw fail('nao-encontrado')
    const { inbox, requests } = folded(page, s)
    const all = folder === 'request' ? requests : inbox
    let start = 0
    if (before !== null && before !== undefined) {
      const i = all.findIndex((c) => c.at === before.at && c.peer === before.peer)
      if (i !== -1) {
        start = i + 1
      } else {
        const t = Date.parse(before.at)
        start = all.findIndex((c) => Date.parse(c.at) < t || (Date.parse(c.at) === t && c.peer > before.peer))
        if (start === -1) start = all.length
      }
    }
    const rows = all.slice(start, start + limit)
    const more = start + rows.length < all.length
    const tail = rows[rows.length - 1]
    return {
      conversations: rows.map((c) => {
        const last = c.messages[c.messages.length - 1]
        return { peer: c.peer, folder: c.folder, preview: preview(dmFold.previewText(last)), at: c.at, unread: c.unread, mine: last.mine, legacy: true }
      }),
      next: more && tail ? { at: tail.at, peer: tail.peer } : null,
      requests: requests.some((c) => c.unread),
      inboxUnread: inbox.some((c) => c.unread)
    }
  }

  async function thread (page, { peer, before = null, limit = 30 } = {}) {
    pageParam(page)
    const s = loadState(page)
    if (s === null) throw fail('nao-encontrado')
    const { inbox, requests } = folded(page, s)
    const c = inbox.find((x) => x.peer === peer) || requests.find((x) => x.peer === peer) || null
    const state = { folder: c === null ? 'inbox' : c.folder, blocked: !dmFold.canSend({ self: page, peer, ops: s.ops }) }
    if (c === null) return { messages: [], next: null, ...state }
    let end = c.messages.length
    if (before !== null && before !== undefined) {
      const i = c.messages.findIndex((m) => m.id === before)
      if (i !== -1) end = i
    }
    const startAt = Math.max(0, end - limit)
    const rows = c.messages.slice(startAt, end)
    return {
      messages: rows.map((m) => ({ id: m.id, from: m.from, text: m.text, replyTo: m.replyTo, fwd: m.fwd === 1 ? 1 : 0, media: mediaOf(m), card: m.card === undefined || m.card === null ? null : m.card, at: m.at, mine: m.mine, legacy: true })),
      next: startAt > 0 && rows.length > 0 ? rows[0].id : null,
      ...state
    }
  }

  // A closed page: its legacy rows, legacy secret and legacy bundle go.
  // Idempotent.
  async function forget (page) {
    pageParam(page)
    dropLegacy(page)
    dropBundleFiles(page)
    note('esquecida')
    return { ok: true }
  }

  // ---- the dm-key refresh ---------------------------------------------------

  async function start () {
    if (typeof writer.ready === 'function') await writer.ready()
    sweepBundles()
    // A rotation or a legacy cleanup a crash cut short completes now.
    if (pagesStore !== null && typeof writer.pageKeys === 'function') {
      for (const page of writer.pageKeys()) {
        if (closed) return
        try {
          const row = pagesStore.get(page)
          if (row !== null && row.dm && row.closed === null && !row.paused) await chained(page, () => completeNow(page))
        } catch {
          note('rotacao-pendente')
        }
      }
    }
    if (L.refreshEveryMs > 0 && !closed) {
      timer = setInterval(() => { refresh().catch(noop) }, L.refreshEveryMs)
      if (timer.unref) timer.unref()
    }
  }

  // Public values only: the stored box and gen of every page with dm.
  function refresh () {
    if (refreshing !== null) return refreshing
    const p = (async () => {
      let n = 0
      if (pagesStore === null || typeof writer.pageKeys !== 'function') return n
      for (const page of writer.pageKeys()) {
        if (closed) break
        let row = null
        try {
          row = pagesStore.get(page)
        } catch {}
        if (row === null || !row.dm || row.closed !== null || row.paused) continue
        try {
          const appended = await chained(page, async () => {
            const r = aclRow(page)
            if (!r.dm) return false
            if (r.dm.rotatePending !== null) {
              await completeNow(page)
              return false
            }
            // A moved page's bundle alone: no dm-key yet.
            if (r.dm.gen < 1) return false
            const res = await writer.ensureDmKey(page, { box: r.dm.box, gen: r.dm.gen })
            if (res.seq === null) return false
            // Behind a later route append the ACL is already longer.
            try { await pagesStore.expectLength(page, res.length) } catch {}
            return true
          })
          if (appended) n++
        } catch {
          note('dm-key-falhou')
        }
      }
      return n
    })()
    refreshing = p
    const clear = () => { if (refreshing === p) refreshing = null }
    p.then(clear, clear)
    return p
  }

  async function close () {
    if (closed) return
    closed = true
    clearInterval(timer)
    timer = null
    await starting.catch(noop)
    while (inflight.size > 0) await Promise.allSettled([...inflight])
    if (refreshing !== null) await refreshing.catch(noop)
    master.fill(0)
  }
}

module.exports = { createPagesDm, parseBox, parseInviteShare, REFRESH_EVERY_MS, STATE_DIR }
