'use strict'

// The local direct message store (docs/protocol.md section 11 "Local
// storage"): a local-only core, 'dm-local' (./node-store.js openDmLocal),
// whose every block is { v: 1, nonce: hex48, box: base64 }, the
// crypto_secretbox (@varanda/core lib/group-crypto.js sealRecord) of one
// compact JSON row under the key derived from the passkey PRF
// (passkey.js dmLocalKeyFromPrf). A row is a message
// { t: 'msg', id, peer, from, text, replyTo, media, at, mine, filedAt, digest? }
// (media: null or the message's media items, blob descriptors with their
// key, exactly as the inner carries them; a row from before media reads as
// null; digest: the hex64 sha256 of the inner's canonical JSON, @varanda/core
// dm.js bodyDigest, absent on a row filed by an earlier build) or an op
// { t: 'ctl', id, op, peer, at, filedAt } (id: the ctl envelope's, so a
// device that pulls its own ctl back does not file it twice) or a reaction
// { t: 'rx', id, peer, from, to, target: { from, id, digest }, emoji, rev, at,
// filedAt } (an inner v4 op, kept even while its target is not stored; the
// fold applies it once the target is, and only to the msg row with its
// target.digest; a row without a hex64 target.digest is skipped on load). Before sealing,
// a row gets a `pad` of spaces so its JSON is a multiple of ROW_BUCKET bytes:
// the block length says neither the text length (within a bucket) nor msg
// from ctl. The core's own signing pair derives
// from the same key, so nothing in the storage can append or read without
// the passkey. While locked nothing is readable: unlock() decrypts every
// block into memory once, lock() drops it and zeroes the key.
//
// The media cache (docs/protocol.md section 13): the plaintext of an opened
// blob, kept so a message still shows its photo after the pool swept the
// blob. One kv entry per item, 'dmMedia/<name>/<index>' = { v: 1, nonce,
// box }, the crypto_secretbox of the raw bytes under a key derived from the
// local key (MEDIA_KEY_DOMAIN); <name> is a keyed hash of the sender and the
// message id, so kv names say nothing about who sent what. kv dmMediaIndex
// = { v: 1, items: [{ n: name, c: count, b: bytes }] } lists them, oldest
// first, so wipeCache() finds every entry without the key (lock and reset
// run it after the key is gone). The plaintext bytes of all entries stay
// within CACHE_BYTES_MAX: a write past it evicts the oldest entries first,
// and an item set larger than the whole budget is not cached at all. The
// message row keeps the descriptors only; the 7-day pool sweep does not
// touch this cache.
//
// prefix: '' for the own store; a Página's store (./page-dm.js) passes
// node-store pageDmPrefix(page), and its core, media index and media
// entries then live under that prefix, apart from the own ones. A page row
// filed from the legacy bundle (./dm.js pageLegacyChunk) carries legacy: true
// (history the service held in plaintext, never signed evidence).
//
// The list summary (docs/protocol.md section 11): kv '<prefix>dmSummary' =
// { v: 1, nonce, box }, the crypto_secretbox under a key derived from the
// local key (SUMMARY_KEY_DOMAIN) of { v: 1, core, length, follows, seen,
// inbox, requests }: the first dm.list pages of both folders as the last
// fold gave them, with the core key and length and the digests of the kv
// follows and seen texts that fold read. keyStage() settles once unlock()
// installed the key and read the summary; the rows load after it (loaded(),
// what unlock() returns), so a first page can answer before every row is
// opened. The summary is used
// only while it opens under this key, names this core and its length and
// the digests are the current ones (summaryFor); anything else is ignored.
//
// Delete is an op row plus the fold rule (@varanda/core lib/dm-fold.js drops
// what was filed at or before it): the ciphertext of deleted messages stays
// in the core until a later compaction, which is not done here.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const gc = require('@varanda/core/lib/group-crypto')
const { copyLinkCard } = require('@varanda/core/lib/link-card')
const { validDmCard, DM_OPS, DM_AUDIO_MIME, DM_AUDIO_MAX_MS, DM_AUDIO_MAX_BYTES, DM_REACT_REV_MAX } = require('@varanda/core/lib/dm')
const { isReaction } = require('@varanda/rpc')
const sodium = require('./sodium-browser')
const store = require('./node-store')

