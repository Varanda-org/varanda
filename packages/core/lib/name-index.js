'use strict'

// Name index of a seeder (account search): for every served author, the
// folded tokens of its newest display name and its verified @nome, so that a
// query ('joao-silva') can say which members to look at. It lives IN MEMORY
// only, rebuilt from the served diaries at every start by the seeder's index
// scan (lib/seeder.js) next to the engagement index, and is the only seeder
// state holding name text: folded tokens (lib/search-text.js) and the
// verified @nome, kept only to choose WHERE TO LOOK. A member never trusts a
// result: it re-reads and verifies every name via diary.peek at the returned
// seq hints. Never stored: a bio, the raw display name, a signature after
// settle, an e-mail or an account subject.
//
// Display name: the `name` of the highest-seq `profile` record (1..80 code
// points); its tokens are kept even when empty. @nome: the highest-seq
// `username` record whose `member` is the author (lib/username.js rule): a
// newer candidate clears the adopted @nome at once and there is no fallback
// to an earlier record; copied records (member !== author) are ignored. A
// candidate is verified lazily by settle(author) through the injected
// verifyUsername(author, record) (signature and issuer delegation, WITHOUT
// revocation), called at most once per candidate; only a literal true
// adopts it. Revocation is applied per search by usableIssuer(issuer).
//
// Bounds: maxAuthors (4096) entries, about 2 KB per author (tokens, the
// pending candidate copy, map slot). note() refuses (false, nothing stored)
// only a NEW author that would need an entry when the map is full; existing
// authors always update. Entries leave only via remove/clear. Forgotten seqs
// are kept apart from the entries and take no maxAuthors slot: the seeder
// forgets only tombstone targets of diaries it serves and calls remove when
// it stops serving one, so they are bounded like its own deleted sets. search keeps
// the best RESULTS_MAX by (rank, author) with bounded insertion, never
// sorting all matches.
//
// Pure and total: no I/O, no timers, and no method ever throws (hostile
// records, verifiers and predicates included: a throw answers false / null
// / not usable / not visible).
const {
  RESULTS_MAX,
  isValidUsername,
  foldTokens,
  isQueryTokens,
  searchRank
} = require('./search-text')

