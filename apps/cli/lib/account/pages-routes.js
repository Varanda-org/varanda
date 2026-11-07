'use strict'

// The page routes of the account service (mounted by ./server.js), the only
// way anyone acts on a hosted page (docs/protocol.md §12, docs/rpc.md 5.84):
//
//   - GET /account/pages/policy answers { available } even when pages are
//     off, so the app can hide them explicitly.
//   - POST /account/pages/start mints a single-use nonce bound to a member
//     key and one action, with no proof and no state (an HMAC token); for
//     'create' it also answers the new page key, whose pair page-keys.js
//     keeps in memory until the page is written.
//   - every other POST is /account/pages/<action>. A statement action
//     carries the member's diary-key signature over the nonce and the hash
//     of the operation (packages/core/lib/page-proof.js); a record action
//     (accept, remove, offer, transfer-accept) carries the page record the
//     member signed, bound to the same nonce (an offer with `to` and `exp`
//     null is the owner's cancel, appended like any offer). Then the
//     directory link, the
//     current terms and the blocklist; then the ACL of ./pages-store.js.
//   - media and avatar take the raw image as the body and the statement in
//     x-varanda-page-* headers.
//   - close and move are the owner's record actions (docs/protocol.md §12,
//     "Encerrar" and "Mudar de chave"): the owner-signed page-close, or the
//     page-moved, page-origin and K2 genesis roster, countersigned here. At
//     most 2 of them per owner per 24 h. GET /account/pages/successor/<K1>
//     answers K1's countersigned page-moved (in the log, or the detached
//     statement of a page moved while paused) with no session.
//
// Every write to one page runs under one in-process lock: the ACL is read,
// the records are appended by ./pages-writer.js and the ACL is committed in
// that order, so a removed admin's request either ran before the remove or
// answers 'sem-permissao'. A refusal appends nothing. An answer that cannot
// say whether the append happened is { uncertain: true } (202), never a
// refusal the app would retry on its own. The same (member, nonce) applied
// again answers the stored result and writes nothing; the same nonce with
// another body is 'expirado', and the same body while the first use is in
// flight is 'em-andamento' (409: no answer yet, resend later). A use
// whose answer was lost is looked up in the writer's nonce records and the
// ACL's spent nonces before anything runs again, and the nonce MAC key is
// kept in <dir>/page-nonce-key.json (0600, atomic, never through a link,
// never logged) so a resend after a restart still verifies.
//
// Creation runs on one service-wide queue: the owner's page count and the
// @nome are checked there, then the directory reserves the name before any
// issuer-signed username record reaches a diary. Any later failure wipes the
// page and closes it in the directory: the name stays burned, because
// usedNames never shrinks (log token 'nome-queimado').
//
// A pending admin invite is a private statement (no record): its signed
// roster is kept in <dir>/page-invite-rosters.json (0600, atomic) until the
// invitee accepts, because the owner's signature covers the roster's `at`,
// which pages-store.js does not keep.
//
// Logs carry { event: 'pagina', action, reason } only: no key, name, text
// or byte of any request.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { TERMS_VERSION, verifyTerms } = require('@varanda/core/lib/terms')
const { canonicalOp, opHash, verifyPage } = require('@varanda/core/lib/page-proof')
const pageLib = require('@varanda/core/lib/page')
const { createIssuedCert, createUsernameRecord, isPlainObject } = require('@varanda/core/lib/cert')
const { isUsername } = require('@varanda/core/lib/account-link')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { issuerSignLink, verifyClose, verifyMoved, pageLifecycle } = require('@varanda/core/lib/page-lifecycle')
const { applyDeletes } = require('@varanda/core/lib/deletion')
const groupLib = require('@varanda/core/lib/group')
const { MAX_PAGES_PER_OWNER, MAX_PAGE_MOVES } = require('./pages-store')
const {
  postRecord, likeRecord, repostRecord, deleteRecord, profileRecords, followRecord,
  parseRef, validDescriptor, isCanonicalIso, charLength, PAGE_KEYS, MEDIA_BLOCK_BYTES, MAX_MEDIA_ITEM_BLOCKS, MEDIA_MIMES, MAX_AVATAR_BYTES, AVATAR_MIMES
} = require('@varanda/core/lib/records')

const PREFIX = '/account/pages/'
const MAX_BODY = 32 * 1024
const MAX_MEDIA_BODY = MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES
const NONCE_TTL_MS = 600 * 1000
const NONCE_DOMAIN = 'varanda-page-nonce-v1'
const NONCE_BYTES = 32
const MAX_APPLIED = 100000
const MAX_AUDIT = 1000
const MAX_MEDIA_ITEMS = 4
const MAX_OWNED = 8
const MAX_ADMINS = 16
const INVITE_FILE = 'page-invite-rosters.json'
const NONCE_KEY_FILE = 'page-nonce-key.json'
const HEX64_RE = /^[0-9a-f]{64}$/
const HEX128_RE = /^[0-9a-f]{128}$/
const HEX32_RE = /^[0-9a-f]{32}$/
const DM_MAX_TEXT = 1000
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const SUCCESSOR = PREFIX + 'successor/'
// What a close tombstones: everything the page still shows, never a page-*
// record (pages-writer.js DELETABLE).
const CLOSE_DELETES = ['post', 'like', 'repost', 'profile']
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
// Same names as store.js RESERVED (not exported): a page never takes them.
const RESERVED = new Set(['admin', 'associacao', 'association', 'ajuda', 'mod', 'moderacao',
  'pagina', 'paginas', 'root', 'seeder', 'semeador', 'suporte', 'support', 'varanda',
  // The Vitrine handles shown in the varanda.app screenshots (see store.js).
  'andre_costa', 'bia_araujo', 'biblioteca_praca', 'cecilia_ramos',
  'horta_do_bairro', 'joao_nascimento', 'lia_oliveira', 'tomas_ferreira'])

// Conversas as the page (./pages-dm.js, docs/rpc.md 5.77 to 5.80 shapes).
const DM_ACTIONS = ['dm-list', 'dm-thread', 'dm-send', 'dm-set', 'dm-seen']
const DM_READS = ['dm-list', 'dm-thread']
const DM_STATES = ['accepted', 'declined', 'blocked', 'unblocked', 'deleted']
// Communities and groups as the page (./pages-groups.js).
const GROUP_ACTIONS = ['community-join', 'community-leave', 'group-join', 'group-leave', 'group-post', 'group-read']
const GROUP_READ_LIMIT = 32
const STATEMENTS = ['create', 'list', 'status', 'post', 'reply', 'quote', 'delete', 'like', 'repost', 'profile',
  'avatar', 'rename', 'invite', 'follow', 'follows', 'media', 'notices', 'terms', ...DM_ACTIONS, ...GROUP_ACTIONS]
const RECORDS = ['accept', 'remove', 'offer', 'transfer-accept', 'close', 'move']
const START_ACTIONS = [...STATEMENTS, ...RECORDS]
const READS = ['list', 'status', 'follows']
// The newest refs 'status' answers per engagement list, so the answer stays
// inside the app's 1 MiB read cap (about 80 bytes a ref).
const MAX_STATUS_REFS = 4096
const MAX_SUCCESSORS = 1000
// Actions whose whole effect is the writer's append: its nonce record is the
// answer. For the others the ACL step after the append is the effect, so a
// record without a spent nonce is only known to be partial.
const WRITER_ANSWERS = ['create', 'post', 'reply', 'quote', 'delete', 'like', 'repost', 'profile', 'rename', 'follow', 'media', 'avatar']

const WRITER_TOKENS = Object.freeze({
  pausada: 'pausada',
  'chave-ausente': 'pausada',
  'nao-encontrada': 'pedido-invalido',
  existe: 'pedido-invalido',
  limite: 'limite',
  ocupado: 'limite',
  'midia-invalida': 'midia-invalida',
  invalido: 'pedido-invalido',
  'propria-pagina': 'pedido-invalido',
  desligado: 'indisponivel',
  fechado: 'indisponivel',
  movida: 'movida',
  encerrada: 'encerrada'
})
// A terminal page as the writer sees it: a conflict with its state.
const TERMINAL = ['movida', 'encerrada']
const TOKENS = new Set(['nao-vinculado', 'sem-permissao', 'limite', 'nome-em-uso', 'nome-invalido', 'expirado',
  'assinatura-invalida', 'pedido-invalido', 'pausada', 'encerrada', 'midia-invalida', 'indisponivel', 'termos-pendentes',
  'troca-bloqueada', 'nao-encontrado', 'para-si', 'bloqueou', 'sem-caixa', 'sem-selos', 'resposta-invalida', 'longa-demais',
  'fora-da-comunidade', 'aguardando-chave'])

function noop () {}

function has (obj, k) {
  return Object.prototype.hasOwnProperty.call(obj, k)
}

function iso (ms) {
  return new Date(ms).toISOString()
}

function sameList (a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
}

function exactKeys (obj, required, optional = []) {
  if (!isPlainObject(obj)) return false
  const keys = Object.keys(obj)
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k))
}