const CORE_SEED_DOMAIN = b4a.from('varanda/member-dm-local/core/v1\n', 'utf8')
const SEEN_DOMAIN = b4a.from('varanda/member-dm-local/seen/v1\n', 'utf8')
const MEDIA_KEY_DOMAIN = b4a.from('varanda/member-dm-local/media-key/v1\n', 'utf8')
const MEDIA_NAME_DOMAIN = b4a.from('varanda/member-dm-local/media-name/v1\n', 'utf8')
const BYTES_DOMAIN = b4a.from('varanda/member-dm-local/bytes/v1\n', 'utf8')
const SUMMARY_KEY_DOMAIN = b4a.from('varanda/member-dm-local/summary-key/v1\n', 'utf8')
const SUMMARY = 'dmSummary'
const SUMMARY_DELAY_MS = 1000
// dm.list's default page size: the summary holds one such page per folder.
const SUMMARY_PAGE = 30
const MEDIA_INDEX = 'dmMediaIndex'
const MEDIA_PREFIX = 'dmMedia/'
const MEDIA_ITEMS_MAX = 4
const MEDIA_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const MEDIA_KEYS = ['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256', 'mime', 'w', 'h', 'ms']
const HEX48 = /^[0-9a-f]{48}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/
const LOCKED = 'identidade bloqueada: entre com a passkey'
const ROW_BUCKET = 1024
const CACHE_BYTES_MAX = 256 * 1048576

function isCount (n, max) {
  return Number.isSafeInteger(n) && n >= 1 && n <= max
}

// The stored shape of a media item; the inner was checked in full on open
// (@varanda/core lib/dm.js) or built from a checked item on send.
function validMediaItem (d) {
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return false
  const keys = Object.keys(d)
  if (keys.length !== MEDIA_KEYS.length || !MEDIA_KEYS.every((k) => keys.includes(k))) return false
  if (!(HEX64.test(d.id) && HEX64.test(d.key) && HEX48.test(d.nonce) && HEX64.test(d.sha256) && isCount(d.chunks, 257))) return false
  if (d.mime === DM_AUDIO_MIME) return isCount(d.bytes, DM_AUDIO_MAX_BYTES) && d.w === 0 && d.h === 0 && isCount(d.ms, DM_AUDIO_MAX_MS)
  return isCount(d.bytes, 257 * 32768) && MEDIA_MIMES.includes(d.mime) && isCount(d.w, 16384) && isCount(d.h, 16384) && d.ms === 0
}

// A voice note is the only item of its message.
function validMedia (m) {
  return m === null || (Array.isArray(m) && m.length >= 1 && m.length <= MEDIA_ITEMS_MAX && m.every(validMediaItem) &&
    (m.length === 1 || !m.some((d) => d.mime === DM_AUDIO_MIME)))
}

function plainMedia (m) {
  if (!Array.isArray(m)) return null
  return m.map((d) => {
    const o = {}
    for (const k of MEDIA_KEYS) o[k] = d[k]
    return o
  })
}

function validRow (r) {
  if (r === null || typeof r !== 'object' || !HEX64.test(r.peer) || typeof r.at !== 'string') return false
  if (!Number.isFinite(r.filedAt)) return false
  if (r.t === 'ctl') return DM_OPS.includes(r.op) && HEX32.test(r.id)
  if (r.t === 'rx') return validReactionRow(r)
  if (r.t !== 'msg') return false
  if (r.legacy !== undefined && r.legacy !== true) return false
  if (r.digest !== undefined && !HEX64.test(r.digest)) return false
  return HEX32.test(r.id) && HEX64.test(r.from) && typeof r.text === 'string' &&
    (r.replyTo === null || HEX32.test(r.replyTo)) && typeof r.mine === 'boolean' &&
    (r.fwd === undefined || r.fwd === 0 || r.fwd === 1) &&
    validMedia(r.media === undefined ? null : r.media) &&
    (r.card === undefined || r.card === null || (r.media == null && validDmCard(r.card)))
}

function validReactionRow (r) {
  if (!HEX32.test(r.id) || !HEX64.test(r.from) || !HEX64.test(r.to) || r.from === r.to) return false
  if (r.peer !== (r.mine ? r.to : r.from) || typeof r.mine !== 'boolean') return false
  const t = r.target
  if (t === null || typeof t !== 'object' || !HEX32.test(t.id) || (t.from !== r.from && t.from !== r.to)) return false
  if (typeof t.digest !== 'string' || !HEX64.test(t.digest)) return false
  if (r.emoji !== '' && !isReaction(r.emoji)) return false
  return Number.isSafeInteger(r.rev) && r.rev >= 1 && r.rev <= DM_REACT_REV_MAX
}

