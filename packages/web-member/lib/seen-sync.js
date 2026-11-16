'use strict'

// The seen-sync engine of the browser node (docs/rpc.md 5.95 seen.sign and
// 5.96 seen.merge): signs the account service's seen statements and merges
// the member's encrypted seen document (@varanda/core lib/seen-blob.js) with
// this device's kv dmSeen, groupSeen, memberBlocks, testimonialDecisions,
// momentSeen and seenLocal.
//
// Local writes are unions at the LOCAL caps, never the trimmed merge: kv
// dmSeen keeps up to MAX_DM_SEEN tokens while the shared document holds a
// window of SYNC_DM_MAX, and a remote group mark reaches kv groupSeen only
// through member-ops groupSeen, whose forward rule needs the group core (a
// mark never moves backwards, whatever `at` its author wrote, and a post
// this node does not hold yet writes nothing; the next pass retries).
//
// The key is derived per call from the identity seed and zeroed after use:
// no passkey PRF is involved, so the worklet host can sync too.

const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const seenBlob = require('@varanda/core/lib/seen-blob')
const { HASH_NONE, blobHash, signSeen } = require('@varanda/core/lib/seen-proof')
const { blockedKeys, mergeBlocks } = require('@varanda/core/lib/member-block')
const { mergeDecisions, sameDecisions } = require('@varanda/core/lib/testimonial-decision')
const { mergeMomentSeen, sameMomentSeen } = require('@varanda/core/lib/moment-seen')
const { UsageError } = require('@varanda/core/lib/errors')
const store = require('./node-store')
const member = require('./member-ops')

const IGNORED_LINE = 'aviso: estado de vistos ignorado'
const NEWER_FORMAT = 'estado de vistos de uma versão mais nova: atualize o app'
const U32_MAX = 4294967295
const CAUGHT_UP_MAX = 512
const READER_ROLES = new Set(['creator', 'admin', 'member'])

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function nowSec () {
  return Math.min(Math.floor(Date.now() / 1000), U32_MAX)
}

function emptyDoc (gen, own, association) {
  return { gen, member: own, association, avisos: { own: [], pages: {} }, dm: [], groups: [], blocks: [], testimonials: [], moments: [] }
}

function sameMark (a, b) {
  return a.writer === b.writer && a.seq === b.seq && a.at === b.at
}

// Adds the tokens a list lacks, each with time t; a token already there
// keeps its own time, so a repeated mark changes nothing.
function addTokens (list, tokens, t) {
  const have = new Set(list.map((e) => e.token))
  const out = list.slice()
  for (const token of tokens) {
    if (have.has(token)) continue
    have.add(token)
    out.push({ token, t })
  }
  return out
}

// This device's view for a merge or a write (uncapped): the stored canonical
// document, plus the dmSeen tokens marked here since (kv dmSeen is newest
// last; a token older than the newest one the document already holds was
// cut from its window on purpose and is not offered again, else it would
// come back as new on every pass), plus the kv group marks, plus the Avisos
// tokens the app supplies, plus the member's own block list (kv memberBlocks),
// depoimento decisions (kv testimonialDecisions) and seen momentos (kv
// momentSeen).
//
// Once the document holds dm tokens, every token marked here since ranks
// above all of them, else a batch made seconds after a sync interleaves with
// the synced one and the window cut drops new marks that then never sync.
// Each mark of a batch gets its own second, newest last, so a batch larger
// than the window keeps its newest marks: one shared t would leave the cut
// to token order. The first merge backdates (newest last), so a device
// seeding thousands of old marks keeps the newest of them.
//
// held: the avisos tokens a stored or remote document already carried. An
// offered token the stored document no longer has was cut from the window
// as too old: it is not stamped as a new mark again, else it would push a
// newer mark out and come back as new on the other devices.
function localView (base, dmIds, marks, avisos, now, blocks = [], held = null, testimonials = [], moments = []) {
  const inBase = new Set(base.dm.map((e) => e.token))
  let last = -1
  for (let i = dmIds.length - 1; i >= 0; i--) {
    if (inBase.has(dmIds[i])) { last = i; break }
  }
  const fresh = []
  for (let i = last + 1; i < dmIds.length; i++) {
    if (!inBase.has(dmIds[i])) fresh.push(dmIds[i])
  }
  const dm = base.dm.slice()
  const seen = new Set(inBase)
  const n = fresh.length
  let top = -1
  for (const e of base.dm) if (e.t > top) top = e.t
  for (let i = 0; i < n; i++) {
    if (seen.has(fresh[i])) continue
    seen.add(fresh[i])
    const t = top < 0 ? Math.max(0, now - (n - 1 - i)) : Math.min(Math.max(now - (n - 1 - i), top + 1 + i), U32_MAX)
    dm.push({ token: fresh[i], t })
  }

  let own = base.avisos.own
  const pages = { ...base.avisos.pages }
  if (avisos) {
    const uncut = (list) => held === null ? list : list.filter((tk) => !held.has(tk))
    own = addTokens(own, uncut(avisos.own || []), now)
    for (const key of Object.keys(avisos.pages || {})) {
      pages[key] = addTokens(pages[key] || [], uncut(avisos.pages[key]), now)
    }
  }
  const groups = base.groups.slice()
  for (const m of marks) groups.push({ group: m.group, at: m.at, writer: m.writer, seq: m.seq })
  return { gen: base.gen, member: base.member, association: base.association, avisos: { own, pages }, dm, groups, blocks: mergeBlocks(base.blocks, blocks), testimonials: mergeDecisions(base.testimonials, testimonials), moments: mergeMomentSeen(base.moments, moments) }
}

