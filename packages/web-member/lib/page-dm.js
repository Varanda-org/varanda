'use strict'

// A Página's secrets on this device (docs/rpc.md 5.114, docs/protocol.md
// section 12): the holder behind dm.pageGenerate, dm.pageShare,
// dm.pageSecrets and dm.pageForget, owned by the dm engine (./dm.js). The
// account service only ever sees the secrets sealed to a member's dm-key box.
//
// At rest: kv pageSecrets (./node-store.js readPageSecrets), each page's two
// seeds (dmSeed || groupSeed) and its legacy gen 1 box secret, when it has
// one, in a secretbox under the identity's dm local key (passkey.js
// dmLocalKeyFromPrf). In memory, only while unlocked: the opened seeds and
// the pairs they derive (the page dm box of the held gen, the legacy box,
// the group box) and the dm boxes of up to MAX_PREVIOUS gens held before,
// kept sealed beside them for reading only: drops senders sealed to an old
// box before they saw the new dm-key still open. lock() zeroes all of it, the secrets generated and not
// yet adopted, and the page drafts; an identity change and a reset lock.
//
// Generated secrets wait in memory for PENDING_MS, so the owner adopts them
// through its own share without the service ever opening anything.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const ps = require('@varanda/core/lib/page-secrets')
const { certForKey } = require('@varanda/core/lib/cert')
const { UsageError } = require('@varanda/core/lib/errors')
const sodium = require('./sodium-browser')
const store = require('./node-store')

const LOCKED = store.LOCKED
const NO_PAGE_KEY = 'sem chave da página'
const KEY_MISMATCH = 'chave da página não confere'
const BAD_SIGNATURE = 'assinatura inválida'
const BAD_RECIPIENTS = 'destinatários inválidos'
const PENDING_MS = 600000
const SEED_BYTES = 32
const MAX_PREVIOUS = 3
const LOCAL_DOMAIN = b4a.from('varanda/member-dm-local/page/v1\n', 'utf8')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function wipe (buf) {
  if (buf instanceof Uint8Array) sodium.sodium_memzero(buf)
}

function zeroPair (pair) {
  if (pair === null || pair === undefined) return
  wipe(pair.publicKey)
  wipe(pair.secretKey)
}

function sealBytes (bytes, key) {
  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)
  const box = b4a.alloc(bytes.byteLength + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(box, bytes, nonce, key)
  return { nonce: hex(nonce), box: b4a.toString(box, 'base64') }
}

// -> the plaintext (caller wipes) of exactly `len` bytes, or null.
function openBytes (sealed, key, len) {
  try {
    const box = b4a.from(sealed.box, 'base64')
    if (box.byteLength !== len + sodium.crypto_secretbox_MACBYTES) return null
    const out = b4a.alloc(len)
    if (!sodium.crypto_secretbox_open_easy(out, box, b4a.from(sealed.nonce, 'hex'), key)) {
      wipe(out)
      return null
    }
    return out
  } catch {
    return null
  }
}

// The legacy box: the X25519 secret the service held for gen 1.
function legacyPair (secret) {
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_scalarmult_base(publicKey, secret)
  return { publicKey, secretKey: secret }
}

function seedsOf (secrets) {
  return b4a.concat([secrets.dmSeed, secrets.groupSeed])
}

function copySecrets (s) {
  return { dmSeed: b4a.from(s.dmSeed), groupSeed: b4a.from(s.groupSeed) }
}

