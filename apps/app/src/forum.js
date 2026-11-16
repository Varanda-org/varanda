// Forums (topics in a public group): the pure model, on the group contract
// (docs/rpc.md): a ref is {writer, seq}. A topic is an ordinary group post
// with no reply parent plus a side record marking it. The list shows topics in
// the order group.topics answers (newest first) with an
// "última resposta" label; a reply never moves a topic up. In the chat a topic
// root is a compact card and the replies inside a topic are hidden.
//
// No React, no platform module, no request. Message text is peer text: it is
// only cut to a title here, never interpreted.

export const TITLE_MAX = 80
export const UNTITLED = 'Tópico sem título'
// The label of a moderated post, the same words the chat shows (groups.js
// HIDDEN_LABEL, kept in step by a test: this module imports nothing).
export const HIDDEN_LABEL = 'mensagem escondida'

const HEX64 = /^[0-9a-f]{64}$/
const MAX_CHAIN = 64

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const isRef = (r) => isObject(r) && typeof r.writer === 'string' && HEX64.test(r.writer) && isSeq(r.seq)
export const refOf = (r) => (isRef(r) ? r.writer + ':' + r.seq : null)

const atMs = (s) => {
  const t = typeof s === 'string' ? Date.parse(s) : NaN
  return Number.isNaN(t) ? null : t
}

// The title: the first non-empty line, cut to TITLE_MAX characters.
export function topicTitle (text) {
  if (typeof text !== 'string') return UNTITLED
  const line = text.split(/\r\n|\r|\n/).map((l) => l.trim()).find((l) => l !== '')
  if (line === undefined) return UNTITLED
  const chars = Array.from(line)
  return chars.length <= TITLE_MAX ? line : chars.slice(0, TITLE_MAX - 1).join('').trimEnd() + '…'
}