// Every avisos token of a document, own and pages.
function avisosTokens (doc) {
  const out = doc.avisos.own.map((e) => e.token)
  for (const key of Object.keys(doc.avisos.pages)) for (const e of doc.avisos.pages[key]) out.push(e.token)
  return out
}

// A uniform integer in [0, n), n <= 65536, by rejection over u16 draws.
function randomBelow (n) {
  const limit = Math.floor(65536 / n) * n
  for (;;) {
    const r = crypto.randomBytes(2)
    const x = r[0] | (r[1] << 8)
    if (x < limit) return x % n
  }
}

// kv seenHeld with `cut` added, each in a uniformly random slot, never two
// in the same slot within one call (a partial Fisher-Yates over the slot
// indices), so a batch never overwrites itself. An absent list starts as
// random tokens.
function addHeld (ids, cut) {
  const out = ids === null ? [] : ids.slice()
  while (out.length < store.SEEN_HELD_MAX) out.push(hex(crypto.randomBytes(16)))
  const have = new Set(out)
  const fresh = []
  for (const token of cut) {
    if (have.has(token)) continue
    have.add(token)
    fresh.push(token)
  }
  // The newest cut tokens when more than the list holds.
  const put = fresh.slice(-store.SEEN_HELD_MAX)
  const slots = Array.from({ length: store.SEEN_HELD_MAX }, (_, i) => i)
  for (let k = 0; k < put.length; k++) {
    const j = k + randomBelow(store.SEEN_HELD_MAX - k)
    const tmp = slots[k]
    slots[k] = slots[j]
    slots[j] = tmp
    out[slots[k]] = put[k]
  }
  return out
}

function sameKeys (a, b) {
  if (a.size !== b.size) return false
  for (const key of a) if (!b.has(key)) return false
  return true
}

function tokensOf (list) {
  return list.map((e) => e.token).reverse()
}

// The merge result's avisos: tokens only, newest first.
function avisosOut (doc) {
  const pages = {}
  for (const key of Object.keys(doc.avisos.pages)) pages[key] = tokensOf(doc.avisos.pages[key])
  return { own: tokensOf(doc.avisos.own), pages }
}

// Remote group marks applied through member-ops groupSeen (the 'group.seen'
// path) on the cores withCores lends, and caughtUp(): the caughtUp keys of
// the groups whose mark moved (community.info's unread, docs/rpc.md 5.59).
// The merge calls caughtUp() as its last step, right before it answers: a
// post that lands after that read reaches the app as groups.changed only
// after the answer (sync.js coalesces it for GROUPS_CHANGED_MS), so the app
// can acknowledge the versions it holds when the answer arrives.
// guard() throws when the identity changed since the merge started.
function groupApplier ({ storage, withCores }) {
  return async function applyGroups (marks, guard) {
    const before = await store.readGroupSeen(storage)
    const at = new Map(before.map((m) => [m.group, m]))
    const todo = marks.filter((m) => {
      const l = at.get(m.group)
      return l === undefined || !sameMark(l, m)
    })
    if (todo.length === 0) return { moved: [], caughtUp: [] }
    const moved = await withCores(async (c) => {
      for (const m of todo) {
        guard()
        try {
          await member.groupSeen(c, { group: m.group, upTo: { at: m.at, writer: m.writer, seq: m.seq } })
        } catch (err) {
          if (member.isNeedsExclusive(err)) throw err
          if (err && err.message === store.MISMATCH) throw err
        }
      }
      const after = await store.readGroupSeen(storage)
      return after.filter((m) => {
        const l = at.get(m.group)
        return l === undefined || !sameMark(l, m)
      }).map((m) => m.group)
    })
    const caughtUp = moved.length === 0 ? [] : () => withCores((c) => caughtUpOf(c, moved))
    return { moved, caughtUp }
  }
}