// association: hex64. now: tests only.
function createPageHolder ({ storage, association, now = Date.now } = {}) {
  if (storage === null || typeof storage !== 'object') throw new TypeError('storage required')
  let key = null
  let generation = 0
  // page -> { gen, secrets, dmBox, groupBox, legacy: { gen, box, page } | null, previous: [{ gen, box }], cert, stored }
  const held = new Map()
  // page -> { gen, secrets, expires }
  const pending = new Map()
  // Pages whose published dm-key differs from the held box (./dm.js pull).
  const mismatch = new Set()
  // Page drafts of ./dm.js, kept here so lock wipes them with the secrets.
  const drafts = new Map()
  // page -> the highest gen ever held here (kv pageMaxGen): read at unlock,
  // kept by forget, so a lower share is never adopted again.
  const maxGen = new Map()

  function unlocked () {
    return key !== null
  }

  function requireUnlocked () {
    if (!unlocked()) throw new UsageError(LOCKED)
  }

  function dropEntry (e) {
    if (e === undefined) return
    ps.wipeSecrets(e.secrets)
    zeroPair(e.dmBox)
    zeroPair(e.groupBox)
    if (e.legacy !== null) zeroPair(e.legacy.box)
    for (const p of e.previous) zeroPair(p.box)
  }

  function dropPending (page) {
    const p = pending.get(page)
    if (p !== undefined) ps.wipeSecrets(p.secrets)
    pending.delete(page)
  }

  function sweep () {
    const t = now()
    for (const [page, p] of [...pending]) if (p.expires <= t) dropPending(page)
    for (const [id, d] of [...drafts]) {
      if (d.expires <= t) {
        wipe(d.json)
        drafts.delete(id)
      }
    }
  }

  function entryOf (page, stored) {
    const plain = openBytes(stored.sealed, key, 2 * SEED_BYTES)
    if (plain === null) return null
    const secrets = { dmSeed: b4a.from(plain.subarray(0, SEED_BYTES)), groupSeed: b4a.from(plain.subarray(SEED_BYTES)) }
    wipe(plain)
    let pairs
    try {
      pairs = ps.pairsOf(secrets)
    } catch {
      ps.wipeSecrets(secrets)
      return null
    }
    let legacy = null
    if (stored.legacy !== null) {
      // secret || the page key it was the box of (a bundle carried over on
      // a move names an earlier key), or the secret alone for this page.
      const both = openBytes(stored.legacy.sealed, key, 2 * SEED_BYTES)
      if (both !== null) {
        legacy = { gen: stored.legacy.gen, box: legacyPair(b4a.from(both.subarray(0, SEED_BYTES))), page: hex(both.subarray(SEED_BYTES)) }
        wipe(both)
      } else {
        const secret = openBytes(stored.legacy.sealed, key, SEED_BYTES)
        if (secret !== null) legacy = { gen: stored.legacy.gen, box: legacyPair(secret), page }
      }
    }
    const previous = []
    for (const p of stored.previous || []) {
      const secret = openBytes(p.sealed, key, SEED_BYTES)
      if (secret !== null) previous.push({ gen: p.gen, box: legacyPair(secret), sealed: p.sealed })
    }
    return { gen: stored.gen, secrets, dmBox: pairs.dmBox, groupBox: pairs.groupBox, legacy, previous, cert: stored.cert, stored }
  }

  // localKey: the dm local key (32 bytes), copied. An entry that does not
  // open under it (another identity's) is left out.
  async function unlock (localKey) {
    if (!(localKey instanceof Uint8Array) || localKey.byteLength !== 32) throw new TypeError('chave inválida')
    lock()
    const gen = generation
    const copy = b4a.from(localKey)
    const stored = await store.readPageSecrets(storage)
    const gens = await store.readPageMaxGen(storage)
    if (gen !== generation) {
      wipe(copy)
      return
    }
    key = copy
    for (const [page, g] of Object.entries(gens)) maxGen.set(page, g)
    for (const [page, s] of Object.entries(stored)) {
      const e = entryOf(page, s)
      if (e !== null) {
        held.set(page, e)
        noteGen(page, e.gen)
      }
    }
  }

  function noteGen (page, g) {
    if (!(maxGen.get(page) >= g)) maxGen.set(page, g)
  }

  function lock () {
    generation++
    for (const e of held.values()) dropEntry(e)
    held.clear()
    for (const page of [...pending.keys()]) dropPending(page)
    for (const d of drafts.values()) wipe(d.json)
    drafts.clear()
    mismatch.clear()
    maxGen.clear()
    wipe(key)
    key = null
  }

  function pages () {
    return [...held.keys()]
  }

  // -> { gen, dmBox, legacy, groupBox, cert } (the holder's own buffers:
  // never handed out of the node), or null.
  function get (page) {
    if (!unlocked()) return null
    return held.get(page) || null
  }

  function need (page) {
    requireUnlocked()
    const e = held.get(page)
    if (e === undefined) throw new UsageError(NO_PAGE_KEY)
    return e
  }

  function groupBoxOf (page) {
    const e = get(page)
    return e === null ? null : e.groupBox
  }

  // The key a page's local store (./dm-store.js under its prefix) derives
  // from: one per page and identity. Caller wipes.
  function localKeyOf (page) {
    requireUnlocked()
    return crypto.hash([LOCAL_DOMAIN, key, b4a.from(page, 'hex')])
  }

  // pageMaxGen first: a share is never held without its gen noted.
  // override: { page, stored } written in place of that page's entry, so a
  // change reaches memory only once it is durable.
  async function persist (override = null) {
    const out = {}
    for (const [page, e] of held) out[page] = override !== null && override.page === page ? override.stored : e.stored
    await store.writePageMaxGen(storage, Object.fromEntries(maxGen))
    await store.writePageSecrets(storage, out)
  }

  function shareFor (secrets, { page, gen, member, box }, identity) {
    let sealed
    try {
      sealed = ps.sealSecrets(secrets, { page, gen, member, box })
    } catch {
      throw new UsageError(BAD_RECIPIENTS)
    }
    return { member, sealed, sig: ps.signShare({ page, gen, member, sealed }, identity) }
  }

  // dm.pageGenerate. own: the caller identity, which must be a recipient.
  function generate (own, identity, { page, gen, recipients }) {
    requireUnlocked()
    sweep()
    if (!recipients.some((r) => r.member === own) || new Set(recipients.map((r) => r.member)).size !== recipients.length) {
      throw new UsageError(BAD_RECIPIENTS)
    }
    const secrets = ps.newPageSecrets()
    let pairs = null
    try {
      pairs = ps.pairsOf(secrets)
      const shares = recipients.map((r) => shareFor(secrets, { page, gen, member: r.member, box: r.box }, identity))
      const out = { box: hex(pairs.dmBox.publicKey), groupBox: hex(pairs.groupBox.publicKey), shares }
      dropPending(page)
      pending.set(page, { gen, secrets, expires: now() + PENDING_MS })
      return out
    } catch (err) {
      ps.wipeSecrets(secrets)
      throw err
    } finally {
      if (pairs !== null) {
        zeroPair(pairs.dmBox)
        zeroPair(pairs.groupBox)
      }
    }
  }

  // dm.pageShare: the held secrets for one more member.
  function share (identity, { page, member, box }) {
    const e = need(page)
    const s = shareFor(e.secrets, { page, gen: e.gen, member, box }, identity)
    return { gen: e.gen, sealed: s.sealed, sig: s.sig }
  }

  // dm.pageSecrets. ownBox: the identity's dm box pair (opens the share).
  // r: { owner, admins } of the page's current roster, read by the caller
  // beforehand. -> { changed }: true when the held gen or box is new (the
  // page's pool cursor starts over then). The legacy box comes with the
  // legacy bundle instead (setLegacy). A new gen keeps the held legacy box.
  async function adopt (own, ownBox, r, { page, gen, sealed, by, sig, box, groupBox, cert }) {
    requireUnlocked()
    sweep()
    const g = generation
    if (!ps.verifyShare({ page, gen, member: own, sealed }, sig, by)) throw new UsageError(BAD_SIGNATURE)
    if (!certForKey(cert, page, association).ok) throw new UsageError(KEY_MISMATCH)
    if (r === null || typeof r !== 'object' || (r.owner !== by && !(Array.isArray(r.admins) && r.admins.includes(by)))) {
      throw new UsageError(KEY_MISMATCH)
    }
    // A share older than one held here before (forgotten since or not) is a
    // replay: never rolled back to.
    if (maxGen.has(page) && gen < maxGen.get(page)) throw new UsageError(KEY_MISMATCH)
    const known = held.get(page)
    const same = known !== undefined && known.gen === gen && hex(known.dmBox.publicKey) === box && hex(known.groupBox.publicKey) === groupBox
    let entry = null
    if (!same) {
      const p = pending.get(page)
      let secrets = null
      if (p !== undefined && p.gen === gen) {
        const pp = ps.pairsOf(p.secrets)
        if (hex(pp.dmBox.publicKey) === box) secrets = copySecrets(p.secrets)
        zeroPair(pp.dmBox)
        zeroPair(pp.groupBox)
      }
      if (secrets === null) secrets = ps.openSecrets(sealed, ownBox, { page, gen, member: own })
      if (secrets === null) throw new UsageError(KEY_MISMATCH)
      let pairs
      try {
        pairs = ps.pairsOf(secrets)
      } catch {
        ps.wipeSecrets(secrets)
        throw new UsageError(KEY_MISMATCH)
      }
      if (hex(pairs.dmBox.publicKey) !== box || hex(pairs.groupBox.publicKey) !== groupBox) {
        ps.wipeSecrets(secrets)
        zeroPair(pairs.dmBox)
        zeroPair(pairs.groupBox)
        throw new UsageError(KEY_MISMATCH)
      }
      const plain = seedsOf(secrets)
      // The replaced box joins the previous ones (newest first), for reading.
      const previous = []
      const storedPrevious = []
      if (known !== undefined) {
        const newBox = hex(pairs.dmBox.publicKey)
        const keep = [{ gen: known.gen, box: known.dmBox, sealed: null }, ...known.previous]
        const seen = new Set([newBox])
        for (const k of keep) {
          const pub = hex(k.box.publicKey)
          if (seen.has(pub) || previous.length >= MAX_PREVIOUS) continue
          seen.add(pub)
          const sealed = k.sealed === null ? sealBytes(k.box.secretKey, key) : k.sealed
          previous.push({ gen: k.gen, box: { publicKey: b4a.from(k.box.publicKey), secretKey: b4a.from(k.box.secretKey) }, sealed })
          storedPrevious.push({ gen: k.gen, sealed })
        }
      }
      const stored = { gen, sealed: sealBytes(plain, key), legacy: known === undefined ? null : known.stored.legacy, cert, previous: storedPrevious }
      wipe(plain)
      entry = { gen, secrets, dmBox: pairs.dmBox, groupBox: pairs.groupBox, legacy: null, previous, cert, stored }
      if (known !== undefined && known.legacy !== null) {
        entry.legacy = { gen: known.legacy.gen, box: { publicKey: b4a.from(known.legacy.box.publicKey), secretKey: b4a.from(known.legacy.box.secretKey) }, page: known.legacy.page }
      }
    } else {
      entry = known
      // Same keys, a replacement certificate (it verified above): only the
      // cert changes, no key buffer is touched.
      if (JSON.stringify(known.cert) !== JSON.stringify(cert)) {
        known.cert = cert
        known.stored = { ...known.stored, cert }
      }
    }
    if (g !== generation) {
      if (entry !== known) dropEntry(entry)
      throw new UsageError(LOCKED)
    }
    if (entry !== known) {
      held.set(page, entry)
      if (known !== undefined) dropEntry(known)
    }
    noteGen(page, gen)
    if (!same) {
      mismatch.delete(page)
      dropPending(page)
    }
    await persist()
    return { changed: !same }
  }

  // Whether `secret` is the held legacy box -> null when none is held.
  function legacyMatches (page, secret) {
    const e = need(page)
    if (e.legacy === null) return null
    const probe = legacyPair(b4a.from(secret))
    try {
      return e.legacy.gen === 1 && b4a.equals(e.legacy.box.publicKey, probe.publicKey)
    } finally {
      zeroPair(probe)
    }
  }

  // The legacy bundle's gen 1 box secret (dm.pageLegacyChunk), taken over
  // (caller wipes `secret`). -> whether the legacy box is new here. Another
  // legacy box held already is never replaced. Written before memory
  // changes: after a failed write the retry writes again. owner: the page
  // key the box was published for (an earlier key for a carried bundle);
  // drops it opens are checked against that key.
  async function setLegacy (page, secret, owner = page) {
    const e = need(page)
    const same = legacyMatches(page, secret)
    if (same === true) return false
    if (same === false) throw new UsageError(KEY_MISMATCH)
    const plain = b4a.concat([secret, b4a.from(owner, 'hex')])
    let stored
    try {
      stored = { ...e.stored, legacy: { gen: 1, sealed: sealBytes(plain, key) } }
    } finally {
      wipe(plain)
    }
    await persist({ page, stored })
    // A lock or an adoption meanwhile replaced the entry: the bundle stays
    // not done, so the next try sets the box again.
    if (held.get(page) !== e) throw new UsageError(NO_PAGE_KEY)
    e.legacy = { gen: 1, box: legacyPair(b4a.from(secret)), page: owner }
    e.stored = stored
    return true
  }

  async function forget (page) {
    requireUnlocked()
    dropEntry(held.get(page))
    held.delete(page)
    dropPending(page)
    mismatch.delete(page)
    for (const [id, d] of [...drafts]) {
      if (d.page === page) {
        wipe(d.json)
        drafts.delete(id)
      }
    }
    await persist()
  }

  function setMismatch (page, on) {
    if (on) mismatch.add(page)
    else mismatch.delete(page)
  }

  function requireMatch (page) {
    if (mismatch.has(page)) throw new UsageError(KEY_MISMATCH)
  }

  function putDraft (id, draft) {
    requireUnlocked()
    sweep()
    drafts.set(id, { ...draft, expires: now() + PENDING_MS })
  }

  // -> the draft (still held) or null when missing or expired.
  function draftOf (page, id) {
    if (!unlocked()) return null
    sweep()
    const d = drafts.get(id)
    return d !== undefined && d.page === page ? d : null
  }

  function dropDraft (id) {
    const d = drafts.get(id)
    if (d === undefined) return
    wipe(d.json)
    drafts.delete(id)
  }

  return {
    unlock,
    lock,
    unlocked,
    pages,
    get,
    need,
    groupBoxOf,
    localKeyOf,
    generate,
    share,
    adopt,
    legacyMatches,
    setLegacy,
    forget,
    setMismatch,
    requireMatch,
    putDraft,
    draftOf,
    dropDraft,
    get pendingCount () { return pending.size }
  }
}

module.exports = { createPageHolder, NO_PAGE_KEY, KEY_MISMATCH, BAD_SIGNATURE, BAD_RECIPIENTS, PENDING_MS }
