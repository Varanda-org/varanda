// Helpers for the reply rows of the Conversa. The items are
// already assembled: assembleThread in thread.js and assembleRoda in roda.js
// are the trust gates, and nothing here fetches or checks a signature. The
// thread layout itself (comments and their rodas) is roda.js commentRows.
//
// Not the direct-message rows of dm-screen.js, which exports another
// threadRows. Import this module under its own name.
// Peer name and text pass through displayText before they leave.

import rpc from '@varanda/rpc'
import { parseRef } from './thread.js'

const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o)
const isCount = (n) => Number.isSafeInteger(n) && n >= 0

function canonicalRef (ref) {
  if (typeof ref !== 'string') return null
  const parsed = parseRef(ref.toLowerCase())
  if (parsed === null) return null
  return parsed.author + ':' + parsed.seq
}

function itemRef (item) {
  if (!isPlain(item) || typeof item.author !== 'string' || !Number.isSafeInteger(item.seq)) return null
  return canonicalRef(item.author + ':' + item.seq)
}

function atMillis (item) {
  if (!isPlain(item) || typeof item.at !== 'string') return null
  const ms = Date.parse(item.at)
  return Number.isFinite(ms) ? ms : null
}

// Oldest first, matching the reply index (engagement-index.js compareEdges):
// instant, then author, then seq, so a reply sent here keeps its place after
// a refresh. A missing or unparseable at sorts after a dated one so a
// clock-less row cannot jump ahead of the thread.
export function compareAtSeq (a, b) {
  const ta = atMillis(a)
  const tb = atMillis(b)
  if (ta !== null && tb !== null && ta !== tb) return ta < tb ? -1 : 1
  if (ta !== null && tb === null) return -1
  if (ta === null && tb !== null) return 1
  const aa = isPlain(a) && typeof a.author === 'string' ? a.author.toLowerCase() : ''
  const ab = isPlain(b) && typeof b.author === 'string' ? b.author.toLowerCase() : ''
  if (aa !== ab) return aa < ab ? -1 : 1
  const sa = isPlain(a) && Number.isSafeInteger(a.seq) ? a.seq : 0
  const sb = isPlain(b) && Number.isSafeInteger(b.seq) ? b.seq : 0
  return sa - sb
}

function shown (value) {
  if (typeof value !== 'string') return ''
  return rpc.displayText(value).trim()
}

function entriesOf (prev) {
  if (prev instanceof Map) return [...prev.entries()]
  if (!isPlain(prev)) return []
  return Object.keys(prev).map((key) => [key, prev[key]])
}

export function childLabel (n, open) {
  if (open === true) return 'Ocultar respostas'
  if (n === 1) return 'Ver 1 resposta'
  if (isCount(n)) return 'Ver ' + n + ' respostas'
  return 'Ver respostas'
}

export function replyChip (who) {
  const box = isPlain(who) ? who : {}
  // The label adds the single @. A handle that already carries one would
  // read as @@nome, which is not a username.
  const handle = shown(box.username).replace(/^@+/, '')
  if (handle !== '') return 'Respondendo a @' + handle
  const label = shown(box.name)
  if (label !== '') return 'Respondendo a ' + label
  return 'Respondendo'
}

export function mergeChildren (prev, parentKey, items) {
  const out = new Map()
  for (const [key, value] of entriesOf(prev)) out.set(key, value)
  const key = canonicalRef(parentKey)
  // A bad page must not wipe children already held for this parent.
  if (key === null || !Array.isArray(items)) return out
  const byRef = new Map()
  const prior = Array.isArray(out.get(key)) ? out.get(key) : []
  for (const item of prior) {
    const ref = itemRef(item)
    if (ref === null || byRef.has(ref)) continue
    byRef.set(ref, item)
  }
  for (const item of items) {
    const ref = itemRef(item)
    if (ref === null || byRef.has(ref)) continue
    byRef.set(ref, item)
  }
  out.set(key, [...byRef.values()].sort(compareAtSeq))
  return out
}

export function withOwnReply (replies, item) {
  const list = Array.isArray(replies) ? replies : []
  const ref = itemRef(item)
  if (ref === null) return list
  for (const entry of list) {
    if (itemRef(entry) === ref) return list
  }
  const out = []
  let placed = false
  for (const entry of list) {
    if (!placed && compareAtSeq(item, entry) < 0) {
      out.push(item)
      placed = true
    }
    out.push(entry)
  }
  if (!placed) out.push(item)
  return out
}