async function caughtUpOf (c, moved) {
  if (moved.length === 0) return []
  const byCommunity = new Map()
  for (const group of moved) {
    let community = null
    try {
      community = await member.groupCommunityOf(c, group)
    } catch (err) {
      if (member.isNeedsExclusive(err)) throw err
    }
    if (community === null) continue
    if (!byCommunity.has(community)) byCommunity.set(community, [])
    byCommunity.get(community).push(group)
  }
  const out = []
  for (const [community, groups] of byCommunity) {
    let info
    try {
      info = await member.communityInfo(c, { community })
    } catch (err) {
      if (member.isNeedsExclusive(err)) throw err
      continue
    }
    const caught = (r) => READER_ROLES.has(r.role) && r.unread === 0
    // The mark that moved names a post this node lists, so a moved group it
    // can read has a last. last null there means no post could be read (a
    // private group without its key yet, the browser locked), and its
    // unread 0 says nothing.
    const read = (r) => !groups.includes(r.group) || r.last !== null
    for (const r of info.groups) {
      if (groups.includes(r.group) && caught(r) && read(r)) out.push(r.group)
    }
    // A group whose core did not load (role null) or an incomplete fold may
    // hide unread posts, so the community is not caught up.
    if (info.incomplete !== true && info.groups.length > 0 && info.groups.every((r) => caught(r) && read(r))) out.push(community)
  }
  return out.slice(0, CAUGHT_UP_MAX)
}