function plainRow (r) {
  if (r.t === 'ctl') return { t: 'ctl', id: r.id, op: r.op, peer: r.peer, at: r.at, filedAt: r.filedAt }
  if (r.t === 'rx') {
    return { t: 'rx', id: r.id, peer: r.peer, from: r.from, to: r.to, target: { from: r.target.from, id: r.target.id, digest: r.target.digest }, emoji: r.emoji, rev: r.rev, at: r.at, mine: r.mine, filedAt: r.filedAt }
  }
  const out = { t: 'msg', id: r.id, peer: r.peer, from: r.from, text: r.text, replyTo: r.replyTo, fwd: r.fwd === 1 ? 1 : 0, media: plainMedia(r.media), card: r.card == null ? null : copyLinkCard(r.card, (d) => plainMedia([d])[0]), at: r.at, mine: r.mine, filedAt: r.filedAt }
  if (typeof r.digest === 'string' && HEX64.test(r.digest)) out.digest = r.digest
  if (r.legacy === true) out.legacy = true
  return out
}

// The row with `pad` last, its JSON rounded up to a ROW_BUCKET multiple.
function padded (row) {
  const base = b4a.byteLength(JSON.stringify({ ...row, pad: '' }))
  const size = Math.ceil(base / ROW_BUCKET) * ROW_BUCKET
  return { ...row, pad: ' '.repeat(size - base) }
}

function validConversation (c) {
  return c !== null && typeof c === 'object' && HEX64.test(c.peer) && (c.folder === 'inbox' || c.folder === 'request') &&
    typeof c.preview === 'string' && typeof c.at === 'string' && typeof c.unread === 'boolean' && typeof c.mine === 'boolean'
}

// A dm.list result as the summary holds it -> a plain copy, or null.
function summaryPage (p) {
  if (p === null || typeof p !== 'object' || !Array.isArray(p.conversations) || p.conversations.length > SUMMARY_PAGE) return null
  if (!p.conversations.every(validConversation) || typeof p.requests !== 'boolean' || typeof p.inboxUnread !== 'boolean') return null
  const next = p.next
  if (next !== null && (typeof next !== 'object' || typeof next.at !== 'string' || !HEX64.test(next.peer))) return null
  return {
    conversations: p.conversations.map((c) => ({ peer: c.peer, folder: c.folder, preview: c.preview, at: c.at, unread: c.unread, mine: c.mine })),
    next: next === null ? null : { at: next.at, peer: next.peer },
    requests: p.requests,
    inboxUnread: p.inboxUnread
  }
}

function validIndex (data) {
  if (data === null || typeof data !== 'object' || data.v !== 1 || !Array.isArray(data.items)) return []
  return data.items.filter((e) => e !== null && typeof e === 'object' && typeof e.n === 'string' && HEX32.test(e.n) && isCount(e.c, MEDIA_ITEMS_MAX))
    .map((e) => {
      // An entry from before the budget counts as empty; it is the oldest,
      // so the first eviction takes it.
      const o = { n: e.n, c: e.c, b: Number.isSafeInteger(e.b) && e.b >= 0 ? e.b : 0 }
      if (e.w === true) o.w = true
      return o
    })
}

async function readIndex (storage, prefix) {
  try {
    return validIndex(await storage.readJson(prefix + MEDIA_INDEX))
  } catch (err) {
    if (err instanceof SyntaxError) return []
    throw err
  }
}

