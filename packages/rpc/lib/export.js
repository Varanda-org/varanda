'use strict'

// The own-data export document, version 1 (docs/protocol.md section 17).
// Pure: the app feeds it the pages export.read returned and gets the file text.

const EXPORT_FORMAT = 'varanda-export'
const EXPORT_VERSION = 1
const EXPORT_APPEARANCES = ['system', 'light', 'dark']

const HEX64 = /^[0-9a-f]{64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const TOP_KEYS = ['format', 'version', 'exportedAt', 'key', 'association', 'profile', 'follows', 'preferences', 'diary']
const PREF_KEYS = ['previews', 'wifiOnly', 'appearance', 'blocked', 'muted']
const DIARY_KEYS = ['length', 'entries', 'invalid']

const isKey = (v) => typeof v === 'string' && HEX64.test(v)
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const sameKeys = (o, keys) => {
  const own = Object.keys(o)
  return own.length === keys.length && own.every((k, i) => k === keys[i])
}

// A checksum of the follow set, not a security measure: the head carries it
// so the app can tell the list changed while it paged by offset (a removal
// paired with an addition keeps the count and skips a key). FNV-1a 32 over
// the sorted keys joined by ',', as 8 lowercase hex.
function followsDigest (keys) {
  let h = 0x811c9dc5
  const text = [...keys].sort().join(',')
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function exportFileName (key, ms) {
  return 'varanda-dados-' + key.slice(0, 8) + '-' + new Date(ms).toISOString().slice(0, 10) + '.json'
}

function keyList (v) {
  return Array.isArray(v) ? v.filter(isKey) : null
}

// An allowlist: whatever else the app stores is never read here.
function exportPreferences (prefs, head) {
  const p = isObject(prefs) ? prefs : {}
  const h = isObject(head) ? head : {}
  return {
    previews: typeof p.previews === 'boolean' ? p.previews : null,
    wifiOnly: typeof p.wifiOnly === 'boolean' ? p.wifiOnly : null,
    appearance: EXPORT_APPEARANCES.includes(p.appearance) ? p.appearance : null,
    blocked: keyList(h.blocked),
    muted: keyList(h.muted)
  }
}

function indent (text) {
  return text.split('\n').join('\n  ')
}

function block (value) {
  return indent(JSON.stringify(value, null, 2))
}

// Two-space structure, but one line per diary entry so a large diary stays
// readable.
function lines (items, pad) {
  if (items.length === 0) return '[]'
  return '[\n' + items.map((i) => pad + '  ' + JSON.stringify(i)).join(',\n') + '\n' + pad + ']'
}

function buildExport ({ key, head, follows, entries, invalid, preferences, exportedAt }) {
  const at = typeof exportedAt === 'string' ? exportedAt : new Date(exportedAt).toISOString()
  const profile = head && head.profile ? { name: head.profile.name, bio: head.profile.bio } : null
  const diary = '{\n' +
    '    "length": ' + JSON.stringify(head.length) + ',\n' +
    '    "entries": ' + lines(entries, '    ') + ',\n' +
    '    "invalid": ' + lines(invalid, '    ') + '\n' +
    '  }'
  return '{\n' +
    '  "format": ' + JSON.stringify(EXPORT_FORMAT) + ',\n' +
    '  "version": ' + EXPORT_VERSION + ',\n' +
    '  "exportedAt": ' + JSON.stringify(at) + ',\n' +
    '  "key": ' + JSON.stringify(key) + ',\n' +
    '  "association": ' + JSON.stringify(head.association) + ',\n' +
    '  "profile": ' + block(profile) + ',\n' +
    '  "follows": ' + block(follows) + ',\n' +
    '  "preferences": ' + block(preferences) + ',\n' +
    '  "diary": ' + diary + '\n' +
    '}\n'
}

function ascending (list) {
  let last = -1
  for (const item of list) {
    if (!isObject(item) || !Number.isSafeInteger(item.seq) || item.seq < 0 || item.seq <= last) return false
    last = item.seq
  }
  return true
}

// null when the parsed document is a well-formed version 1 export, else a
// short reason.
function checkExport (doc) {
  if (!isObject(doc)) return 'not an object'
  if (!sameKeys(doc, TOP_KEYS)) return 'top-level keys'
  if (doc.format !== EXPORT_FORMAT) return 'format'
  if (doc.version !== EXPORT_VERSION) return 'version'
  if (typeof doc.exportedAt !== 'string' || !ISO.test(doc.exportedAt)) return 'exportedAt'
  if (!isKey(doc.key) || !isKey(doc.association)) return 'key'
  const pr = doc.profile
  if (pr !== null && !(isObject(pr) && sameKeys(pr, ['name', 'bio']) && typeof pr.name === 'string' && typeof pr.bio === 'string')) return 'profile'
  if (!Array.isArray(doc.follows) || !doc.follows.every(isKey)) return 'follows'
  const prefs = doc.preferences
  if (!isObject(prefs) || !sameKeys(prefs, PREF_KEYS)) return 'preferences'
  if (prefs.previews !== null && typeof prefs.previews !== 'boolean') return 'preferences'
  if (prefs.wifiOnly !== null && typeof prefs.wifiOnly !== 'boolean') return 'preferences'
  if (prefs.appearance !== null && !EXPORT_APPEARANCES.includes(prefs.appearance)) return 'preferences'
  for (const k of ['blocked', 'muted']) {
    if (prefs[k] !== null && !(Array.isArray(prefs[k]) && prefs[k].every(isKey))) return 'preferences'
  }
  const d = doc.diary
  if (!isObject(d) || !sameKeys(d, DIARY_KEYS)) return 'diary'
  if (!Number.isSafeInteger(d.length) || d.length < 0) return 'diary length'
  if (!Array.isArray(d.entries) || !Array.isArray(d.invalid)) return 'diary'
  if (!ascending(d.entries) || !ascending(d.invalid)) return 'seq order'
  if (!d.entries.every((e) => sameKeys(e, ['seq', 'record']) && isObject(e.record))) return 'entries'
  if (!d.invalid.every((e) => sameKeys(e, ['seq', 'reason']) && typeof e.reason === 'string')) return 'invalid'
  const seqs = new Set()
  for (const e of [...d.entries, ...d.invalid]) {
    if (e.seq >= d.length || seqs.has(e.seq)) return 'diary seq'
    seqs.add(e.seq)
  }
  return null
}

module.exports = {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  EXPORT_APPEARANCES,
  exportFileName,
  followsDigest,
  exportPreferences,
  buildExport,
  checkExport
}