// storage: the node storage. association: the configured association.
// log(line): a warning line. currentOwn(): the own key of the unlocked
// identity now (null when locked), so a result computed for a previous key
// pair is dropped before it writes. applyGroups(marks, guard): the remote
// group mark applier (groupApplier); without it no remote mark is applied.
function createSeenSync ({ storage, association, log = noop, currentOwn = () => null, applyGroups = null } = {}) {
  function check (keyPair, own) {
    if (keyPair === null || keyPair === undefined) throw new UsageError(store.LOCKED)
    if (hex(keyPair.publicKey) !== own) throw new Error(store.MISMATCH)
  }

  function guardFor (own) {
    return () => {
      if (currentOwn() !== own) throw new Error(store.MISMATCH)
    }
  }

  function deriveKey (keyPair, own) {
    return seenBlob.seenKeyFromSeed(keyPair.secretKey.subarray(0, 32), association, own)
  }

  // The stored canonical document, or an empty one (absent, another
  // identity's, or not opening under this key). unsupported: the stored one
  // is in a newer format, which is never sealed over.
  async function readBase (key, own, gen) {
    const b64 = await store.readSeenLocal(storage, own)
    if (b64 !== null) {
      const doc = seenBlob.open(b4a.from(b64, 'base64'), key, { member: own, association })
      if (doc !== null && doc.unsupported === true) return { doc: emptyDoc(gen, own, association), stored: false, unsupported: true }
      if (doc !== null) return { doc, stored: true, unsupported: false }
    }
    return { doc: emptyDoc(gen, own, association), stored: false, unsupported: false }
  }

  // The document the service held at the cursor (kv seenRemote, checked
  // against the cursor hash), or null when it is not known here, or
  // { unsupported: true } when it is in a newer format.
  async function readRemote (key, own, hash) {
    if (hash === null) return null
    const b64 = await store.readSeenRemote(storage, own)
    if (b64 === null) return null
    const bytes = b4a.from(b64, 'base64')
    if (blobHash(bytes) !== hash) return null
    const doc = seenBlob.open(bytes, key, { member: own, association })
    return doc
  }

  async function sign ({ nonce, action }, keyPair, own) {
    check(keyPair, own)
    const sync = await store.readSeenSync(storage, own)
    const prevHash = sync.hash || HASH_NONE
    if (action !== 'write') {
      const signature = signSeen({ nonce, member: own, association, action, prevHash, newHash: HASH_NONE }, keyPair)
      return { signature, prevHash }
    }
    const key = deriveKey(keyPair, own)
    try {
      const { doc: base, unsupported } = await readBase(key, own, sync.gen)
      if (unsupported) throw new UsageError(NEWER_FORMAT)
      const view = seenBlob.trim(localView(base, await store.readDmSeen(storage), await store.readGroupSeen(storage), null, nowSec(), await store.readMemberBlocks(storage), null, await store.readTestimonialDecisions(storage, own), await store.readMomentSeen(storage, own)))
      const gen = Math.min(sync.gen + 1, U32_MAX)
      const bytes = seenBlob.seal({ ...view, gen }, key)
      const hash = blobHash(bytes)
      const signature = signSeen({ nonce, member: own, association, action, prevHash, newHash: hash }, keyPair)
      guardFor(own)()
      // The written content becomes the local document, so each token keeps
      // the t it was uploaded with: merging this blob back with nothing
      // marked since then is not a local change (else pending never ends).
      await store.writeSeenLocal(storage, own, b4a.toString(seenBlob.seal(view, key), 'base64'))
      return { signature, blob: b4a.toString(bytes, 'base64'), hash, prevHash }
    } finally {
      key.fill(0)
    }
  }

  async function merge ({ blob, avisos, unchanged = false }, keyPair, own) {
    check(keyPair, own)
    const guard = guardFor(own)
    const key = deriveKey(keyPair, own)
    try {
      const now = nowSec()
      const sync = await store.readSeenSync(storage, own)
      const { doc: base, stored, unsupported } = await readBase(key, own, sync.gen)
      const dmIds = await store.readDmSeen(storage)
      const marks = await store.readGroupSeen(storage)
      const heldBlocks = await store.readMemberBlocks(storage)
      const heldDecisions = await store.readTestimonialDecisions(storage, own)
      const heldMoments = await store.readMomentSeen(storage, own)
      const heldIds = await store.readSeenHeld(storage, own)
      const held = new Set(heldIds || [])
      const local = localView(base, dmIds, marks, avisos, now, heldBlocks, held, heldDecisions, heldMoments)
      local.gen = Math.max(base.gen, Math.min(sync.gen, U32_MAX))
      // Never re-sealed over a newer format, local or remote.
      const untouched = () => ({ avisos: avisosOut(seenBlob.trim(local)), pending: false, dmChanged: false, groupChanged: false, blocksChanged: false, testimonialsChanged: false, momentsChanged: false, caughtUp: [] })
      if (unsupported) return untouched()

      // remote: what the service holds. Never the local document, which
      // also carries marks this device has not uploaded yet.
      let remote
      let remoteHash = sync.hash
      let remoteB64 = null
      // A blob that does not open (corrupt or hostile service) is not
      // written over: a write per pass against it would never succeed.
      let ignored = false
      if (blob !== null && blob !== undefined) {
        const bytes = b4a.from(blob, 'base64')
        const doc = seenBlob.open(bytes, key, { member: own, association })
        if (doc === null) {
          log(IGNORED_LINE)
          ignored = true
          remote = emptyDoc(0, own, association)
        } else if (doc.unsupported === true) {
          return untouched()
        } else {
          remote = doc
          remoteHash = blobHash(bytes)
          remoteB64 = blob
        }
      } else if (unchanged === true && sync.hash === null) {
        remote = emptyDoc(0, own, association)
      } else if (unchanged === true) {
        const doc = stored ? await readRemote(key, own, sync.hash) : null
        if (doc !== null && doc.unsupported === true) {
          return untouched()
        } else if (doc !== null) {
          remote = doc
        } else {
          // The server matched our cursor but a stored document is gone (an
          // interrupted reset): never pair that hash with an empty document.
          // The cursor is dropped, so the next write signs HASH_NONE and the
          // service answers 409 with the real blob instead of being replaced.
          remote = emptyDoc(0, own, association)
          remoteHash = null
        }
      } else {
        remote = emptyDoc(0, own, association)
        remoteHash = null
      }

      const { doc: merged, localOnly } = seenBlob.merge(local, remote)

      // The next kv dmSeen, oldest first, cut by writeDmSeen at MAX_DM_SEEN:
      // the union with EVERY remote token, not only the ones the shared
      // window kept. The merged window goes last in its own order. Before
      // it, the remote tokens it cut go first: each is older than every
      // token of the window and was never read here, so with the list full
      // they leave before any local read does. A token cut from the window
      // is never offered again as a fresh mark, since localView offers only
      // the ids after the newest one the stored document holds.
      const have = new Set(dmIds)
      const window = merged.dm.map((e) => e.token)
      const inWindow = new Set(window)
      const remoteOld = []
      for (const e of remote.dm) if (!have.has(e.token) && !inWindow.has(e.token)) remoteOld.push(e.token)
      const nextDm = [...remoteOld, ...dmIds.filter((tk) => !inWindow.has(tk)), ...window].slice(-store.MAX_DM_SEEN)
      const dmChanged = nextDm.some((tk) => !have.has(tk))

      let groupChanged = false
      let caughtUp = []
      if (applyGroups !== null && remote.groups.length > 0) {
        guard()
        const r = await applyGroups(remote.groups, guard)
        groupChanged = r.moved.length > 0
        caughtUp = r.caughtUp
      }

      guard()
      if (remoteB64 !== null && remoteHash !== null) {
        const kept = await store.readSeenRemote(storage, own)
        if (kept !== blob) await store.writeSeenRemote(storage, own, remoteB64)
      }
      if (!stored || !seenBlob.sameContent(merged, base)) {
        await store.writeSeenLocal(storage, own, b4a.toString(seenBlob.seal(merged, key), 'base64'))
        await store.writeSeenSync(storage, own, { hash: remoteHash, gen: merged.gen })
      } else if (remoteHash !== sync.hash) {
        await store.writeSeenSync(storage, own, { hash: remoteHash, gen: Math.max(sync.gen, merged.gen) })
      }

      // kv dmSeen goes last: localView offers only the dm ids after the
      // newest one the stored document holds, so dmSeen rewritten before
      // the document could hide a local mark for good if the merge stopped
      // in between. Stopped here instead, the next merge re-adds the remote
      // tokens, which the remote copy still holds.
      if (dmChanged) {
        guard()
        await store.writeDmSeen(storage, nextDm)
      }

      // kv seenHeld goes after the document too: stopped before it, a cut
      // token may be stamped new once more, never lost. It is written padded
      // at the first merge of the identity, so its presence says nothing
      // about whether a token was ever cut.
      const keptAvisos = new Set(avisosTokens(merged))
      const cut = [...avisosTokens(local), ...avisosTokens(remote)].filter((tk) => !keptAvisos.has(tk) && !held.has(tk))
      if (cut.length > 0 || heldIds === null) {
        guard()
        await store.writeSeenHeld(storage, own, addHeld(heldIds, cut))
      }

      // kv memberBlocks goes after the document for the same reason, and takes
      // every remote entry, not only the ones the window kept: a block too old
      // for the window still holds here.
      const nextBlocks = mergeBlocks(mergeBlocks(heldBlocks, remote.blocks), merged.blocks)
      const blocksChanged = !sameKeys(blockedKeys(heldBlocks), blockedKeys(nextBlocks))
      if (JSON.stringify(nextBlocks) !== JSON.stringify(heldBlocks)) {
        guard()
        await store.writeMemberBlocks(storage, nextBlocks)
      }

      // kv testimonialDecisions likewise goes after the document, and is a
      // union with the held list, so a remote that lacks an entry never
      // deletes a local one.
      const nextDecisions = mergeDecisions(mergeDecisions(heldDecisions, remote.testimonials), merged.testimonials)
      const testimonialsChanged = !sameDecisions(heldDecisions, nextDecisions)
      if (JSON.stringify(nextDecisions) !== JSON.stringify(heldDecisions)) {
        guard()
        await store.writeTestimonialDecisions(storage, own, nextDecisions)
      }

      // kv momentSeen the same way: a union with the held list, after the
      // document.
      const nextMoments = mergeMomentSeen(mergeMomentSeen(heldMoments, remote.moments), merged.moments)
      const momentsChanged = !sameMomentSeen(heldMoments, nextMoments)
      if (JSON.stringify(nextMoments) !== JSON.stringify(heldMoments)) {
        guard()
        await store.writeMomentSeen(storage, own, nextMoments)
      }

      if (typeof caughtUp === 'function') {
        guard()
        caughtUp = await caughtUp()
        guard()
      }
      return { avisos: avisosOut(merged), pending: ignored ? false : localOnly, dmChanged, groupChanged, blocksChanged, testimonialsChanged, momentsChanged, caughtUp }
    } finally {
      key.fill(0)
    }
  }

  return {
    sign,
    merge,
    // Nothing is held in memory between calls: every state lives in kv,
    // bound to the own key. Kept for the session's identity-change path.
    forget () {}
  }
}

module.exports = { createSeenSync, groupApplier, localView, IGNORED_LINE }