// cacheBytesMax: tests only.
// summaryDelayMs, loadGate (an async function awaited before the rows
// load): tests only.
function createDmStore ({ storage, cacheBytesMax = CACHE_BYTES_MAX, prefix = '', summaryDelayMs = SUMMARY_DELAY_MS, loadGate = null } = {}) {
  if (storage === null || typeof storage !== 'object') throw new TypeError('storage required')
  if (typeof prefix !== 'string') throw new TypeError('prefix inválido')
  const indexName = prefix + MEDIA_INDEX
  const entryPrefix = prefix + MEDIA_PREFIX
  const summaryName = prefix + SUMMARY
  let key = null
  let corePair = null
  let rows = null
  let lastFiled = 0
  let mediaKey = null
  // Names of the cached messages, loaded with the rows.
  let cached = new Set()
  let generation = 0
  let queue = Promise.resolve()
  // Bumped whenever the rows may differ (load, append, lock): a reader's
  // memo keyed on it never outlives the rows it was built from.
  let version = 0
  // The ctl rows of `version`, frozen: callers share them.
  let opsMemo = null
  // seenKey -> token under the current key; dropped with the key.
  let tokens = new Map()
  // The opened summary (plaintext) and the core length read with it; both
  // dropped with the key.
  let summary = null
  let coreLength = -1
  // The current unlock's key stage and whole unlock; never reject unhandled.
  let keying = Promise.resolve()
  let loading = Promise.resolve()
  let summaryTimer = null
  let summaryNext = null

  function serial (fn) {
    const p = queue.then(fn)
    queue = p.catch(() => {})
    return p
  }

  function wipe () {
    if (key !== null) key.fill(0)
    if (corePair !== null) {
      corePair.secretKey.fill(0)
      corePair.publicKey.fill(0)
    }
    if (mediaKey !== null) mediaKey.fill(0)
    key = null
    mediaKey = null
    corePair = null
    rows = null
    lastFiled = 0
    cached = new Set()
    tokens = new Map()
    opsMemo = null
    summary = null
    coreLength = -1
    dropSummaryWrite()
    version++
  }

  function dropSummaryWrite () {
    if (summaryTimer !== null) clearTimeout(summaryTimer)
    summaryTimer = null
    summaryNext = null
  }

  async function withCore (fn) {
    const core = await store.openDmLocal(storage, corePair, prefix)
    if (core === null) return null
    try {
      return await fn(core)
    } finally {
      await core.close()
    }
  }

  // localKey: 32 bytes, copied. A stored core of another key (another
  // identity, or a reset elsewhere) cannot be read with this key and is
  // replaced by an empty one.
  function unlock (localKey) {
    if (!(localKey instanceof Uint8Array) || localKey.byteLength !== 32) throw new TypeError('chave inválida')
    const copy = new Uint8Array(32)
    copy.set(localKey)
    const gen = ++generation
    const keyed = serial(async () => {
      wipe()
      if (gen !== generation) {
        copy.fill(0)
        return
      }
      const seed = crypto.hash([CORE_SEED_DOMAIN, copy])
      const pair = crypto.keyPair(seed)
      seed.fill(0)
      key = copy
      corePair = pair
      try {
        await readSummary(gen)
      } catch (err) {
        if (key === copy) wipe()
        throw err
      }
      // A superseded unlock leaves nothing of its own behind.
      if (gen !== generation && key === copy) wipe()
    })
    // Queued in the same tick, so nothing runs between the two stages.
    const rowsLoaded = serial(async () => {
      if (gen !== generation || key !== copy) return
      if (loadGate !== null) await loadGate()
      if (gen !== generation || key !== copy) return
      try {
        await load(gen)
      } catch (err) {
        if (key === copy) wipe()
        throw err
      }
      if (gen !== generation && key === copy) wipe()
    })
    keying = keyed
    loading = Promise.all([keyed, rowsLoaded]).then(() => {})
    keying.catch(() => {})
    loading.catch(() => {})
    return loading
  }

  // Runs inside serial(), the key installed: the core's length (-1 for a
  // core of another key, which load() replaces) and the summary, kept only
  // when it opens under this key and names this core.
  async function readSummary (gen) {
    const length = await withCore(async (core) => core.length)
    if (gen !== generation) return
    let data = null
    try {
      data = await storage.readJson(summaryName)
    } catch {}
    if (gen !== generation) return
    coreLength = length === null ? -1 : length
    summary = length === null ? null : openSummary(data)
  }

  function summaryKey () {
    return crypto.hash([SUMMARY_KEY_DOMAIN, key])
  }

  function openSummary (data) {
    if (data === null || typeof data !== 'object' || data.v !== 1 || typeof data.nonce !== 'string' || !HEX48.test(data.nonce) ||
        typeof data.box !== 'string' || !BASE64.test(data.box)) return null
    const box = b4a.from(data.box, 'base64')
    if (box.byteLength <= sodium.crypto_secretbox_MACBYTES) return null
    const plain = b4a.alloc(box.byteLength - sodium.crypto_secretbox_MACBYTES)
    const k = summaryKey()
    let value = null
    try {
      if (sodium.crypto_secretbox_open_easy(plain, box, b4a.from(data.nonce, 'hex'), k)) value = JSON.parse(b4a.toString(plain, 'utf8'))
    } catch {
      value = null
    } finally {
      k.fill(0)
      plain.fill(0)
    }
    if (value === null || typeof value !== 'object' || value.v !== 1) return null
    if (value.core !== b4a.toString(corePair.publicKey, 'hex') || !Number.isSafeInteger(value.length) || value.length < 0) return null
    if (!HEX64.test(value.follows) || !HEX64.test(value.seen)) return null
    const inbox = summaryPage(value.inbox)
    const requests = summaryPage(value.requests)
    if (inbox === null || requests === null) return null
    return { length: value.length, follows: value.follows, seen: value.seen, inbox, requests }
  }

  // follows, seen: sha256 hex of the current kv texts -> copies of the
  // first pages { inbox, requests }, or null when no summary matches them,
  // this core's length and this key.
  function summaryFor ({ follows, seen }) {
    if (key === null || summary === null || coreLength < 0) return null
    if (summary.length !== coreLength || summary.follows !== follows || summary.seen !== seen) return null
    return { inbox: summaryPage(summary.inbox), requests: summaryPage(summary.requests) }
  }

  // The first pages of a fold of the loaded rows at `version` and the
  // digests of what it read; sealed and written after summaryDelayMs, the
  // last call winning, only while that unlock and those rows are current.
  function saveSummary ({ version: v, follows, seen, inbox, requests }) {
    if (rows === null || key === null || v !== version) return
    if (summary !== null && summary.length === coreLength && summary.follows === follows && summary.seen === seen) return
    const a = summaryPage(inbox)
    const b = summaryPage(requests)
    if (a === null || b === null || !HEX64.test(follows) || !HEX64.test(seen)) return
    if (summaryTimer !== null) clearTimeout(summaryTimer)
    summaryNext = { gen: generation, version: v, follows, seen, inbox: a, requests: b }
    summaryTimer = setTimeout(flushSummary, summaryDelayMs)
    if (typeof summaryTimer === 'object' && summaryTimer !== null && typeof summaryTimer.unref === 'function') summaryTimer.unref()
  }

  function flushSummary () {
    summaryTimer = null
    const next = summaryNext
    summaryNext = null
    if (next === null) return
    serial(async () => {
      if (next.gen !== generation || rows === null || key === null || next.version !== version) return
      const plain = { v: 1, core: b4a.toString(corePair.publicKey, 'hex'), length: coreLength, follows: next.follows, seen: next.seen, inbox: next.inbox, requests: next.requests }
      const bytes = b4a.from(JSON.stringify(plain), 'utf8')
      const k = summaryKey()
      let sealed
      try {
        const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
        sodium.randombytes_buf(nonce)
        const box = b4a.alloc(bytes.byteLength + sodium.crypto_secretbox_MACBYTES)
        sodium.crypto_secretbox_easy(box, bytes, nonce, k)
        sealed = { v: 1, nonce: b4a.toString(nonce, 'hex'), box: b4a.toString(box, 'base64') }
      } finally {
        k.fill(0)
        bytes.fill(0)
      }
      await storage.writeJson(summaryName, sealed)
      if (next.gen === generation && key !== null) summary = { length: plain.length, follows: plain.follows, seen: plain.seen, inbox: plain.inbox, requests: plain.requests }
    }).catch(() => {})
  }

  async function load (gen) {
    let length = 0
    let loaded = await withCore(async (core) => {
      const out = []
      length = core.length
      for (let i = 0; i < length; i++) {
        const block = await core.get(i, { wait: false })
        if (block === null || typeof block !== 'object' || block.v !== 1) continue
        const row = gc.openRecord({ nonce: block.nonce, box: block.box }, key)
        if (row !== null && validRow(row)) out.push(plainRow(row))
      }
      return out
    })
    // Only the current unlock may replace a core of another key.
    if (gen !== generation) return
    if (loaded === null) {
      await store.deleteDmLocal(storage, prefix)
      if (gen !== generation) return
      await storage.writeJson(summaryName, null)
      if (gen !== generation) return
      // Another key's cache cannot be opened with this one. A lock during
      // the wipe stops it: what is left stays indexed for a later wipe.
      if (!(await wipeEntries(() => gen === generation))) return
      loaded = []
      length = 0
      summary = null
    }
    if (gen !== generation) return
    const index = await readIndex(storage, prefix)
    if (gen !== generation) return
    rows = loaded
    coreLength = length
    version++
    mediaKey = crypto.hash([MEDIA_KEY_DOMAIN, key])
    cached = new Set(index.filter((e) => e.w !== true).map((e) => e.n))
    for (const r of rows) if (r.filedAt > lastFiled) lastFiled = r.filedAt
  }

  function lock () {
    generation++
    wipe()
  }

  // The rows are loaded.
  function unlocked () {
    return rows !== null
  }

  // The key is installed (the rows may still be loading).
  function keyReady () {
    return key !== null
  }

  // Settles once the current unlock installed its key and read the summary
  // (rejects when that failed).
  function keyStage () {
    return keying
  }

  // Settles once the current unlock's rows load (rejects when it failed).
  function loaded () {
    return loading
  }

  // A monotonic local filing time in ms.
  function nextFiled (now = Date.now()) {
    lastFiled = Math.max(Math.floor(now), lastFiled + 1)
    return lastFiled
  }

  // Seals and appends the rows (one block each), then adds them to memory.
  function append (list) {
    const gen = generation
    return serial(async () => {
      if (rows === null || gen !== generation) throw new Error(LOCKED)
      if (!list.every(validRow)) throw new TypeError('linha inválida')
      const clean = list.map(plainRow)
      const blocks = clean.map((r) => ({ v: 1, ...gc.sealRecord(padded(r), key) }))
      const ok = await withCore(async (core) => {
        await core.append(blocks)
        return true
      })
      if (ok === null) throw new Error('armazenamento de mensagens inválido')
      if (gen !== generation || rows === null) return
      for (const r of clean) rows.push(r)
      coreLength += blocks.length
      version++
    })
  }

  // -> { messages, ops, reactions } as copies; throws while locked.
  function snapshot () {
    if (rows === null) throw new Error(LOCKED)
    return {
      messages: rows.filter((r) => r.t === 'msg').map(plainRow),
      ops: rows.filter((r) => r.t === 'ctl').map(plainRow),
      reactions: rows.filter((r) => r.t === 'rx').map(plainRow)
    }
  }

  function currentVersion () {
    return version
  }

  // -> the ctl rows as one frozen array, shared until the next version;
  // throws while locked. A caller that adds to it copies it first.
  function ops () {
    if (rows === null) throw new Error(LOCKED)
    if (opsMemo === null || opsMemo.version !== version) {
      const list = rows.filter((r) => r.t === 'ctl').map((r) => Object.freeze(plainRow(r)))
      opsMemo = { version, list: Object.freeze(list) }
    }
    return opsMemo.list
  }

  function hasMessage (from, id) {
    if (rows === null) return false
    return rows.some((r) => r.t === 'msg' && r.from === from && r.id === id)
  }

  // A reaction op, by its signer and id.
  function hasReaction (from, id) {
    if (rows === null) return false
    return rows.some((r) => r.t === 'rx' && r.from === from && r.id === id)
  }

  // The highest stored rev of `from`'s reaction to target in the
  // conversation with peer, 0 when there is none.
  function reactionRev (peer, target, from) {
    if (rows === null) throw new Error(LOCKED)
    let rev = 0
    for (const r of rows) {
      if (r.t === 'rx' && r.peer === peer && r.from === from && r.target.from === target.from && r.target.id === target.id && r.target.digest === target.digest && r.rev > rev) rev = r.rev
    }
    return rev
  }

  function hasOp (id) {
    if (rows === null) return false
    return rows.some((r) => r.t === 'ctl' && r.id === id)
  }

  // The kv dmSeen token of a seen key: keyed by the local store key, so a
  // reader of kv without the passkey learns no sender.
  function seenToken (keyString) {
    if (key === null) throw new Error(LOCKED)
    let t = tokens.get(keyString)
    if (t === undefined) {
      t = b4a.toString(crypto.hash([SEEN_DOMAIN, key, b4a.from(keyString, 'utf8')]), 'hex').slice(0, 32)
      tokens.set(keyString, t)
    }
    return t
  }

  // A small kv value (the stamp wallet, the ctl queue) sealed under the same
  // local key -> { nonce, box }; throws while locked.
  function seal (value) {
    if (key === null) throw new Error(LOCKED)
    return gc.sealRecord(value, key)
  }

  // -> the value or null (wrong key, tampered); throws while locked.
  function open (sealed) {
    if (key === null) throw new Error(LOCKED)
    return gc.openRecord(sealed, key)
  }

  // Bytes past seal's record bound (a legacy bundle chunk, ./dm.js), under a
  // key of their own derived from the local key -> { nonce, box }.
  function sealBytes (bytes) {
    if (key === null) throw new Error(LOCKED)
    const k = crypto.hash([BYTES_DOMAIN, key])
    try {
      const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
      sodium.randombytes_buf(nonce)
      const box = b4a.alloc(bytes.byteLength + sodium.crypto_secretbox_MACBYTES)
      sodium.crypto_secretbox_easy(box, bytes, nonce, k)
      return { nonce: b4a.toString(nonce, 'hex'), box: b4a.toString(box, 'base64') }
    } finally {
      k.fill(0)
    }
  }

  // -> the bytes or null (wrong key, tampered); throws while locked.
  function openBytes (sealed) {
    if (key === null) throw new Error(LOCKED)
    const k = crypto.hash([BYTES_DOMAIN, key])
    try {
      const box = b4a.from(sealed.box, 'base64')
      if (box.byteLength < sodium.crypto_secretbox_MACBYTES) return null
      const out = b4a.alloc(box.byteLength - sodium.crypto_secretbox_MACBYTES)
      return sodium.crypto_secretbox_open_easy(out, box, b4a.from(sealed.nonce, 'hex'), k) ? out : null
    } catch {
      return null
    } finally {
      k.fill(0)
    }
  }

  // ---- the media cache ----

  function mediaName (from, id) {
    if (key === null) throw new Error(LOCKED)
    return b4a.toString(crypto.hash([MEDIA_NAME_DOMAIN, key, b4a.from(from + '\n' + id, 'utf8')]), 'hex').slice(0, 32)
  }

  function hasMedia (from, id) {
    if (rows === null) return false
    return cached.has(mediaName(from, id))
  }

  // Seals and stores the plaintext of every item of message (from, id), in
  // order; a write after a lock is dropped. The items are copied before
  // anything is awaited, so the caller may wipe its buffers at once. The
  // index names the entry (marked unfinished, w) before any item is
  // written: an interrupted write leaves nothing wipeCache cannot find, and
  // an unfinished entry never reads as cached. Room is made first: the
  // oldest entries are wiped (marked unfinished, then their items, then
  // dropped from the index) until the new one fits the budget. -> true when cached, false when the
  // items alone exceed the budget (nothing is written then).
  function putMedia (from, id, items) {
    if (!Array.isArray(items) || !isCount(items.length, MEDIA_ITEMS_MAX) || !items.every((b) => b instanceof Uint8Array && b.byteLength > 0)) {
      throw new TypeError('mídia inválida')
    }
    const gen = generation
    const copies = items.map((b) => new Uint8Array(b))
    const p = serial(async () => {
      if (rows === null || gen !== generation) throw new Error(LOCKED)
      const size = copies.reduce((n, b) => n + b.byteLength, 0)
      if (size > cacheBytesMax) return false
      const name = mediaName(from, id)
      cached.delete(name)
      const all = await readIndex(storage, prefix)
      const index = all.filter((e) => e.n !== name)
      let total = index.reduce((n, e) => n + e.b, 0)
      const evicted = []
      while (index.length > 0 && total + size > cacheBytesMax) {
        const e = index.shift()
        total -= e.b
        evicted.push(e)
      }
      // A larger earlier entry of the same name stays indexed until its
      // extra items are cleared.
      const c = Math.max(copies.length, ...all.filter((e) => e.n === name).map((e) => e.c))
      // The evicted entries are marked unfinished before their items go: an
      // interrupted eviction never leaves a finished entry without items,
      // and the index still names every item a wipe must find.
      for (const e of evicted) cached.delete(e.n)
      const stale = evicted.map((e) => ({ n: e.n, c: e.c, b: e.b, w: true }))
      await storage.writeJson(indexName, { v: 1, items: [...stale, ...index, { n: name, c, b: size, w: true }] })
      for (const e of evicted) {
        for (let i = 0; i < e.c; i++) await storage.writeJson(entryPrefix + e.n + '/' + i, null)
      }
      if (rows === null || gen !== generation) throw new Error(LOCKED)
      if (evicted.length > 0) await storage.writeJson(indexName, { v: 1, items: [...index, { n: name, c, b: size, w: true }] })
      for (let i = 0; i < copies.length; i++) {
        if (rows === null || gen !== generation) throw new Error(LOCKED)
        const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
        sodium.randombytes_buf(nonce)
        const box = b4a.alloc(copies[i].byteLength + sodium.crypto_secretbox_MACBYTES)
        sodium.crypto_secretbox_easy(box, copies[i], nonce, mediaKey)
        await storage.writeJson(entryPrefix + name + '/' + i, { v: 1, nonce: b4a.toString(nonce, 'hex'), box: b4a.toString(box, 'base64') })
      }
      for (let i = copies.length; i < c; i++) await storage.writeJson(entryPrefix + name + '/' + i, null)
      if (rows === null || gen !== generation) throw new Error(LOCKED)
      await storage.writeJson(indexName, { v: 1, items: [...index, { n: name, c: copies.length, b: size }] })
      if (gen === generation && rows !== null) cached.add(name)
      return true
    })
    const clear = () => { for (const b of copies) b.fill(0) }
    p.then(clear, clear)
    return p
  }

  // -> the items' plaintext (fresh buffers the caller owns), or null when
  // not cached or any entry fails to open; throws while locked.
  function getMedia (from, id) {
    const gen = generation
    return serial(async () => {
      if (rows === null || gen !== generation) throw new Error(LOCKED)
      const name = mediaName(from, id)
      if (!cached.has(name)) return null
      const entry = (await readIndex(storage, prefix)).find((e) => e.n === name)
      if (entry === undefined || entry.w === true) return null
      const out = []
      for (let i = 0; i < entry.c; i++) {
        let v = null
        try { v = await storage.readJson(entryPrefix + name + '/' + i) } catch {}
        const plain = openEntry(v)
        if (plain === null) {
          for (const b of out) b.fill(0)
          // A lost or damaged item: the entry no longer reads as cached, so
          // the next read downloads the media again.
          if (gen === generation && rows !== null) await markUnfinished(name)
          return null
        }
        out.push(plain)
      }
      if (gen !== generation || rows === null) {
        for (const b of out) b.fill(0)
        throw new Error(LOCKED)
      }
      return out
    })
  }

  // Runs inside serial(): the entry stays indexed (a wipe finds its items)
  // but never reads as cached again, after a reopen too.
  async function markUnfinished (name) {
    cached.delete(name)
    const index = await readIndex(storage, prefix)
    if (!index.some((e) => e.n === name && e.w !== true)) return
    await storage.writeJson(indexName, { v: 1, items: index.map((e) => e.n === name ? { ...e, w: true } : e) })
  }

  function openEntry (v) {
    if (v === null || typeof v !== 'object' || v.v !== 1 || typeof v.nonce !== 'string' || !HEX48.test(v.nonce) ||
        typeof v.box !== 'string' || !BASE64.test(v.box)) return null
    const box = b4a.from(v.box, 'base64')
    if (box.byteLength <= sodium.crypto_secretbox_MACBYTES) return null
    const plain = b4a.alloc(box.byteLength - sodium.crypto_secretbox_MACBYTES)
    let ok = false
    try {
      ok = sodium.crypto_secretbox_open_easy(plain, box, b4a.from(v.nonce, 'hex'), mediaKey)
    } catch {}
    if (!ok) return null
    return plain
  }

  // live: checked after every await; once false the wipe stops, the index
  // still naming what is left. -> true when everything was wiped.
  async function wipeEntries (live = () => true) {
    const index = await readIndex(storage, prefix)
    if (!live()) return false
    for (const e of index) {
      for (let i = 0; i < e.c; i++) {
        await storage.writeJson(entryPrefix + e.n + '/' + i, null)
        if (!live()) return false
      }
    }
    await storage.writeJson(indexName, null)
    if (!live()) return false
    cached = new Set()
    return true
  }

  // Deletes every cached item and the summary; needs no key (lock, sign-out
  // and reset). Queued behind every write already issued.
  function wipeCache () {
    dropSummaryWrite()
    return serial(async () => {
      await storage.writeJson(summaryName, null)
      summary = null
      return wipeEntries()
    })
  }

  function idle () {
    return queue
  }

  function close () {
    lock()
    return queue
  }

  return { unlock, lock, unlocked, keyReady, keyStage, loaded, summaryFor, saveSummary, nextFiled, append, snapshot, ops, version: currentVersion, hasMessage, hasReaction, reactionRev, hasOp, seenToken, seal, open, sealBytes, openBytes, hasMedia, putMedia, getMedia, wipeCache, idle, close }
}

module.exports = { createDmStore, SUMMARY_PAGE }