function sha256Hex (bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

class Uncertain extends Error {}

function createPagesRoutes ({
  store,
  pagesStore = null,
  writer = null,
  keys = null,
  issuerKeyPair = null,
  issuerCert = null,
  association,
  termsStore = null,
  blocklist = null,
  limits = {},
  origin,
  log = noop,
  now = Date.now,
  dir = null,
  pagesDm = null,
  pagesNotices = null,
  pagesGroups = null,
  pagesDelegate = null,
  http
} = {}) {
  const { send, sendError, readJsonBody, checkPost, checkRawPost, RouteError, refuse, fromStore, keyedWindow } = http
  const on = keys !== null && keys.enabled === true && writer !== null && pagesStore !== null && issuerKeyPair !== null && issuerCert !== null
  // pagesNotices reads the page's notices, pagesDelegate confirms a core
  // node's delegate, pagesDm runs the page's Conversas; pagesGroups is where
  // communities plug in.

  const caps = {
    create: limits.create || keyedWindow(3, DAY, now),
    ops: limits.ops || keyedWindow(60, 600 * 1000, now),
    media: limits.media || keyedWindow(20, HOUR, now),
    avatar: limits.avatar || keyedWindow(10, HOUR, now),
    // One load of the app follows `next` up to 4 times: a burst of 8 a
    // minute per page leaves room for two loads.
    notices: limits.notices || keyedWindow(8, 60 * 1000, now),
    // 'terms' is the only action whose diary the caller picks, so it is the
    // one that can start a seeder read for an unknown diary: per actor and
    // for the whole host, both checked before the nonce is claimed.
    terms: limits.terms || keyedWindow(5, 600 * 1000, now),
    termsAll: limits.termsAll || keyedWindow(20, 60 * 1000, now),
    successor: limits.successor || keyedWindow(120, 60 * 1000, now),
    // An extra limit only (tests); chargeLifecycle keeps the 2 per day.
    lifecycle: limits.lifecycle || (() => true)
  }

  const secret = on ? loadSecret() : nodeCrypto.randomBytes(32)
  // Read nonces are spent in memory only: a read whose nonce was minted
  // before this process started is refused, so a captured read cannot be
  // replayed after a restart within its TTL. The client asks again with a
  // fresh nonce.
  const startedAt = now()
  // Actors with a 'terms' acceptance in flight: one at a time each.
  const termsRunning = new Set()
  // K1 -> its verified page-moved: terminal, so it never changes.
  const successors = new Map()
  // '<member>:<nonce>' -> { hash, result, busy, expiresAt }: result null
  // while in flight (busy) or after a failure.
  const applied = new Map()
  const locks = new Map()
  let creating = Promise.resolve()
  const audit = []
  const counts = { ok: 0, refused: 0, uncertain: 0 }
  const invites = loadInvites()
  // '<member>:<nonce>' of the closes and moves charged to the lifecycle cap,
  // so a resend of the same use is not charged again.
  const charged = new Map()
  // K1 -> the communities its move left, for a resumed move's re-join on K2.
  const moveLeft = new Map()

  // ---- helpers ----------------------------------------------------------

  // The file's bytes, never through a link nor blocking on a FIFO; null when
  // it does not exist.
  function readNoFollow (file) {
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
    let fd
    try {
      fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('not a file')
      return fs.readFileSync(fd, 'utf8')
    } finally {
      fs.closeSync(fd)
    }
  }

  // A file that is not this module's is kept as found and the key lives in
  // memory only, so tokens minted before a restart then answer 'expirado'.
  function loadSecret () {
    if (dir === null) return nodeCrypto.randomBytes(32)
    const file = path.join(dir, NONCE_KEY_FILE)
    try {
      refuseSymlinkDir(dir)
      const raw = readNoFollow(file)
      if (raw !== null) {
        const data = JSON.parse(raw)
        if (isPlainObject(data) && data.v === 1 && typeof data.key === 'string' && HEX64_RE.test(data.key)) return Buffer.from(data.key, 'hex')
        throw new Error('invalid')
      }
      const key = nodeCrypto.randomBytes(32)
      writeJsonAtomic(file, { v: 1, key: key.toString('hex') }, 0o600)
      return key
    } catch {
      log({ event: 'pagina', action: 'nonce-key', reason: 'indisponivel' })
      return nodeCrypto.randomBytes(32)
    }
  }

  function note (action, reason) {
    log({ event: 'pagina', action, reason })
  }

  function keep (page, action, member, seq) {
    audit.push({ page, action, member, seq })
    if (audit.length > MAX_AUDIT) audit.shift()
  }

  function tokenOf (err) {
    if (err instanceof RouteError || err instanceof Uncertain) return err
    const code = err && typeof err.code === 'string' ? err.code : null
    if (code !== null && TERMINAL.includes(code)) return new RouteError(code, 409)
    if (code !== null && has(WRITER_TOKENS, code)) return refuse(WRITER_TOKENS[code])
    if (code === 'troca-bloqueada') return fromStore(err)
    if (code !== null && TOKENS.has(code)) return refuse(code)
    return refuse('indisponivel')
  }

  function keyParam (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  // random 12 bytes || expiry (uint32 seconds) || HMAC-SHA256 prefix of 16.
  function tag (member, action, random, expiry) {
    return nodeCrypto.createHmac('sha256', secret)
      .update(NONCE_DOMAIN + '\n' + member + '\n' + action + '\n')
      .update(random)
      .update(expiry)
      .digest()
      .subarray(0, 16)
  }

  function mintNonce (member, action) {
    const random = nodeCrypto.randomBytes(12)
    const expiry = Buffer.alloc(4)
    expiry.writeUInt32BE(Math.floor((now() + NONCE_TTL_MS) / 1000))
    return Buffer.concat([random, expiry, tag(member, action, random, expiry)]).toString('base64url')
  }

  // True when the nonce surely was minted before this process started: its
  // expiry is whole seconds, so the mint time lies in [expiry - TTL,
  // expiry - TTL + 1 s).
  function mintedBefore (nonce) {
    const buf = Buffer.from(nonce, 'base64url')
    if (buf.length !== NONCE_BYTES) return true
    return buf.readUInt32BE(12) * 1000 - NONCE_TTL_MS + 1000 <= startedAt
  }

  function validNonce (nonce, member, action) {
    if (typeof nonce !== 'string' || !TOKEN_RE.test(nonce)) return false
    const buf = Buffer.from(nonce, 'base64url')
    if (buf.length !== NONCE_BYTES || buf.toString('base64url') !== nonce) return false
    const random = buf.subarray(0, 12)
    const expiry = buf.subarray(12, 16)
    if (!nodeCrypto.timingSafeEqual(buf.subarray(16), tag(member, action, random, expiry))) return false
    return expiry.readUInt32BE(0) * 1000 > now()
  }

  function blocked (key) {
    if (blocklist === null) return false
    try {
      return blocklist.has(key) === true
    } catch {
      throw refuse('indisponivel')
    }
  }

  function isLinked (member) {
    let st
    try {
      st = store.status(member)
    } catch {
      throw refuse('indisponivel')
    }
    return Boolean(st) && st.linked === true
  }

  // A recipient of an invite or an offer: a link with the current terms, or
  // a core node's delegate actor whose stored row has them.
  function linked (member) {
    if (isLinked(member)) {
      if (termsStore === null || !termsStore.available()) throw refuse('indisponivel')
      let accepted
      try {
        accepted = termsStore.list(member).some((e) => e.version === TERMS_VERSION)
      } catch {
        throw refuse('indisponivel')
      }
      if (!accepted) throw refuse('termos-pendentes')
      return
    }
    let row = null
    try {
      row = pagesStore.delegate(member)
    } catch {
      throw refuse('indisponivel')
    }
    if (row === null || row.termsVersion !== TERMS_VERSION) throw refuse('nao-vinculado')
    if (blocked(member) || blocked(row.diary)) throw refuse('sem-permissao')
  }

  // A member is a directory link with the current terms, not blocked; or,
  // absent from the links, a core node's delegate actor (docs/protocol.md
  // §12, "Nó core: delegado"). A linked member never takes the delegate
  // path, whatever a diary names. -> null for a link, { diary, length } for
  // a delegate. `terms` false is the 'terms' action itself: a delegate whose
  // acceptance is being recorded, never a link (those accept through
  // /account/terms).
  async function authMember (member, { diary = null, terms = true } = {}) {
    if (!isLinked(member)) return delegateOf(member, diary, terms)
    if (!terms) throw refuse('pedido-invalido')
    if (termsStore === null || !termsStore.available()) throw refuse('indisponivel')
    let accepted
    try {
      accepted = termsStore.list(member).some((e) => e.version === TERMS_VERSION)
    } catch {
      throw refuse('indisponivel')
    }
    if (!accepted) throw refuse('termos-pendentes')
    if (blocked(member)) throw refuse('sem-permissao')
    return null
  }

  // The diary comes from the op ('terms') or the stored delegate row; the
  // current terms are the actor's, recorded with that same diary. The
  // replication check (cert under the revoked issuers, the newest
  // page-delegate naming the actor) runs on every request, cached for a
  // minute by pages-delegate.js.
  async function delegateOf (actor, opDiary, needTerms) {
    if (pagesDelegate === null) throw refuse('nao-vinculado')
    let row
    try {
      row = pagesStore.delegate(actor)
    } catch {
      throw refuse('indisponivel')
    }
    const diary = opDiary !== null ? opDiary : row === null ? null : row.diary
    if (diary === null) throw refuse('nao-vinculado')
    // A linked person's diary never takes a delegate: that would be a second
    // actor identity, with caps of its own.
    if (isLinked(diary)) throw refuse('pedido-invalido')
    // Nor a deleted one (Excluir conta), before the blocklist reaches it.
    if (typeof store.deletedAt === 'function' && store.deletedAt(diary) !== null) throw refuse('nao-vinculado')
    if (needTerms && (row === null || row.diary !== diary || row.termsVersion !== TERMS_VERSION)) throw refuse('termos-pendentes')
    if (blocked(actor) || blocked(diary)) throw refuse('sem-permissao')
    let v
    try {
      v = await pagesDelegate.verify({ actor, diary, probe: opDiary !== null })
    } catch {
      throw refuse('indisponivel')
    }
    if (!v || v.ok !== true) {
      const reason = v && v.reason
      if (reason === 'bloqueado') throw refuse('sem-permissao')
      if (reason === 'nao-certificado' || reason === 'delegado-desconhecido') throw refuse('nao-vinculado')
      throw refuse('indisponivel')
    }
    return { diary, length: v.length }
  }

  function withLock (key, fn) {
    const prev = locks.get(key) || Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(noop, noop)
    locks.set(key, tail)
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
    return run
  }

  function sweepApplied () {
    const t = now()
    for (const [k, v] of applied) if (v.expiresAt <= t) applied.delete(k)
  }

  // What the writer and the ACL durably hold of an earlier use, or null.
  function durable (member, nonce, page, action) {
    let rec = null
    if (page !== '') {
      try {
        rec = writer.nonceRecord(page, member, nonce)
      } catch (err) {
        if (!err || (err.code !== 'nao-encontrada' && err.code !== 'invalido')) throw refuse('indisponivel')
      }
    }
    let seq = null
    try {
      seq = pagesStore.spent(member, nonce)
    } catch {
      throw refuse('indisponivel')
    }
    if (rec !== null && WRITER_ANSWERS.includes(action)) {
      if (action === 'media') {
        if (rec.media !== null) return { descriptor: rec.media.descriptor }
      } else {
        const a = rec.append || rec.follow
        if (a !== null) {
          const out = { seq: a.seq, length: a.length, pushed: false, replay: true }
          if (action === 'create') out.page = page
          if (action === 'avatar') {
            if (rec.media === null) throw new Uncertain()
            out.descriptor = rec.media.descriptor
          }
          return out
        }
      }
    }
    if (seq !== null) {
      const out = { seq, replay: true }
      if (action === 'move') {
        const r = pagesStore.get(page)
        if (r !== null && r.movedTo !== null) out.page = r.movedTo
      }
      return out
    }
    if (rec !== null && (rec.append !== null || rec.follow !== null)) throw new Uncertain()
    return null
  }

  // -> null (run it) or the stored answer of the same request. Throws
  // 'expirado' for another body or a read's resend, 'em-andamento' while the
  // same write is in flight. A use that failed runs
  // again only when neither the writer nor the ACL holds anything of it.
  function claim (member, nonce, hash, read, page = '', action = '') {
    const id = member + ':' + nonce
    if (read && mintedBefore(nonce)) throw refuse('expirado')
    const prior = applied.get(id)
    if (prior !== undefined) {
      if (prior.hash !== hash || read) throw refuse('expirado')
      if (prior.busy) throw new RouteError('em-andamento', 409)
      if (prior.result !== null) return prior.result
    }
    if (!read) {
      const found = durable(member, nonce, page, action)
      if (found !== null) return found
    }
    if (prior !== undefined) {
      prior.busy = true
      return null
    }
    sweepApplied()
    if (applied.size >= MAX_APPLIED) throw refuse('limite')
    applied.set(id, { hash, result: null, busy: !read, expiresAt: now() + NONCE_TTL_MS })
    return null
  }

  // Runs fn for a claimed nonce; it is no longer in flight once fn settles.
  function once (member, nonce, fn) {
    return Promise.resolve().then(fn).finally(() => {
      const v = applied.get(member + ':' + nonce)
      if (v !== undefined) v.busy = false
    })
  }

  function settle (member, nonce, result) {
    const v = applied.get(member + ':' + nonce)
    if (v !== undefined) v.result = result
  }

  function rowOf (page) {
    let row
    try {
      row = pagesStore.get(page)
    } catch {
      throw refuse('indisponivel')
    }
    if (row === null) throw refuse('pedido-invalido')
    return row
  }

  function writableRow (page) {
    const row = rowOf(page)
    if (row.movedTo !== null) throw new RouteError('movida', 409)
    if (row.closed !== null) throw refuse('encerrada')
    if (row.paused) throw refuse('pausada')
    if (blocked(page)) throw refuse('sem-permissao')
    return row
  }

  function roleOf (row, member) {
    if (row.owner === member) return 'owner'
    if (row.admins.includes(member)) return 'admin'
    return null
  }

  function need (row, member, role) {
    const got = roleOf(row, member)
    if (got === null || (role === 'owner' && got !== 'owner')) throw refuse('sem-permissao')
  }

  // At most 2 closes or moves per owner per 24 h: a use is charged once,
  // however often it is resent, and a definite refusal gives it back.
  function chargeLifecycle (member, nonce) {
    const id = member + ':' + nonce
    const t = now()
    for (const [k, at] of charged) if (t - at >= DAY) charged.delete(k)
    if (charged.has(id)) return
    let used = 0
    for (const [k, at] of charged) if (k.startsWith(member + ':') && t - at < DAY) used++
    if (used >= 2 || !caps.lifecycle(member)) throw refuse('limite')
    if (charged.size >= MAX_APPLIED) charged.delete(charged.keys().next().value)
    charged.set(id, t)
  }

  function refundLifecycle (member, nonce, err) {
    if (!(err instanceof Uncertain)) charged.delete(member + ':' + nonce)
  }

  function chargeOps (page) {
    if (!caps.ops(page)) throw refuse('limite')
  }

  // The writer's own refusals happen before anything is appended; any other
  // failure may have appended.
  async function append (page, records, idem) {
    try {
      return await writer.append(page, records, idem)
    } catch (err) {
      if (err && typeof err.code === 'string' && has(WRITER_TOKENS, err.code)) throw tokenOf(err)
      throw new Uncertain()
    }
  }

  // After the append succeeded: a failed commit leaves the ACL behind the
  // diary, so the outcome is unknown to the caller.
  async function after (fn) {
    try {
      return await fn()
    } catch {
      note('commit', 'armazenamento-indisponivel')
      throw new Uncertain()
    }
  }

  function spendOf (member, nonce, seq) {
    return { member, nonce, seq }
  }

  // The newest roster again once it is not within the newest 256 blocks
  // (the dm-key rule), so a bounded reader still finds it.
  async function refreshRoster (page) {
    const row = rowOf(page)
    if (row.length - row.rosterSeq < pageLib.PAGE_ROSTER_REFRESH_BLOCKS - 8) return
    try {
      const entries = await writer.readEntries(page)
      const e = entries.find((x) => x.seq === row.rosterSeq)
      if (!e || !isPlainObject(e.record) || e.record.type !== 'page-roster') return
      const res = await writer.append(page, [e.record])
      await pagesStore.setRoster(page, { gen: row.gen, seq: res.seq, owner: row.owner, admins: row.admins })
      await pagesStore.expectLength(page, res.length)
    } catch {
      note('roster', 'refresh-falhou')
    }
  }

  // The issuer countersigns an owner-signed roster; a bad owner signature
  // or any other field is a refusal.
  function countersign (record, page) {
    if (!isPlainObject(record) || record.type !== 'page-roster' || record.page !== page) throw refuse('pedido-invalido')
    for (const k of Object.keys(record)) if (!PAGE_KEYS['page-roster'].includes(k)) throw refuse('pedido-invalido')
    const fields = {}
    for (const k of ['type', 'page', 'gen', 'owner', 'admins', 'prev', 'at', 'nonce', 'signature']) {
      if (!has(record, k)) throw refuse('pedido-invalido')
      fields[k] = record[k]
    }
    if (has(record, 'association') && record.association !== association) throw refuse('pedido-invalido')
    fields.association = association
    let out
    try {
      out = pageLib.issuerCountersign(fields, issuerKeyPair, issuerCert)
    } catch {
      throw refuse('assinatura-invalida')
    }
    if (!pageLib.verifyRoster(out, page, association).ok) throw refuse('assinatura-invalida')
    return out
  }

  // The issuer countersigns an owner-signed page-origin, page-close or
  // page-moved of `page`, as countersign() does a roster.
  function countersignAs (record, page, type) {
    if (!isPlainObject(record) || record.type !== type || record.page !== page) throw refuse('pedido-invalido')
    for (const k of Object.keys(record)) if (!PAGE_KEYS[type].includes(k)) throw refuse('pedido-invalido')
    if (has(record, 'association') && record.association !== association) throw refuse('pedido-invalido')
    const fields = {}
    for (const k of PAGE_KEYS[type]) if (has(record, k)) fields[k] = record[k]
    fields.association = association
    try {
      return pageLib.issuerCountersign(fields, issuerKeyPair, issuerCert)
    } catch {
      throw refuse('assinatura-invalida')
    }
  }

  // ---- invite rosters sidecar ---------------------------------------------

  function invitePath () {
    return dir === null ? null : path.join(dir, INVITE_FILE)
  }

  function loadInvites () {
    const map = new Map()
    const file = invitePath()
    if (file === null) return map
    let data = null
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return map
    }
    if (!isPlainObject(data) || data.v !== 1 || !isPlainObject(data.rows)) return map
    for (const [k, v] of Object.entries(data.rows)) {
      if (isPlainObject(v) && isPlainObject(v.record) && typeof v.expiresAt === 'string') map.set(k, v)
    }
    return map
  }

  function saveInvites () {
    const file = invitePath()
    if (file === null) return
    const t = now()
    const rows = {}
    for (const [k, v] of invites) {
      if (Date.parse(v.expiresAt) > t) rows[k] = v
      else invites.delete(k)
    }
    writeJsonAtomic(file, { v: 1, rows }, 0o600)
  }

  // ---- start --------------------------------------------------------------

  function start (body) {
    const member = keyParam(body.member)
    const action = body.action
    if (typeof action !== 'string' || !START_ACTIONS.includes(action)) throw refuse('pedido-invalido')
    if (DM_ACTIONS.includes(action) && pagesDm === null) throw refuse('pedido-invalido')
    if ((action === 'notices' && pagesNotices === null) || (action === 'terms' && pagesDelegate === null)) throw refuse('indisponivel')
    if (GROUP_ACTIONS.includes(action) && pagesGroups === null) throw refuse('indisponivel')
    const nonce = mintNonce(member, action)
    if (action !== 'create' && action !== 'move') return { nonce }
    let pending
    try {
      pending = keys.pending(nonce)
    } catch (err) {
      throw tokenOf(err)
    }
    pending.row.secretKey.fill(0)
    pending.row.mediaSecretKey.fill(0)
    // A move's K2, minted like a creation's page key.
    return action === 'create' ? { nonce, page: pending.key } : { nonce, to: pending.key }
  }

  // ---- proofs -------------------------------------------------------------

  // `auth` false leaves the member check to the caller ('terms').
  async function statement (body, action, pageless, auth = true) {
    const member = keyParam(body.member)
    const page = pageless ? '' : keyParam(body.page)
    const nonce = body.nonce
    if (!validNonce(nonce, member, action)) throw refuse('expirado')
    let op
    try {
      op = JSON.parse(canonicalOp(body.op))
    } catch {
      throw refuse('pedido-invalido')
    }
    const hash = opHash(op)
    if (!verifyPage({ action, nonce, member, page, association, opHash: hash }, body.signature).ok) {
      throw refuse('assinatura-invalida')
    }
    const delegate = auth ? await authMember(member) : null
    return { member, page, nonce, op, hash, delegate }
  }

  async function recordProof (body, action, type) {
    const member = keyParam(body.member)
    const page = keyParam(body.page)
    const nonce = body.nonce
    if (!validNonce(nonce, member, action)) throw refuse('expirado')
    const record = body.record
    if (!isPlainObject(record) || record.type !== type || record.page !== page || record.nonce !== nonce) throw refuse('pedido-invalido')
    let hash
    try {
      hash = opHash(record)
    } catch {
      throw refuse('pedido-invalido')
    }
    const signer = type === 'page-roster' ? record.owner : record.actor
    if (signer !== member) throw refuse('sem-permissao')
    if (type === 'page-accept' && !pageLib.verifyAccept(record, page).ok) throw refuse('assinatura-invalida')
    if (type === 'page-offer' && !pageLib.verifyOffer(record, page).ok) throw refuse('assinatura-invalida')
    await authMember(member)
    return { member, page, nonce, record, hash }
  }

  // ---- create -------------------------------------------------------------

  async function create (body) {
    const { member, page, nonce, op, hash, delegate } = await statement(body, 'create', false)
    if (!exactKeys(op, ['username', 'name', 'bio', 'roster']) || !exactKeys(op.roster, ['gen', 'admins', 'prev', 'at', 'nonce'])) {
      throw refuse('pedido-invalido')
    }
    const { username, name, bio, roster } = op
    if (roster.gen !== 1 || !sameList(roster.admins, []) || roster.prev !== null) throw refuse('pedido-invalido')
    const record = body.record
    if (!isPlainObject(record) || record.owner !== member || record.gen !== 1 || !sameList(record.admins, []) ||
        record.prev !== null || record.at !== roster.at || record.nonce !== roster.nonce || record.nonce !== nonce) {
      throw refuse('pedido-invalido')
    }
    if (typeof username !== 'string' || !isUsername(username) || RESERVED.has(username)) throw refuse('nome-invalido')
    let profile
    try {
      profile = profileRecords({ name, bio })
    } catch {
      throw refuse('pedido-invalido')
    }
    const prior = claim(member, nonce, hash, false, page, 'create')
    if (prior !== null) return prior
    return once(member, nonce, async () => {
      let pending
      try {
        pending = keys.pending(nonce)
      } catch (err) {
        throw tokenOf(err)
      }
      if (pending.key !== page) {
        pending.row.secretKey.fill(0)
        pending.row.mediaSecretKey.fill(0)
        throw refuse('expirado')
      }
      if (!caps.create(member)) {
        pending.row.secretKey.fill(0)
        pending.row.mediaSecretKey.fill(0)
        throw refuse('limite')
      }
      return withCreate(() => withLock(page, async () => {
        try {
          const rosterRecord = countersign(record, page)
          let owned
          try {
            if (store.lookup(username) !== null) throw refuse('nome-em-uso')
            owned = pagesStore.listFor(member).owned.filter((p) => !p.closed).length
            if (pagesStore.isPage(member)) throw refuse('sem-permissao')
          } catch (err) {
            throw tokenOf(err)
          }
          if (owned >= MAX_PAGES_PER_OWNER) throw refuse('limite')
          if (blocked(member)) throw refuse('sem-permissao')
          const date = iso(now())
          const cert = createIssuedCert({ member: page, date }, issuerKeyPair, issuerCert)
          const usernameRecord = createUsernameRecord({ member: page, username, date }, issuerKeyPair, issuerCert)
          try {
            await store.reservePage({ key: page, username, usernameRecord, cert })
          } catch (err) {
            throw tokenOf(err)
          }
          try {
            keys.put(page, pending.row)
            await writer.createPage({ cert, usernameRecord, rosterRecord })
            // A core delegate owner: readers show its diary's profile for
            // the actor (verifyLink, page-lifecycle.js), right after the
            // genesis roster.
            if (delegate !== null) {
              const link = issuerSignLink({ page, diary: delegate.diary, actor: member, at: date, nonce }, issuerKeyPair, issuerCert)
              await writer.append(page, [link])
            }
            await pagesStore.create({ page, owner: member })
            const res = await writer.append(page, profile, { member, nonce })
            await pagesStore.expectLength(page, res.length, { spend: spendOf(member, nonce, res.seq) })
            const result = { page, seq: res.seq, length: res.length, pushed: res.pushed }
            settle(member, nonce, result)
            keep(page, 'create', member, res.seq)
            // The page's box and dm-key: on the writer's chain, after this
            // answer; the pool's next pass retries a failure.
            if (pagesDm !== null) pagesDm.enable(page).catch(() => note('create', 'conversas-pendentes'))
            return result
          } catch (err) {
            await burn(page)
            // Wiped: whatever happened, there is no page, so never 'uncertain'.
            const e = tokenOf(err)
            throw e instanceof Uncertain ? refuse('indisponivel') : e
          }
        } finally {
          pending.row.secretKey.fill(0)
          pending.row.mediaSecretKey.fill(0)
        }
      }))
    })
  }

  function withCreate (fn) {
    const run = creating.then(fn, fn)
    creating = run.then(noop, noop)
    return run
  }

  // A creation that failed after the directory reserved its name: the page
  // is wiped (unannounced, out of the writer, keys gone) and closed in the
  // directory and the ACL. The name is not freed: usedNames never shrinks.
  async function burn (page) {
    note('create', 'nome-queimado')
    try {
      await writer.wipe(page)
    } catch {
      note('create', 'limpeza-falhou')
    }
    try { await pagesStore.close(page) } catch {}
    try { await store.closePage({ key: page }) } catch {}
  }

  // ---- posts and engagement ------------------------------------------------

  function mediaOf (page, media) {
    if (media === undefined) return undefined
    if (!Array.isArray(media) || media.length < 1 || media.length > MAX_MEDIA_ITEMS) throw refuse('midia-invalida')
    let table
    try {
      table = writer.items(page)
    } catch (err) {
      throw tokenOf(err)
    }
    const same = (a, b) => ['core', 'start', 'blocks', 'sha256', 'mime', 'bytes', 'width', 'height'].every((k) => a[k] === b[k])
    return media.map((d) => {
      if (!isPlainObject(d) || !validDescriptor(d)) throw refuse('midia-invalida')
      const row = table.find((it) => it.core === d.core && it.start === d.start && it.blocks === d.blocks && it.sha256 === d.sha256)
      if (row === undefined || !same(row, d)) throw refuse('midia-invalida')
      return row
    })
  }

  function target (ref) {
    const t = parseRef(ref)
    if (t === null) throw refuse('pedido-invalido')
    return t
  }

  async function recordsFor (action, page, op) {
    try {
      if (action === 'post') {
        if (!exactKeys(op, ['text'], ['media'])) throw refuse('pedido-invalido')
        return [postRecord({ text: op.text, media: mediaOf(page, op.media) })]
      }
      if (action === 'reply') {
        if (!exactKeys(op, ['to', 'text'], ['media'])) throw refuse('pedido-invalido')
        return [postRecord({ text: op.text, replyTo: target(op.to), media: mediaOf(page, op.media) })]
      }
      if (action === 'quote') {
        if (!exactKeys(op, ['to', 'text'], ['media'])) throw refuse('pedido-invalido')
        return [postRecord({ text: op.text, quote: target(op.to), media: mediaOf(page, op.media) })]
      }
      if (action === 'like' || action === 'repost') {
        if (!exactKeys(op, ['to', 'on']) || typeof op.on !== 'boolean') throw refuse('pedido-invalido')
        const build = action === 'like' ? likeRecord : repostRecord
        return [build({ to: target(op.to), on: op.on })]
      }
      if (action === 'delete') {
        if (!exactKeys(op, ['to'])) throw refuse('pedido-invalido')
        const t = target(op.to)
        if (t.author !== page) throw refuse('pedido-invalido')
        const entries = await writer.readEntries(page)
        const e = entries.find((x) => x.seq === t.seq)
        // Never a tombstone over a page record: a delete must not undo a
        // roster, an accept or an offer.
        if (!e || !isPlainObject(e.record) || !['post', 'like', 'repost'].includes(e.record.type)) throw refuse('pedido-invalido')
        const media = Array.isArray(e.record.media) ? e.record.media.map((d) => ({ core: d.core, start: d.start, blocks: d.blocks })) : undefined
        return [deleteRecord({ seq: t.seq, media })]
      }
      if (action === 'profile') {
        if (!exactKeys(op, ['name', 'bio'], ['avatar'])) throw refuse('pedido-invalido')
        const avatar = op.avatar === undefined || op.avatar === null ? null : mediaOf(page, [op.avatar])[0]
        return profileRecords({ name: op.name, bio: op.bio, avatar })
      }
    } catch (err) {
      if (err instanceof RouteError) throw err
      if (err && typeof err.code === 'string' && has(WRITER_TOKENS, err.code)) throw tokenOf(err)
      throw refuse('pedido-invalido')
    }
    throw refuse('pedido-invalido')
  }

  // A statement whose records the page appends: owner or admin.
  async function write (action, body) {
    const { member, page, nonce, op, hash } = await statement(body, action, false)
    const prior = claim(member, nonce, hash, false, page, action)
    if (prior !== null) return prior
    return once(member, nonce, () => withLock(page, async () => {
      const row = writableRow(page)
      need(row, member, 'admin')
      chargeOps(page)
      const records = await recordsFor(action, page, op)
      await refreshRoster(page)
      const res = await append(page, records, { member, nonce })
      await after(() => pagesStore.expectLength(page, res.length, { spend: spendOf(member, nonce, res.seq) }))
      const result = { seq: res.seq, length: res.length, pushed: res.pushed }
      settle(member, nonce, result)
      keep(page, action, member, res.seq)
      return result
    }))
  }

  async function rename (body) {
    const { member, page, nonce, op, hash } = await statement(body, 'rename', false)
    if (!exactKeys(op, ['username'])) throw refuse('pedido-invalido')
    const username = op.username
    if (typeof username !== 'string' || !isUsername(username) || RESERVED.has(username)) throw refuse('nome-invalido')
    const prior = claim(member, nonce, hash, false, page, 'rename')
    if (prior !== null) return prior
    return once(member, nonce, () => withLock(page, async () => {
      const row = writableRow(page)
      need(row, member, 'owner')
      // The directory change cannot be undone, so a diary that cannot take
      // the new username record is refused before it.
      let paused
      try {
        paused = writer.info(page).paused === true
      } catch (err) {
        throw tokenOf(err)
      }
      if (paused) throw refuse('pausada')
      chargeOps(page)
      const record = createUsernameRecord({ member: page, username, date: iso(now()) }, issuerKeyPair, issuerCert)
      let renamed
      try {
        renamed = await store.renamePage({ key: page, username, usernameRecord: record })
      } catch (err) {
        throw tokenOf(err)
      }
      let res
      try {
        res = await writer.append(page, [renamed.record], { member, nonce })
      } catch {
        // The directory already names the page by the new @nome and the
        // diary may not: the page stops until an operator looks.
        try { await pagesStore.pause(page) } catch {}
        note('rename', 'pausada-incerta')
        throw new Uncertain()
      }
      await after(() => pagesStore.expectLength(page, res.length, { spend: spendOf(member, nonce, res.seq) }))
      const result = { seq: res.seq, length: res.length, pushed: res.pushed, nextChangeAt: renamed.nextChangeAt }
      settle(member, nonce, result)
      keep(page, 'rename', member, res.seq)
      return result
    }))
  }

  async function follow (body) {
    const { member, page, nonce, op, hash } = await statement(body, 'follow', false)
    if (!exactKeys(op, ['key', 'on']) || typeof op.on !== 'boolean') throw refuse('pedido-invalido')
    const key = keyParam(op.key)
    if (key === page) throw refuse('pedido-invalido')
    const prior = claim(member, nonce, hash, false, page, 'follow')
    if (prior !== null) return prior
    return once(member, nonce, () => withLock(page, async () => {
      const row = writableRow(page)
      need(row, member, 'admin')
      if (op.on && blocked(key)) throw refuse('sem-permissao')
      chargeOps(page)
      await refreshRoster(page)
      let res
      try {
        res = await writer.setFollow(page, key, op.on, { member, nonce })
      } catch (err) {
        if (err && typeof err.code === 'string' && has(WRITER_TOKENS, err.code)) throw tokenOf(err)
        throw new Uncertain()
      }
      await after(async () => {
        await pagesStore.setFollows(page, res.follows.length)
        await pagesStore.expectLength(page, res.length, { spend: spendOf(member, nonce, res.seq) })
      })
      const result = { seq: res.seq, length: res.length, pushed: res.pushed }
      settle(member, nonce, result)
      keep(page, 'follow', member, res.seq)
      return result
    }))
  }

  // ---- signed reads ---------------------------------------------------------

  async function read (action, body) {
    const pageless = action === 'list'
    const { member, page, nonce, op, hash } = await statement(body, action, pageless)
    if (!exactKeys(op, [])) throw refuse('pedido-invalido')
    claim(member, nonce, hash, true)
    try {
      if (action === 'list') return pagesStore.listFor(member)
      const row = rowOf(page)
      need(row, member, 'admin')
      if (action === 'follows') return { follows: writer.follows(page) }
      const eng = await writer.engagement(page)
      const liked = [...eng.liked]
      const reposted = [...eng.reposted.keys()]
      const t = now()
      return {
        owner: row.owner,
        admins: row.admins,
        invites: Object.entries(row.invites).filter(([, v]) => Date.parse(v.expiresAt) > t).map(([m, v]) => ({ member: m, gen: v.gen, expiresAt: v.expiresAt })),
        offer: row.offer,
        gen: row.gen,
        length: row.length,
        engagement: {
          liked: liked.slice(-MAX_STATUS_REFS),
          reposted: reposted.slice(-MAX_STATUS_REFS),
          truncated: liked.length > MAX_STATUS_REFS || reposted.length > MAX_STATUS_REFS
        },
        follows: row.follows,
        closed: row.closed !== null,
        movedTo: row.movedTo,
        communities: (row.writers || []).filter((w) => w.kind === 'community').map((w) => ({ community: w.group, role: w.state }))
      }
    } catch (err) {
      throw tokenOf(err)
    }
  }

  // The page's notices (docs/rpc.md 5.28 shape) for its owner or admins: a
  // signed read, so a lost answer is asked again with a fresh nonce. The
  // role is checked under the page lock before the reader opens anything.
  async function notices (body) {
    if (pagesNotices === null) throw refuse('indisponivel')
    const { member, page, nonce, op, hash } = await statement(body, 'notices', false)
    if (!exactKeys(op, [], ['after', 'limit'])) throw refuse('pedido-invalido')
    claim(member, nonce, hash, true)
    await withLock(page, () => {
      const row = rowOf(page)
      if (row.movedTo !== null) throw new RouteError('movida', 409)
      if (row.closed !== null) throw refuse('encerrada')
      if (blocked(page)) throw refuse('sem-permissao')
      need(row, member, 'admin')
      if (!caps.notices(page)) throw refuse('limite')
    })
    let result
    try {
      result = await pagesNotices.read(page, { after: op.after === undefined ? null : op.after, limit: op.limit })
    } catch (err) {
      throw tokenOf(err)
    }
    // An admin removed while the read ran gets nothing of it.
    if (!stillAdmin(page, member)) throw refuse('sem-permissao')
    return result
  }

  // The checks of a read or a send as the page, run again once the network
  // step is done: a live, unblocked page whose ACL still names the member.
  function stillAdmin (page, member, { paused = false } = {}) {
    try {
      const row = pagesStore.get(page)
      if (row === null || row.movedTo !== null || row.closed !== null || blocked(page)) return false
      if (paused && pausedNow(page, row)) return false
      return roleOf(row, member) !== null
    } catch {
      return false
    }
  }

  // A core delegate accepts the current terms: op { version, diary }, the
  // statement signed by the actor and body.termsSignature its signature
  // over the terms payload (packages/core/lib/terms.js) with this nonce.
  // The acceptance is kept under the actor in terms.json and the delegate
  // row in the pages ACL; nothing goes to the directory links. Answered as
  // a read: running it again with a fresh nonce records the same.
  async function acceptTerms (body) {
    if (pagesDelegate === null) throw refuse('indisponivel')
    const { member, nonce, op, hash } = await statement(body, 'terms', true, false)
    if (!exactKeys(op, ['version', 'diary'])) throw refuse('pedido-invalido')
    const diary = keyParam(op.diary)
    if (op.version !== TERMS_VERSION) throw refuse('pedido-invalido')
    if (!verifyTerms({ nonce, member, association, version: op.version }, body.termsSignature).ok) throw refuse('assinatura-invalida')
    // Before the nonce is claimed and before any seeder read.
    if (termsRunning.has(member)) throw refuse('limite')
    if (!caps.terms(member) || !caps.termsAll('all')) throw refuse('limite')
    termsRunning.add(member)
    try {
      return await acceptTermsRun(member, nonce, op, hash, diary, body)
    } finally {
      termsRunning.delete(member)
    }
  }

  async function acceptTermsRun (member, nonce, op, hash, diary, body) {
    claim(member, nonce, hash, true)
    const d = await authMember(member, { diary, terms: false })
    if (termsStore === null || !termsStore.available()) throw refuse('indisponivel')
    let accepted
    try {
      accepted = await termsStore.accept({ member, version: op.version, nonce, signature: body.termsSignature })
      await pagesStore.setDelegate(member, { diary, length: d.length, termsVersion: op.version })
    } catch (err) {
      throw tokenOf(err)
    }
    note('terms', accepted.changed ? 'novo' : 'repetido')
    return { version: op.version, acceptedAt: accepted.acceptedAt }
  }

  // ---- admins and transfer ---------------------------------------------------

  async function invite (body) {
    const { member, page, nonce, op, hash } = await statement(body, 'invite', false)
    if (!exactKeys(op, ['member', 'gen', 'rosterSignature', 'roster']) || !exactKeys(op.roster, ['owner', 'admins', 'prev', 'at', 'nonce'])) {
      throw refuse('pedido-invalido')
    }
    const invitee = keyParam(op.member)
    if (typeof op.rosterSignature !== 'string' || !HEX128_RE.test(op.rosterSignature)) throw refuse('pedido-invalido')
    const record = body.record
    if (!isPlainObject(record) || record.signature !== op.rosterSignature || record.gen !== op.gen || record.nonce !== nonce) {
      throw refuse('pedido-invalido')
    }
    for (const k of ['owner', 'admins', 'prev', 'at', 'nonce']) {
      if (k === 'admins' ? !sameList(record.admins, op.roster.admins) : record[k] !== op.roster[k]) throw refuse('pedido-invalido')
    }
    const prior = claim(member, nonce, hash, false, page, 'invite')
    if (prior !== null) return prior
    return once(member, nonce, () => withLock(page, async () => {
      const row = writableRow(page)
      need(row, member, 'owner')
      if (invitee === member || invitee === page || row.admins.includes(invitee)) throw refuse('pedido-invalido')
      linked(invitee)
      if (blocked(invitee)) throw refuse('sem-permissao')
      if (pagesStore.isPage(invitee)) throw refuse('pedido-invalido')
      const expected = [...row.admins, invitee].sort()
      if (record.owner !== member || !sameList(record.admins, expected) || record.prev !== row.rosterSeq || record.gen !== row.gen + 1) {
        throw refuse('expirado')
      }
      countersign(record, page)
      chargeOps(page)
      let inv
      try {
        inv = await pagesStore.invite(page, invitee, { gen: op.gen, rosterSignature: op.rosterSignature, spend: spendOf(member, nonce, 0) })
      } catch (err) {
        throw tokenOf(err)
      }
      if (typeof inv === 'number') return { invited: true }
      invites.set(page + ':' + invitee, { record: { ...record, association }, expiresAt: inv.expiresAt })
      try {
        saveInvites()
      } catch {
        note('invite', 'armazenamento-indisponivel')
        throw refuse('indisponivel')
      }
      const result = { invited: true, expiresAt: inv.expiresAt }
      settle(member, nonce, result)
      keep(page, 'invite', member, 0)
      return result
    }))
  }

  async function accept (body) {
    const { member, page, nonce, record, hash } = await recordProof(body, 'accept', 'page-accept')
    const prior = claim(member, nonce, hash, false, page, 'accept')
    if (prior !== null) return prior
    return once(member, nonce, () => withLock(page, async () => {
      writableRow(page)
      let next
      try {
        next = pagesStore.accept(page, member)
      } catch (err) {
        throw tokenOf(err)
      }
      const kept = invites.get(page + ':' + member)
      if (kept === undefined || record.gen !== next.gen || record.rosterSignature !== next.rosterSignature ||
          kept.record.signature !== next.rosterSignature || kept.record.owner !== next.owner || !sameList(kept.record.admins, next.admins)) {
        throw refuse('expirado')
      }
      const roster = countersign(kept.record, page)
      chargeOps(page)
      const res = await append(page, [record, roster], { member, nonce })
      await after(async () => {
        await pagesStore.setRoster(page, { gen: roster.gen, seq: res.seq, owner: roster.owner, admins: roster.admins, spend: spendOf(member, nonce, res.seq) })
        await pagesStore.expectLength(page, res.length)
      })
      invites.delete(page + ':' + member)
      try { saveInvites() } catch {}
      const result = { seq: res.seq, length: res.length, pushed: res.pushed }
      settle(member, nonce, result)
      keep(page, 'accept', member, res.seq)
      return result
    }))
  }

  async function rosterAction (action, body) {
    const { member, page, nonce, record, hash } = await recordProof(body, action, 'page-roster')
    const prior = claim(member, nonce, hash, false, page, action)
    if (prior !== null) return prior
    return once(member, nonce, () => withLock(page, async () => {
      const row = writableRow(page)
      let next
      try {
        if (action === 'remove') {
          need(row, member, 'owner')
          const gone = Array.isArray(record.admins) ? row.admins.filter((a) => !record.admins.includes(a)) : []
          if (gone.length !== 1) throw refuse('pedido-invalido')
          next = pagesStore.remove(page, gone[0])
        } else {
          next = pagesStore.transferAccept(page, member)
          // Only the newest offer counts, and only before its expiry.
          if (row.offer === null || !(Date.parse(row.offer.exp) >= now())) throw refuse('expirado')
        }
      } catch (err) {
        throw tokenOf(err)
      }
      if (record.gen !== next.gen || record.owner !== next.owner || !sameList(record.admins, next.admins) || record.prev !== next.prev) {
        throw refuse('expirado')
      }
      const roster = countersign(record, page)
      chargeOps(page)
      const res = await append(page, [roster], { member, nonce })
      await after(async () => {
        await pagesStore.setRoster(page, { gen: roster.gen, seq: res.seq, owner: roster.owner, admins: roster.admins, spend: spendOf(member, nonce, res.seq) })
        await pagesStore.expectLength(page, res.length)
      })
      const result = { seq: res.seq, length: res.length, pushed: res.pushed }
      settle(member, nonce, result)
      keep(page, action, member, res.seq)
      return result
    }))
  }

  async function offer (body) {
    const { member, page, nonce, record, hash } = await recordProof(body, 'offer', 'page-offer')
    const prior = claim(member, nonce, hash, false, page, 'offer')
    if (prior !== null) return prior
    return once(member, nonce, () => withLock(page, async () => {
      const row = writableRow(page)
      need(row, member, 'owner')
      if (record.gen !== row.gen) throw refuse('expirado')
      if (record.to === null) return cancelOffer(page, member, nonce, record)
      const t = now()
      const to = keyParam(record.to)
      if (to === member || to === page || pagesStore.isPage(to)) throw refuse('pedido-invalido')
      const expMs = Date.parse(record.exp)
      if (!(expMs > t)) throw refuse('expirado')
      if (expMs > t + 7 * DAY) throw refuse('pedido-invalido')
      // The old owner becomes an admin: a full roster has no room unless the
      // recipient already is one.
      if (row.admins.length >= MAX_ADMINS && !row.admins.includes(to)) throw refuse('limite')
      linked(to)
      if (blocked(to)) throw refuse('sem-permissao')
      chargeOps(page)
      const res = await append(page, [record], { member, nonce })
      await after(async () => {
        await pagesStore.offer(page, to, record.exp, { seq: res.seq, spend: spendOf(member, nonce, res.seq) })
        await pagesStore.expectLength(page, res.length)
      })
      const result = { seq: res.seq, length: res.length, pushed: res.pushed }
      settle(member, nonce, result)
      keep(page, 'offer', member, res.seq)
      return result
    }))
  }

  // The signed cancel ({ to: null, exp: null }, the shape verifyOffer
  // checked) goes on the diary first, so pendingOffer and the full-mode
  // chain stop showing the offer; then the ACL forgets it. Allowed with no
  // offer in the ACL too, so a diary offer the ACL lost can still be closed.
  async function cancelOffer (page, member, nonce, record) {
    chargeOps(page)
    const res = await append(page, [record], { member, nonce })
    await after(async () => {
      await pagesStore.cancel(page, { spend: spendOf(member, nonce, res.seq) })
      await pagesStore.expectLength(page, res.length)
    })
    const result = { seq: res.seq, length: res.length, pushed: res.pushed, cancelled: true }
    settle(member, nonce, result)
    keep(page, 'offer', member, res.seq)
    return result
  }

  // ---- close and move ---------------------------------------------------------

  // A refusal by the writer appended nothing; any other failure may have.
  function writerFailure (err) {
    if (err && typeof err.code === 'string' && has(WRITER_TOKENS, err.code)) return tokenOf(err)
    return new Uncertain()
  }

  function pausedNow (page, row) {
    if (row.paused) return true
    try {
      return writer.info(page).paused === true
    } catch (err) {
      throw tokenOf(err)
    }
  }

  // The owner of a live page, under its lock. A moved page is 'movida'.
  function ownerRow (page, member) {
    const row = rowOf(page)
    if (row.movedTo !== null) throw new RouteError('movida', 409)
    if (row.closed !== null) throw refuse('encerrada')
    if (blocked(page)) throw refuse('sem-permissao')
    need(row, member, 'owner')
    return row
  }

  // The page leaves its groups and communities; their own group-join off
  // records are appended by pages-groups.js.
  // -> the communities left, for a move's re-join on K2.
  async function leaveGroups (page) {
    if (pagesGroups === null) return []
    let res
    try {
      res = await pagesGroups.leaveAll(page)
    } catch {
      note('grupos', 'saida-incerta')
      throw new Uncertain()
    }
    // A group not left would keep K1 in it after its terminal record: the
    // close or move is refused before anything terminal is written.
    if (res && Number.isSafeInteger(res.failures) && res.failures > 0) {
      note('grupos', 'saida-pendente')
      throw refuse('indisponivel')
    }
    return res && Array.isArray(res.communities) ? res.communities : []
  }

  function stopDm (page) {
    if (pagesDm === null) return
    Promise.resolve().then(() => pagesDm.stop(page)).catch(() => note('conversas', 'parada-pendente'))
  }

  // A closed page's Conversas are dropped, never saved again: stop would
  // write the cached inbox back after the writer deleted it.
  function forgetDm (page) {
    if (pagesDm === null) return
    if (typeof pagesDm.forget !== 'function') return stopDm(page)
    Promise.resolve().then(() => pagesDm.forget(page)).catch(() => note('conversas', 'parada-pendente'))
  }

  // A tombstone, with the media ranges it releases, for every post, like,
  // repost and profile version the page still shows.
  async function closeDeletes (page) {
    let entries
    try {
      entries = await writer.readEntries(page)
    } catch (err) {
      throw tokenOf(err)
    }
    const out = []
    for (const e of applyDeletes(entries)) {
      if (!e || e.deleted || !Number.isSafeInteger(e.seq) || e.seq < 1) continue
      const r = e.record
      if (!isPlainObject(r) || !CLOSE_DELETES.includes(r.type)) continue
      const items = Array.isArray(r.media) ? r.media : isPlainObject(r.avatar) ? [r.avatar] : []
      const media = items.length > 0 ? items.map((d) => ({ core: d.core, start: d.start, blocks: d.blocks })) : undefined
      out.push(deleteRecord({ seq: e.seq, media }))
    }
    return out
  }

  // A paused page gets no block: its ACL and directory entry close and its
  // secrets go.
  async function closeQuiet (page, member, nonce) {
    await after(async () => {
      await pagesStore.close(page, { spend: spendOf(member, nonce, 0) })
      await store.closePage({ key: page })
    })
    forgetDm(page)
    try {
      await writer.wipe(page)
    } catch {
      note('close', 'limpeza-falhou')
    }
    return { closed: true, paused: true }
  }

  async function close (body) {
    const { member, page, nonce, record, hash } = await recordProof(body, 'close', 'page-close')
    const prior = claim(member, nonce, hash, false, page, 'close')
    if (prior !== null) return prior
    return once(member, nonce, () => withLock(page, async () => {
      const row = ownerRow(page, member)
      if (record.gen !== row.gen + 1) throw refuse('expirado')
      const closeRecord = countersignAs(record, page, 'page-close')
      if (!verifyClose(closeRecord, page, association, { owner: row.owner }).ok) throw refuse('assinatura-invalida')
      chargeLifecycle(member, nonce)
      let result
      try {
        result = await closeRun(page, member, nonce, row, closeRecord)
      } catch (err) {
        refundLifecycle(member, nonce, err)
        throw err
      }
      settle(member, nonce, result)
      keep(page, 'close', member, result.seq || 0)
      return result
    }))
  }

  async function closeRun (page, member, nonce, row, closeRecord) {
    if (pausedNow(page, row)) return closeQuiet(page, member, nonce)
    await leaveGroups(page)
    const unfollows = writer.follows(page).map((f) => followRecord({ key: f.key, on: false }))
    const deletes = await closeDeletes(page)
    let res
    try {
      res = await writer.closePage(page, { unfollows, leaves: [], deletes, closeRecord })
    } catch (err) {
      throw writerFailure(err)
    }
    if (res.paused) return closeQuiet(page, member, nonce)
    const seq = res.length - 1
    await after(async () => {
      await pagesStore.close(page, { spend: spendOf(member, nonce, seq) })
      await store.closePage({ key: page })
    })
    forgetDm(page)
    return { seq, length: res.length, pushed: res.pushed }
  }

  // K2's genesis roster and page-origin, signed by the owner with the
  // page-moved: the same nonce, K2 as `to`, K1 as `from`.
  function moveParts (body, member, page, nonce, record) {
    const { origin, roster } = body
    if (!isPlainObject(origin) || !isPlainObject(roster)) throw refuse('pedido-invalido')
    const to = keyParam(record.to)
    if (to === page || origin.type !== 'page-origin' || origin.page !== to || origin.from !== page || origin.nonce !== nonce ||
        origin.actor !== member || origin.owner !== member || origin.gen !== record.gen || origin.at !== record.at) {
      throw refuse('pedido-invalido')
    }
    if (roster.type !== 'page-roster' || roster.page !== to || roster.gen !== 1 || roster.prev !== null || roster.nonce !== nonce ||
        roster.owner !== member || !sameList(roster.admins, origin.admins)) {
      throw refuse('pedido-invalido')
    }
    let hash
    try {
      hash = opHash({ record, origin, roster })
    } catch {
      throw refuse('pedido-invalido')
    }
    return { to, origin, roster, hash }
  }

  async function move (body) {
    const { member, page, nonce, record } = await recordProof(body, 'move', 'page-moved')
    const { to, origin, roster, hash } = moveParts(body, member, page, nonce, record)
    const prior = claim(member, nonce, hash, false, page, 'move')
    if (prior !== null) return prior
    return once(member, nonce, () => withLock(page, async () => {
      // The writer moved K1 to K2 and a later step failed: the resend
      // finishes the move.
      if (movedHere(page, to)) return moveLocked({ member, page, nonce, record, to, origin, roster, pending: null })
      let pending
      try {
        pending = keys.pending(nonce)
      } catch (err) {
        throw tokenOf(err)
      }
      try {
        if (pending.key !== to) throw refuse('expirado')
        return await moveLocked({ member, page, nonce, record, to, origin, roster, pending })
      } finally {
        pending.row.secretKey.fill(0)
        pending.row.mediaSecretKey.fill(0)
      }
    }))
  }

  // K1 moved to `to` in the writer, K2 written, and the ACL has no K2 row.
  function movedHere (page, to) {
    try {
      return writer.info(page).movedTo === to && writer.info(to) !== null && pagesStore.get(to) === null
    } catch {
      return false
    }
  }

  // The username record of K2's genesis, for a resumed directory step.
  async function genesisUsername (to) {
    const entries = await writer.readEntries(to)
    const e = entries.find((x) => isPlainObject(x.record) && x.record.type === 'username')
    if (!e) throw new Error('no username')
    return e.record
  }

  // `pending` null: a resumed move, whose writer step already ran.
  async function moveLocked ({ member, page, nonce, record, to, origin, roster, pending }) {
    const resume = pending === null
    const row = ownerRow(page, member)
    // The roster carries over unchanged, at K1's final gen; fromSeq is K1's
    // length as the owner last read it.
    if (record.gen !== row.gen || origin.owner !== row.owner || !sameList(origin.admins, row.admins) ||
        !Number.isSafeInteger(origin.fromSeq) || origin.fromSeq < 1 || origin.fromSeq > row.length) {
      throw refuse('expirado')
    }
    const rosterRecord = countersign(roster, to)
    const originRecord = countersignAs(origin, to, 'page-origin')
    if (!pageLib.verifyOrigin(originRecord, to, association).ok) throw refuse('assinatura-invalida')
    const movedRecord = countersignAs(record, page, 'page-moved')
    if (!verifyMoved(movedRecord, page, association, { owner: row.owner }).ok) throw refuse('assinatura-invalida')
    let depth
    let entry
    try {
      depth = pagesStore.moveDepth(page) + 1
      entry = store.pageStatus(page)
    } catch {
      throw refuse('indisponivel')
    }
    const dirMoved = resume && entry !== null && entry.movedTo === to
    if (!dirMoved && (entry === null || typeof entry.username !== 'string')) throw refuse('indisponivel')
    if (depth > MAX_PAGE_MOVES) throw refuse('limite')
    if (!resume) chargeLifecycle(member, nonce)
    const date = iso(now())
    let res
    let cert
    let usernameRecord
    let left = moveLeft.get(page) || []
    if (resume) {
      try {
        cert = writer.certOf(to)
        if (!dirMoved) usernameRecord = await genesisUsername(to)
        const paused = writer.info(page).paused === true
        let seq = null
        if (!paused) {
          const life = pageLifecycle(await writer.readEntries(page), page, association)
          seq = life.movedTo === null ? null : life.movedTo.seq
        }
        res = { moved: seq, length: writer.info(to).length, pushed: false, paused, record: movedRecord }
      } catch {
        throw refuse('indisponivel')
      }
    } else {
      try {
        // A resend after an uncertain move keeps what the first run left.
        if (!pausedNow(page, row)) left = [...new Set([...left, ...(await leaveGroups(page))])].sort()
        moveLeft.set(page, left)
        cert = createIssuedCert({ member: to, date }, issuerKeyPair, issuerCert)
        usernameRecord = createUsernameRecord({ member: to, username: entry.username, date }, issuerKeyPair, issuerCert)
        try {
          keys.put(to, pending.row)
          res = await writer.movePage({ from: page, to, cert, usernameRecord, rosterRecord, originRecord, movedRecord, depth })
        } catch (err) {
          const e = writerFailure(err)
          // A refusal created nothing: K2's secrets go too.
          if (!(e instanceof Uncertain)) {
            try { await writer.wipe(to) } catch { note('move', 'limpeza-falhou') }
          }
          throw e
        }
      } catch (err) {
        refundLifecycle(member, nonce, err)
        throw err
      }
    }
    const seq = res.moved === null || res.moved === undefined ? 0 : res.moved
    let length = res.length
    try {
      await after(async () => {
        if (!dirMoved) await store.movePage({ from: page, to, usernameRecord, cert })
        await pagesStore.move(page, to, { spend: spendOf(member, nonce, seq) })
        if (res.paused) await pagesStore.setStatement(page, res.record)
      })
    } catch (err) {
      // The writer has moved and the directory or the ACL may not have: K1
      // stops until the resend finishes the move or an operator looks.
      try { await pagesStore.pause(page) } catch {}
      note('move', 'pausada-incerta')
      throw err
    }
    moveLeft.delete(page)
    // A core delegate owner keeps its diary's profile on K2.
    let delegate = null
    try {
      if (!isLinked(member)) delegate = pagesStore.delegate(member)
    } catch {}
    if (delegate !== null) {
      try {
        const link = issuerSignLink({ page: to, diary: delegate.diary, actor: member, at: date, nonce }, issuerKeyPair, issuerCert)
        const linkRes = await writer.append(to, [link])
        length = linkRes.length
        await pagesStore.expectLength(to, length)
      } catch {
        note('move', 'vinculo-pendente')
      }
    }
    stopDm(page)
    if (pagesDm !== null) Promise.resolve().then(() => pagesDm.enable(to)).catch(() => note('move', 'conversas-pendentes'))
    rejoin(to, left)
    const result = { page: to, seq, length, pushed: res.pushed }
    if (res.paused) result.paused = true
    settle(member, nonce, result)
    keep(page, 'move', member, seq)
    return result
  }

  // K2 joins again every community K1 left; an approval one comes back as
  // 'requested'. Failures only log: the move stands.
  function rejoin (to, communities) {
    if (pagesGroups === null || communities.length === 0) return
    Promise.resolve().then(async () => {
      for (const C of communities) {
        try {
          await pagesGroups.communityJoin(to, C)
        } catch {
          note('move', 'comunidade-pendente')
        }
      }
    }).catch(noop)
  }

  // K1's countersigned page-moved, verified again before it is served: the
  // detached statement first, else the terminal move in K1's log.
  async function successor (k1) {
    const known = successors.get(k1)
    if (known !== undefined) return known
    const moved = await successorRead(k1)
    if (moved !== null) {
      successors.set(k1, moved)
      if (successors.size > MAX_SUCCESSORS) successors.delete(successors.keys().next().value)
    }
    return moved
  }

  async function successorRead (k1) {
    let row
    let detached
    try {
      row = pagesStore.get(k1)
      detached = row === null ? null : pagesStore.statement(k1)
    } catch {
      throw refuse('indisponivel')
    }
    if (row === null || row.movedTo === null) return null
    const ok = (r) => isPlainObject(r) && r.to === row.movedTo && verifyMoved(r, k1, association).ok
    if (ok(detached)) return detached
    let entries
    try {
      entries = await writer.readEntries(k1)
    } catch {
      return null
    }
    const life = pageLifecycle(entries, k1, association)
    if (life.movedTo === null) return null
    const e = entries.find((x) => x.seq === life.movedTo.seq)
    return e && ok(e.record) ? e.record : null
  }

  // ---- media and avatar ---------------------------------------------------

  function readRaw (req, max) {
    return new Promise((resolve, reject) => {
      const tooBig = () => new RouteError('midia-invalida', 413)
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > max) return reject(tooBig())
      const chunks = []
      let size = 0
      let done = false
      const finish = (err, value) => {
        if (done) return
        done = true
        if (err) reject(err)
        else resolve(value)
      }
      req.on('data', (chunk) => {
        if (done) return
        size += chunk.length
        // Past the cap nothing more is kept; the 413 closes the connection.
        if (size > max) {
          chunks.length = 0
          return finish(tooBig())
        }
        chunks.push(chunk)
      })
      req.on('error', () => finish(refuse('pedido-invalido')))
      req.on('aborted', () => finish(refuse('pedido-invalido')))
      req.on('end', () => finish(null, Buffer.concat(chunks)))
    })
  }

  function header (req, name) {
    const v = req.headers['x-varanda-page-' + name]
    return typeof v === 'string' ? v : undefined
  }

  // The statement of a raw upload, from the headers; the body is read only
  // after the signature and the member checks passed.
  async function upload (req, action) {
    checkRawPost(req)
    let op
    try {
      op = JSON.parse(header(req, 'op') || '')
    } catch {
      throw refuse('pedido-invalido')
    }
    const body = { member: header(req, 'member'), nonce: header(req, 'nonce'), page: header(req, 'page'), signature: header(req, 'signature'), op }
    const proof = await statement(body, action, false)
    const keysOk = action === 'media'
      ? exactKeys(proof.op, ['sha256', 'mime', 'width', 'height', 'bytes'])
      : exactKeys(proof.op, ['sha256', 'mime', 'bytes', 'name', 'bio'])
    if (!keysOk) throw refuse('pedido-invalido')
    const mimes = action === 'media' ? MEDIA_MIMES : AVATAR_MIMES
    const max = action === 'media' ? MAX_MEDIA_BODY : MAX_AVATAR_BYTES
    const { sha256, mime, bytes } = proof.op
    if (!mimes.includes(mime) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > max) throw refuse('midia-invalida')
    const row = writableRow(proof.page)
    need(row, proof.member, 'admin')
    const raw = await readRaw(req, max)
    if (raw.length !== bytes || sha256Hex(raw) !== sha256) throw refuse('midia-invalida')
    return { ...proof, raw }
  }

  async function media (req) {
    const { member, page, nonce, op, hash, raw } = await upload(req, 'media')
    const prior = claim(member, nonce, hash, false, page, 'media')
    if (prior !== null) return prior
    return once(member, nonce, () => withLock(page, async () => {
      const row = writableRow(page)
      need(row, member, 'admin')
      if (!caps.media(page)) throw refuse('limite')
      let descriptor
      try {
        descriptor = await writer.mediaItem(page, { bytes: raw, mime: op.mime, width: op.width, height: op.height, sha256: op.sha256 }, { member, nonce })
      } catch (err) {
        if (err && typeof err.code === 'string' && has(WRITER_TOKENS, err.code)) throw tokenOf(err)
        throw new Uncertain()
      }
      const length = writer.info(page).length
      await after(async () => {
        await pagesStore.setMedia(page, writer.items(page).length)
        await pagesStore.expectLength(page, length, { spend: spendOf(member, nonce, 0) })
      })
      const result = { descriptor }
      settle(member, nonce, result)
      keep(page, 'media', member, 0)
      return result
    }))
  }

  async function avatar (req) {
    const { member, page, nonce, op, hash, raw } = await upload(req, 'avatar')
    const prior = claim(member, nonce, hash, false, page, 'avatar')
    if (prior !== null) return prior
    return once(member, nonce, () => withLock(page, async () => {
      const row = writableRow(page)
      need(row, member, 'admin')
      if (!caps.avatar(page)) throw refuse('limite')
      try {
        profileRecords({ name: op.name, bio: op.bio })
      } catch {
        throw refuse('pedido-invalido')
      }
      let descriptor
      try {
        descriptor = await writer.avatarItem(page, raw, op.mime, { member, nonce })
      } catch (err) {
        if (err && typeof err.code === 'string' && has(WRITER_TOKENS, err.code)) throw tokenOf(err)
        throw new Uncertain()
      }
      const res = await append(page, profileRecords({ name: op.name, bio: op.bio, avatar: descriptor }), { member, nonce })
      await after(async () => {
        await pagesStore.setMedia(page, writer.items(page).length)
        await pagesStore.expectLength(page, res.length, { spend: spendOf(member, nonce, res.seq) })
      })
      const result = { seq: res.seq, length: res.length, pushed: res.pushed, descriptor }
      settle(member, nonce, result)
      keep(page, 'avatar', member, res.seq)
      return result
    }))
  }

  // ---- Conversas as the page ------------------------------------------------

  // The op of each dm action, exactly the params of docs/rpc.md 5.75 to 5.80.
  function dmParams (action, op) {
    const peerOf = (v) => {
      if (typeof v !== 'string' || !HEX64_RE.test(v)) throw refuse('pedido-invalido')
      return v
    }
    const limitOf = (v) => {
      if (v === undefined) return 30
      if (!Number.isSafeInteger(v) || v < 1 || v > 50) throw refuse('pedido-invalido')
      return v
    }
    if (action === 'dm-list') {
      if (!exactKeys(op, [], ['folder', 'limit', 'before'])) throw refuse('pedido-invalido')
      const folder = op.folder === undefined ? 'inbox' : op.folder
      if (folder !== 'inbox' && folder !== 'request') throw refuse('pedido-invalido')
      let before = null
      if (op.before !== undefined && op.before !== null) {
        if (!exactKeys(op.before, ['at', 'peer']) || !isCanonicalIso(op.before.at)) throw refuse('pedido-invalido')
        before = { at: op.before.at, peer: peerOf(op.before.peer) }
      }
      return { folder, limit: limitOf(op.limit), before }
    }
    if (action === 'dm-thread') {
      if (!exactKeys(op, ['peer'], ['before', 'limit'])) throw refuse('pedido-invalido')
      const before = op.before === undefined || op.before === null ? null : op.before
      if (before !== null && (typeof before !== 'string' || !HEX32_RE.test(before))) throw refuse('pedido-invalido')
      return { peer: peerOf(op.peer), before, limit: limitOf(op.limit) }
    }
    if (action === 'dm-send') {
      if (!exactKeys(op, ['to', 'text'], ['replyTo', 'fwd'])) throw refuse('pedido-invalido')
      const fwd = op.fwd === undefined ? 0 : op.fwd
      if (fwd !== 0 && fwd !== 1) throw refuse('pedido-invalido')
      const replyTo = op.replyTo === undefined ? null : op.replyTo
      if (replyTo !== null && (typeof replyTo !== 'string' || !HEX32_RE.test(replyTo))) throw refuse('pedido-invalido')
      if (typeof op.text !== 'string' || charLength(op.text) < 1 || charLength(op.text) > DM_MAX_TEXT) throw refuse('pedido-invalido')
      return { to: peerOf(op.to), text: op.text, replyTo, fwd }
    }
    if (action === 'dm-set') {
      if (!exactKeys(op, ['peer', 'state']) || !DM_STATES.includes(op.state)) throw refuse('pedido-invalido')
      return { peer: peerOf(op.peer), state: op.state }
    }
    if (!exactKeys(op, ['peer'])) throw refuse('pedido-invalido')
    return { peer: peerOf(op.peer) }
  }

  // Owner or admin, checked under the page lock on every call: a removed
  // admin is 'sem-permissao' from the remove's commit on, and nothing is
  // read or sealed for them.
  async function dm (action, body) {
    if (pagesDm === null) throw refuse('nao-encontrado')
    const { member, page, nonce, op, hash } = await statement(body, action, false)
    const params = dmParams(action, op)
    const read = DM_READS.includes(action)
    const prior = claim(member, nonce, hash, read, page, action)
    if (prior !== null) return prior
    const run = async () => {
      await withLock(page, () => {
        const row = rowOf(page)
        if (row.movedTo !== null) throw new RouteError('movida', 409)
        if (row.closed !== null) throw refuse('encerrada')
        if (blocked(page)) throw refuse('sem-permissao')
        need(row, member, 'admin')
        if (action === 'dm-send' || action === 'dm-set') chargeOps(page)
      })
      let result
      try {
        if (action === 'dm-list') result = await pagesDm.list(page, params)
        else if (action === 'dm-thread') result = await pagesDm.thread(page, params)
        else if (action === 'dm-send') result = await pagesDm.send(page, params, { member, nonce, recheck: () => stillAdmin(page, member, { paused: true }) })
        else if (action === 'dm-set') result = await pagesDm.set(page, params, { recheck: () => stillAdmin(page, member, { paused: true }) })
        else result = await pagesDm.seen(page, params)
      } catch (err) {
        if (err && err.code === 'incerto') throw new Uncertain()
        throw tokenOf(err)
      }
      // A removed admin gets nothing of a read that was in flight.
      if (read && !stillAdmin(page, member)) throw refuse('sem-permissao')
      if (!read) {
        settle(member, nonce, result)
        keep(page, action, member, 0)
      }
      return result
    }
    return read ? run() : once(member, nonce, run)
  }

  // ---- communities and groups as the page -------------------------------------

  function groupParams (action, op) {
    if (action === 'community-join' || action === 'community-leave') {
      if (!exactKeys(op, ['community'])) throw refuse('pedido-invalido')
      return { key: keyParam(op.community) }
    }
    if (action === 'group-join') {
      if (!exactKeys(op, ['group'], ['community'])) throw refuse('pedido-invalido')
      if (op.community !== undefined) keyParam(op.community)
      return { key: keyParam(op.group) }
    }
    if (action === 'group-leave') {
      if (!exactKeys(op, ['group'])) throw refuse('pedido-invalido')
      return { key: keyParam(op.group) }
    }
    if (action === 'group-post') {
      if (!exactKeys(op, ['group', 'text'], ['replyTo', 'fwd'])) throw refuse('pedido-invalido')
      const fwd = op.fwd === undefined ? 0 : op.fwd
      if (fwd !== 0 && fwd !== 1) throw refuse('pedido-invalido')
      const replyTo = op.replyTo === undefined ? null : op.replyTo
      // The group record's own bounds, checked before the page lock.
      try {
        groupLib.groupPost({ text: op.text, replyTo, fwd })
      } catch {
        throw refuse('pedido-invalido')
      }
      return { key: keyParam(op.group), text: op.text, replyTo, fwd }
    }
    if (!exactKeys(op, ['group'], ['before', 'limit'])) throw refuse('pedido-invalido')
    const limit = op.limit === undefined ? GROUP_READ_LIMIT : op.limit
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > GROUP_READ_LIMIT) throw refuse('pedido-invalido')
    let before = null
    if (op.before !== undefined && op.before !== null) {
      const b = op.before
      if (!exactKeys(b, ['at', 'writer', 'seq']) || !isCanonicalIso(b.at) || !Number.isSafeInteger(b.seq) || b.seq < 0) throw refuse('pedido-invalido')
      before = { at: b.at, writer: keyParam(b.writer), seq: b.seq }
    }
    return { key: keyParam(op.group), before, limit }
  }

  // Owner or admin, checked under the page lock before pages-groups.js runs:
  // a removed admin is 'sem-permissao' from the remove's commit on, and no
  // block is appended for them. A write runs under the lock; a read only
  // checks under it. Group refusals are tokens, never text.
  async function groupAction (action, body) {
    if (pagesGroups === null) throw refuse('indisponivel')
    const { member, page, nonce, op, hash } = await statement(body, action, false)
    const params = groupParams(action, op)
    const read = action === 'group-read'
    const prior = claim(member, nonce, hash, read, page, action)
    if (prior !== null) return prior
    const call = async () => {
      try {
        if (action === 'community-join') return await pagesGroups.communityJoin(page, params.key)
        if (action === 'community-leave') return await pagesGroups.communityLeave(page, params.key)
        if (action === 'group-join') return await pagesGroups.groupJoin(page, params.key)
        if (action === 'group-leave') return await pagesGroups.groupLeave(page, params.key)
        if (action === 'group-post') return await pagesGroups.groupPost(page, params.key, { text: params.text, replyTo: params.replyTo, fwd: params.fwd })
        return await pagesGroups.groupRead(page, params.key, { before: params.before, limit: params.limit })
      } catch (err) {
        // A writer core or the diary may have taken a block before the
        // failure; a refusal from the fold appended nothing.
        const known = err && typeof err.code === 'string' && (has(WRITER_TOKENS, err.code) || TOKENS.has(err.code))
        if (!read && !known) throw new Uncertain()
        throw tokenOf(err)
      }
    }
    if (read) {
      await withLock(page, () => {
        const row = rowOf(page)
        if (row.movedTo !== null) throw new RouteError('movida', 409)
        if (row.closed !== null) throw refuse('encerrada')
        if (blocked(page)) throw refuse('sem-permissao')
        need(row, member, 'admin')
      })
      const out = await call()
      if (!stillAdmin(page, member)) throw refuse('sem-permissao')
      return out
    }
    return once(member, nonce, () => withLock(page, async () => {
      const row = writableRow(page)
      need(row, member, 'admin')
      chargeOps(page)
      const out = await call()
      // The joins and leaves went on the diary through the writer: the ACL
      // follows its length.
      try {
        await pagesStore.expectLength(page, writer.info(page).length)
      } catch {
        note(action, 'comprimento-pendente')
      }
      const result = action === 'group-post' ? { seq: out.seq } : { state: out.state, role: out.state }
      if (action === 'community-join') result.group = out.group
      settle(member, nonce, result)
      keep(page, action, member, 0)
      return result
    }))
  }

  // ---- routing --------------------------------------------------------------

  async function dispatch (action, req) {
    if (action === 'media') return media(req)
    if (action === 'avatar') return avatar(req)
    checkPost(req)
    const body = await readJsonBody(req, MAX_BODY)
    if (action === 'start') return start(body)
    if (action === 'create') return create(body)
    if (['post', 'reply', 'quote', 'delete', 'like', 'repost', 'profile'].includes(action)) return write(action, body)
    if (READS.includes(action)) return read(action, body)
    if (DM_ACTIONS.includes(action)) return dm(action, body)
    if (GROUP_ACTIONS.includes(action)) return groupAction(action, body)
    if (action === 'notices') return notices(body)
    if (action === 'terms') return acceptTerms(body)
    if (action === 'rename') return rename(body)
    if (action === 'follow') return follow(body)
    if (action === 'invite') return invite(body)
    if (action === 'accept') return accept(body)
    if (action === 'remove' || action === 'transfer-accept') return rosterAction(action, body)
    if (action === 'offer') return offer(body)
    if (action === 'close') return close(body)
    if (action === 'move') return move(body)
    // The old unsigned cancel cleared only the ACL: the signed cancel offer
    // replaced it.
    if (action === 'offer-cancel') throw refuse('pedido-invalido')
    throw refuse('nao-encontrado')
  }

  const ROUTES = new Set(['start', 'media', 'avatar', 'offer-cancel', ...START_ACTIONS])

  async function handle (req, res, url) {
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === PREFIX + 'policy') {
      return send(res, 200, on ? { available: true, maxOwned: MAX_OWNED, maxAdmins: MAX_ADMINS } : { available: false })
    }
    if (req.method === 'GET' && on && pathname.startsWith(SUCCESSOR) && HEX64_RE.test(pathname.slice(SUCCESSOR.length))) {
      const noStore = { 'Cache-Control': 'no-store' }
      if (!caps.successor('all')) return sendError(res, refuse('limite'), noStore)
      try {
        const moved = await successor(pathname.slice(SUCCESSOR.length))
        if (moved === null) return sendError(res, new RouteError('nao-encontrado', 404), noStore)
        return send(res, 200, { moved }, noStore)
      } catch (err) {
        note('successor', tokenOf(err).token || 'indisponivel')
        return sendError(res, refuse('indisponivel'), noStore)
      }
    }
    const action = pathname.slice(PREFIX.length)
    // Off, a page POST is not read at all.
    if (req.method !== 'POST' || !on || !ROUTES.has(action)) {
      res.setHeader('Connection', 'close')
      return sendError(res, new RouteError('nao-encontrado', 404))
    }
    try {
      const result = await dispatch(action, req)
      counts.ok++
      return send(res, 200, result)
    } catch (err) {
      const e = tokenOf(err)
      if (e instanceof Uncertain) {
        counts.uncertain++
        note(action, 'incerto')
        return send(res, 202, { uncertain: true })
      }
      counts.refused++
      note(action, e.token)
      if (e.status === 413) res.setHeader('Connection', 'close')
      return sendError(res, e)
    }
  }

  return {
    owns: (pathname) => pathname === '/account/pages' || pathname.startsWith(PREFIX),
    handle,
    stats: () => ({ available: on, ...counts, applied: applied.size, invites: invites.size }),
    audit: () => audit.map((a) => ({ ...a }))
  }
}

module.exports = { createPagesRoutes, MAX_MEDIA_BODY, MAX_BODY }