const DEFAULT_MAX_AUTHORS = 4096
const NAME_MAX = 80
const HEX64 = /^[0-9a-f]{64}$/
// The username record schema (packages/core/lib/records.js USERNAME_KEYS):
// a pending candidate keeps only these fields, each a short string, so the
// per-author memory bound holds whatever extra payload a record carries.
const USERNAME_KEYS = ['type', 'username', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']
const FIELD_MAX = 256

function isHex64 (s) {
  return typeof s === 'string' && HEX64.test(s)
}

function isPlain (o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// A copy of the schema fields of a username record, or null when one is
// missing, not a string or longer than FIELD_MAX.
function candidateCopy (record) {
  const copy = {}
  for (const k of USERNAME_KEYS) {
    const v = record[k]
    if (typeof v !== 'string' || v.length > FIELD_MAX) return null
    copy[k] = v
  }
  return copy
}

function nameLength (name) {
  // Bounded: anything over 2 * NAME_MAX UTF-16 units is over NAME_MAX code
  // points (each code point is at most 2 units), so never walk huge strings.
  if (name.length > 2 * NAME_MAX) return NAME_MAX + 1
  return Array.from(name).length
}

function newEntry () {
  return {
    profileSeq: null,
    nameTokens: [],
    usernameWatermark: null,
    candidate: null,
    username: null,
    usernameTokens: null,
    usernameSeq: null,
    issuer: null
  }
}

// Lower is better: (rank asc, author asc).
function better (a, b) {
  if (a.rank !== b.rank) return a.rank < b.rank
  return a.author < b.author
}

function createNameIndex ({ maxAuthors, verifyUsername } = {}) {
  const cap = Number.isSafeInteger(maxAuthors) && maxAuthors >= 0 ? maxAuthors : DEFAULT_MAX_AUTHORS
  const entries = new Map()
  // author -> every seq forget() was called with, current profile or not and
  // whether or not the author holds an entry. A rescan of the raw diary must
  // not restore a deleted name; an older seq can still be the newest one left.
  const forgottenProfiles = new Map()

  function note (author, seq, record) {
    try {
      if (!isHex64(author) || !Number.isSafeInteger(seq) || seq < 1 || !isPlain(record)) return true
      const type = record.type
      let profileName = null
      let username = null
      if (type === 'profile') {
        const name = record.name
        if (typeof name !== 'string') return true
        const n = nameLength(name)
        if (n < 1 || n > NAME_MAX) return true
        profileName = name
      } else if (type === 'username') {
        if (record.member !== author || !isValidUsername(record.username) || !isHex64(record.issuer)) return true
        username = candidateCopy(record)
        if (username === null) return true
      } else {
        return true
      }
      // The tombstone outranks recency (this seq was the newest profile when
      // it was forgotten, so it must not replace an older survivor) and is
      // checked before an entry is allocated, so it never costs a slot.
      if (profileName !== null && forgottenProfiles.get(author)?.has(seq)) return true
      let entry = entries.get(author)
      if (entry === undefined) {
        if (entries.size >= cap) return false
        entry = newEntry()
        entries.set(author, entry)
      }
      if (profileName !== null) {
        if (entry.profileSeq === null || seq > entry.profileSeq) {
          entry.profileSeq = seq
          entry.nameTokens = foldTokens(profileName)
        }
      } else if (entry.usernameWatermark === null || seq > entry.usernameWatermark) {
        entry.usernameWatermark = seq
        entry.candidate = { seq, record: username }
        entry.username = null
        entry.usernameTokens = null
        entry.usernameSeq = null
        entry.issuer = null
      }
      return true
    } catch {
      return true
    }
  }

  function settle (author) {
    try {
      if (typeof author !== 'string') return
      const entry = entries.get(author)
      if (entry === undefined || entry.candidate === null) return
      const { seq, record } = entry.candidate
      entry.candidate = null
      let ok = false
      try {
        ok = typeof verifyUsername === 'function' && verifyUsername(author, record) === true
      } catch {
        ok = false
      }
      // A newer candidate noted (or the entry removed) while verifying wins.
      if (!ok || entries.get(author) !== entry || entry.usernameWatermark !== seq) return
      entry.username = record.username
      entry.usernameTokens = foldTokens(record.username)
      entry.usernameSeq = seq
      entry.issuer = record.issuer
    } catch {}
  }

  function forget (author, seq) {
    try {
      if (!isHex64(author) || !Number.isSafeInteger(seq) || seq < 1) return false
      // Tombstoned even when it is not the current name: once the newer
      // profile is forgotten too, a rescan must not bring this one back.
      let seqs = forgottenProfiles.get(author)
      if (seqs === undefined) {
        seqs = new Set()
        forgottenProfiles.set(author, seqs)
      }
      seqs.add(seq)
      const entry = entries.get(author)
      if (entry === undefined || entry.profileSeq !== seq) return false
      entry.profileSeq = null
      entry.nameTokens = []
      return true
    } catch {
      return false
    }
  }

  function remove (author) {
    try {
      if (typeof author === 'string') forgottenProfiles.delete(author)
      return typeof author === 'string' && entries.delete(author)
    } catch {
      return false
    }
  }

  function clear () {
    entries.clear()
    forgottenProfiles.clear()
  }

  function usable (usableIssuer, issuer) {
    try {
      return usableIssuer(issuer) === true
    } catch {
      return false
    }
  }

  function shown (visible, author) {
    try {
      return visible(author) === true
    } catch {
      return false
    }
  }

  function search (qTokens, visible, usableIssuer) {
    try {
      if (!isQueryTokens(qTokens) || typeof visible !== 'function' || typeof usableIssuer !== 'function') return null
      const best = [] // sorted by better(), at most RESULTS_MAX
      let more = false
      for (const [author, entry] of entries) {
        const effective = entry.username !== null && usable(usableIssuer, entry.issuer) ? entry.username : null
        const usernameSeq = effective === null ? null : entry.usernameSeq
        if (entry.profileSeq === null && usernameSeq === null) continue
        const rank = searchRank(qTokens, entry.nameTokens, effective, effective === null ? null : entry.usernameTokens)
        if (rank < 0) continue
        const hit = { rank, author, profileSeq: entry.profileSeq, usernameSeq }
        if (best.length >= RESULTS_MAX && !better(hit, best[best.length - 1])) {
          if (shown(visible, author)) more = true
          continue
        }
        if (!shown(visible, author)) continue
        let i = best.length
        while (i > 0 && better(hit, best[i - 1])) i--
        best.splice(i, 0, hit)
        if (best.length > RESULTS_MAX) {
          best.pop()
          more = true
        }
      }
      return {
        members: best.map(({ author, profileSeq, usernameSeq }) => ({ author, profileSeq, usernameSeq })),
        more
      }
    } catch {
      return null
    }
  }

  function stats () {
    return { authors: entries.size, maxAuthors: cap }
  }

  return { note, settle, forget, remove, clear, search, stats }
}

module.exports = {
  DEFAULT_MAX_AUTHORS,
  createNameIndex
}
