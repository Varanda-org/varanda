// Layout for the reply list under one post. The items are already assembled:
// assembleThread in thread.js is the only trust gate, and nothing here
// fetches or checks a signature. Depth stops at 1, so a reply of a reply is
// not inlined. That row carries `deeper`: 0 when it has no replies of its
// own, a positive count when the count is known, and null when the count is
// unknown but flagged. The screen offers "Ver conversa" whenever deeper is
// not 0.
//
// `parent` on an expander or a more row is the depth-0 reply item. Its ref
// (author:seq) is the key of children, counts, open and more. A counts entry
// that is present but not a usable number (null, or a counts object whose
// replies is not a number) is unknown but flagged, so the expander still
// shows. An omitted key is not a flag: a missing count is not zero replies
// and not an invitation to open.
//
// Not the direct-message rows of dm-screen.js, which exports another
// threadRows. Import this module under its own name.
// Peer name and text pass through displayText before they leave.

import rpc from '@varanda/rpc'
import { parseRef, target } from './thread.js'

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

function asTarget (value) {
  if (typeof value === 'string') {
    const ref = canonicalRef(value)
    return ref === null ? null : parseRef(ref)
  }
  if (!isPlain(value) || typeof value.author !== 'string' || !Number.isSafeInteger(value.seq)) return null
  return target({ author: value.author.toLowerCase(), seq: value.seq })
}

function read (box, key) {
  if (box instanceof Map) return box.has(key) ? box.get(key) : undefined
  if (box instanceof Set) return box.has(key) ? true : undefined
  if (!isPlain(box)) return undefined
  return Object.prototype.hasOwnProperty.call(box, key) ? box[key] : undefined
}

// known: a safe count. flagged: the key is present, so null is not "absent".
function storedCount (counts, key) {
  const value = read(counts, key)
  if (value === undefined) return { known: false, flagged: false }
  if (isCount(value)) return { known: true, flagged: true, n: value }
  if (isPlain(value) && isCount(value.replies)) return { known: true, flagged: true, n: value.replies }
  return { known: false, flagged: true }
}

function wantsExpander (info) {
  return info.flagged && (!info.known || info.n > 0)
}

function childItems (children, key) {
  const value = read(children, key)
  return Array.isArray(value) ? value : []
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
function compareAtSeq (a, b) {
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

function deeperOf (counts, children, ref) {
  const info = storedCount(counts, ref)
  if (info.known && info.n > 0) return info.n
  if (info.flagged && !info.known) return null
  const seen = new Set()
  for (const item of childItems(children, ref)) {
    const key = itemRef(item)
    if (key === null || key === ref || seen.has(key)) continue
    seen.add(key)
  }
  return seen.size
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

export function threadRows (input) {
  const box = isPlain(input) ? input : {}
  const rows = []
  const seen = new Set()
  const list = Array.isArray(box.replies) ? box.replies : []
  for (const item of list) {
    const ref = itemRef(item)
    if (ref === null || seen.has(ref)) continue
    seen.add(ref)
    rows.push({ kind: 'reply', item, depth: 0, key: 'reply:' + ref, deeper: 0 })
    const info = storedCount(box.counts, ref)
    const isOpen = read(box.open, ref) === true
    // An open branch with a known zero still needs its hide control.
    if (wantsExpander(info) || isOpen) {
      rows.push({
        kind: 'expander',
        parent: item,
        count: info.known ? info.n : null,
        open: isOpen,
        key: 'expander:' + ref
      })
    }
    if (isOpen) {
      for (const child of childItems(box.children, ref)) {
        const childRef = itemRef(child)
        if (childRef === null || seen.has(childRef)) continue
        seen.add(childRef)
        rows.push({
          kind: 'reply',
          item: child,
          depth: 1,
          key: 'reply:' + childRef,
          deeper: deeperOf(box.counts, box.children, childRef)
        })
      }
    }
    if (read(box.more, ref) === true) {
      rows.push({ kind: 'more', parent: item, key: 'more:' + ref })
    }
  }
  return rows
}

function previewName (item) {
  const name = shown(item && item.name)
  if (name !== '') return name
  return shown(item && item.username)
}

// Replies already sitting in a loaded feed, near the parent, are on screen
// as their own rows. Only rows further than skipNear away are returned, and
// nothing is fetched.
export function cheapReplies (items, ref, options) {
  const key = canonicalRef(ref)
  if (key === null) return []
  return cheapRepliesMap(items, [key], options).get(key) || []
}

// cheapReplies for many parents in one pass over the list, with the same
// lines in the same order as one call per ref. A feed keeps every loaded
// page, so a walk per parent would grow with the square of its length.
// -> Map(canonical ref -> lines); a ref that is not a valid ref is left out.
export function cheapRepliesMap (items, refs, options) {
  const list = Array.isArray(items) ? items : []
  const opts = isPlain(options) ? options : {}
  const skipNear = isCount(opts.skipNear) ? opts.skipNear : 5
  const max = isCount(opts.max) ? opts.max : 2
  const wanted = new Map()
  for (const ref of Array.isArray(refs) ? refs : []) {
    const key = canonicalRef(ref)
    if (key !== null && !wanted.has(key)) wanted.set(key, { parentAt: [], replies: [] })
  }
  const out = new Map()
  if (wanted.size === 0) return out
  for (let i = 0; i < list.length; i++) {
    const row = list[i]
    // A repost row shows the original, so its place is the parent's place.
    // A repost wrapper is not a reply, whatever it carries.
    const repost = isPlain(row) && row.kind === 'repost'
    const shownRef = repost ? itemRef(row.to) : itemRef(row)
    const asParent = shownRef === null ? undefined : wanted.get(shownRef)
    if (asParent !== undefined) asParent.parentAt.push(i)
    if (repost) continue
    const to = asTarget(row && row.replyTo)
    const asReply = to === null ? undefined : wanted.get(to.author + ':' + to.seq)
    if (asReply !== undefined) asReply.replies.push(i)
  }
  for (const [key, { parentAt, replies }] of wanted) {
    const lines = []
    out.set(key, lines)
    if (parentAt.length === 0) continue
    const seen = new Set()
    // Both index lists ascend, so one pointer finds the nearest parent row.
    let p = 0
    for (const i of replies) {
      if (lines.length >= max) break
      while (p < parentAt.length && parentAt[p] < i - skipNear) p++
      if (p < parentAt.length && parentAt[p] <= i + skipNear) continue
      const item = list[i]
      const ref = itemRef(item)
      if (ref === null || ref === key || seen.has(ref)) continue
      // A photo-only reply has no line to show; it must not take a slot.
      const text = typeof item.text === 'string' ? rpc.displayText(item.text, { multiline: true }) : ''
      if (text.trim() === '') continue
      seen.add(ref)
      lines.push({ key: ref, name: previewName(item), text })
    }
  }
  return out
}