// "há 5 min", "há 3 h", "há 2 d"; a date in the future reads as "agora".
export function ago (at, now) {
  const t = atMs(at)
  if (t === null || !Number.isSafeInteger(now)) return ''
  const s = Math.floor((now - t) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return 'há ' + Math.floor(s / 60) + ' min'
  if (s < 86400) return 'há ' + Math.floor(s / 3600) + ' h'
  return 'há ' + Math.floor(s / 86400) + ' d'
}

export function lastReplyLabel (topic, now) {
  const n = isObject(topic) && Number.isSafeInteger(topic.replies) && topic.replies > 0 ? topic.replies : 0
  if (n === 0) return 'sem respostas'
  const when = ago(topic.last, now)
  return when === '' ? 'última resposta' : 'última resposta ' + when
}

// topics: group.topics items [{writer, diary, seq, at, text, hidden, replies, last}]
// -> rows in the order the server answered (authoritative, newest root first in
// causal order; never re-sorted here). A reply never changes it. A malformed
// or repeated topic is left out.
export function topicList (topics, now) {
  const rows = []
  const seen = new Set()
  for (const t of Array.isArray(topics) ? topics : []) {
    if (!isObject(t) || !isRef(t) || atMs(t.at) === null) continue
    const key = refOf(t)
    if (seen.has(key)) continue
    seen.add(key)
    const replies = Number.isSafeInteger(t.replies) && t.replies > 0 ? t.replies : 0
    const last = replies > 0 && atMs(t.last) !== null ? t.last : null
    const hidden = t.hidden === true
    rows.push({
      key,
      writer: t.writer,
      diary: typeof t.diary === 'string' && HEX64.test(t.diary) ? t.diary : null,
      seq: t.seq,
      at: t.at,
      hidden,
      text: hidden || typeof t.text !== 'string' ? '' : t.text,
      title: hidden ? HIDDEN_LABEL : topicTitle(t.text),
      replies,
      last,
      lastReplyLabel: lastReplyLabel({ replies, last }, now)
    })
  }
  return rows
}

// The topic root a message belongs to (its own ref when it is one), or null:
// the fallback when the item carries no `topic` marker. messages are items
// {writer, seq, replyTo}, topics a Set of 'writer:seq'.
function topicRootOf (msg, byRef, topics) {
  let cur = msg
  for (let i = 0; i < MAX_CHAIN && isObject(cur); i++) {
    const ref = refOf(cur)
    if (ref !== null && topics.has(ref)) return ref
    const parent = refOf(cur.replyTo)
    if (parent === null) return null
    if (topics.has(parent)) return parent
    cur = byRef.get(parent)
  }
  return null
}

// The chat view of group.read items. With marks (`item.topic`: null, or the
// root {writer, seq, poll} the item opens or belongs to) the server decides:
// a topic root becomes a compact card, any other item of a topic is hidden,
// the rest stay as they are. An item with no marker (`topic` undefined) falls
// back to walking the replyTo chain against topicRefs (a Set or array of
// 'writer:seq'). Order is kept.
export function chatView (messages, topicRefs) {
  const topics = topicRefs instanceof Set ? topicRefs : new Set(Array.isArray(topicRefs) ? topicRefs : [])
  const list = Array.isArray(messages) ? messages : []
  const byRef = new Map()
  for (const m of list) if (isObject(m) && refOf(m) !== null) byRef.set(refOf(m), m)
  const out = []
  for (const m of list) {
    if (!isObject(m)) continue
    const ref = refOf(m)
    const mark = m.topic === null ? null : isRef(m.topic) ? refOf(m.topic) : undefined
    if (mark === null) {
      out.push({ kind: 'message', ref, message: m })
    } else if (mark !== undefined) {
      if (mark === ref) out.push({ kind: 'topic', ref, message: m, title: topicTitle(m.text), poll: m.topic.poll === true })
    } else if (ref !== null && topics.has(ref)) {
      out.push({ kind: 'topic', ref, message: m, title: topicTitle(m.text), poll: false })
    } else if (topicRootOf(m, byRef, topics) === null) {
      out.push({ kind: 'message', ref, message: m })
    }
  }
  return out
}

// ---- one topic's thread (group.read with topic) ----

// The seen mark of a group read: the newest item the node holds (items come
// newest first), painted in the chat or not. A reply inside a topic is hidden
// from the chat but still counts as read when the person sees the group.
export function seenCut (items) {
  const first = Array.isArray(items) ? items[0] : null
  return isObject(first) && isRef(first) && typeof first.at === 'string' ? { at: first.at, writer: first.writer, seq: first.seq } : null
}

// The newest page of a topic read plus the older pages loaded after it
// (tail: { items, next } or null), newest first and without repeats ->
// { items, next }, next being the cursor for the page before the last one
// held (null: nothing older). A tail is ignored while the head says there is
// nothing older.
export function threadOf (head, tail) {
  const items = []
  const seen = new Set()
  const add = (list) => {
    for (const i of Array.isArray(list) ? list : []) {
      const k = refOf(i)
      if (k === null || seen.has(k)) continue
      seen.add(k)
      items.push(i)
    }
  }
  const headNext = isObject(head) && isObject(head.next) ? head.next : null
  add(isObject(head) ? head.items : null)
  if (headNext === null || !isObject(tail)) return { items, next: headNext }
  add(tail.items)
  return { items, next: isObject(tail.next) ? tail.next : null }
}

// Whether the older pages held stay joined to a fresh newest page: its items
// still reach the oldest item the previous newest page had. Otherwise newer
// replies pushed a gap between them and the older pages are dropped.
export function keepsTail (prevHead, nextHead) {
  const prev = isObject(prevHead) && Array.isArray(prevHead.items) ? prevHead.items : []
  const now = isObject(nextHead) && Array.isArray(nextHead.items) ? nextHead.items : []
  if (prev.length === 0) return false
  const oldest = refOf(prev[prev.length - 1])
  return oldest !== null && now.some((i) => refOf(i) === oldest)
}

// Whether a reply box is offered. The root need not be on the page held (a
// long topic leaves it on the oldest page): its state comes from the page when
// it is there, else from what the list that opened the topic knew (navRoot:
// { hidden, text } or null). A hidden root takes no replies; unknown (no page
// yet) offers none until the first read.
export function replyAllowed ({ loaded, rootItem, navRoot }) {
  if (!loaded) return false
  if (isObject(rootItem)) return rootItem.hidden !== true
  return !(isObject(navRoot) && navRoot.hidden === true)
}
