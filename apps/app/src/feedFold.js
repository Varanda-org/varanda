// Pure fold of A Rua's list: a comment folds into the card of the post it
// belongs to ("Ana comentou"), Instagram style, instead of standing alone
// with a 'Respondendo a' chip. Nothing here fetches or checks a signature:
// the items are feed posts and originals the node already verified, and the
// walk follows only their signed replyTo. The bound on network reads lives in
// the caller (foldNeeds says what is missing, the caller decides what to ask).
//
// The list is newest first (paging.js), so "first position" is the lowest
// index and an older page only appends at the end. A group's place is the
// first of: the root's own row, the root's first repost row (by someone not
// blocked), the first comment someone else wrote. Rows already emitted
// therefore keep their place when an older page arrives, with one known
// edge: a reply whose chain resolves only later (its missing ancestor comes
// with the older page, or originalOf answers) was a chip row until then and
// now joins its root's group. If that group sits below the reply, the card
// moves up to the reply's place and leaves its old one; if it sits above,
// the chip row leaves the list and its line joins the card there.
//
// Peer name and text pass through displayText before they leave.

import rpc from '@varanda/rpc'
import { isAuthorKey } from './nav.js'
import { feedKey } from './paging.js'
import { atName, readsAs } from './who.js'

// Hops of signed replyTo walked per reply over records at hand.
export const FOLD_WALK_MAX = 32

const OWN_NAME = 'Você'
const UNNAMED = 'Alguém'

const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o)
const isCount = (n) => Number.isSafeInteger(n) && n >= 0

// Stricter than ARua.js refOf, which only lowercases: replyTo and to come
// from peers, so a ref here must name a 64-hex key, never something foldNeeds
// would hand the caller to read. A valid ref is the same string in both, so
// it matches ARua's originals map.
function refOf (t) {
  if (!isPlain(t) || typeof t.author !== 'string' || !Number.isSafeInteger(t.seq) || t.seq < 1) return null
  const author = t.author.toLowerCase()
  return isAuthorKey(author) ? author + ':' + t.seq : null
}

const isRepost = (row) => isPlain(row) && row.kind === 'repost'

function isPost (item) {
  if (!isPlain(item) || item.kind === 'repost') return false
  return item.kind === undefined || item.kind === 'post'
}

const isReply = (item) => isPost(item) && !!item.replyTo && refOf(item) !== null

function shown (value) {
  if (typeof value !== 'string') return ''
  return rpc.displayText(value).trim()
}

// A peer whose name reads as 'Você' would pass for the viewer's own line and
// header, so it is named by its verified @nome, or as nobody in particular.
// A Rua names a pending comment row by the same rule.
export function previewName (item) {
  const name = shown(item && item.name) || shown(item && item.username)
  if (!readsAs(name, OWN_NAME)) return name
  return atName(item.username) || UNNAMED
}

function authorOf (item) {
  return typeof item.author === 'string' ? item.author.toLowerCase() : ''
}

function blockedBy (blocked) {
  if (!blocked || typeof blocked.has !== 'function') return () => false
  return (author) => typeof author === 'string' && author !== '' && blocked.has(author) === true
}

// The list's own records by ref, first occurrence wins. A repost wrapper is
// at hand too, as null: a known non-post, so a reply to it keeps its chip and
// nobody asks for a ref already in the list.
function postsAtHand (list) {
  const out = new Map()
  for (const item of list) {
    const post = isPost(item)
    if (!post && !isRepost(item)) continue
    const ref = refOf(item)
    if (ref !== null && !out.has(ref)) out.set(ref, post ? item : null)
  }
  return out
}

const DEAD = Object.freeze({ kind: 'dead' })

// resolve(ref) -> the outcome for the chain that starts at ref:
//   { kind: 'root', root, post, top, dist }: top is the node directly under
//     the root (null when ref is the root itself), dist the hops to it;
//   { kind: 'need', need, dist }: need is the first ancestor not at hand;
//   DEAD: known unreadable, not a post, malformed replyTo, a cycle, or
//     further than FOLD_WALK_MAX hops.
// Memo entries hold exact distances, so the outcome of a ref never depends
// on which reply was walked first.
function makeResolver (atHand, originalOf) {
  const memo = new Map()
  const lookup = (ref) => {
    const listed = atHand.get(ref)
    if (listed !== undefined) return listed
    if (typeof originalOf !== 'function') return undefined
    const o = originalOf(ref)
    if (o === undefined) return undefined
    // A sentinel (ARua's TRANSIENT) or a record of another ref is no answer
    // to show as this post.
    return isPost(o) && refOf(o) === ref ? o : null
  }
  return (start) => {
    const path = []
    const onPath = new Set()
    let cur = start
    let end = null
    for (;;) {
      if (path.length > FOLD_WALK_MAX) return DEAD
      const hit = memo.get(cur)
      if (hit !== undefined) {
        end = hit
        break
      }
      // The cap above already ends a cycle; this only saves the extra hops.
      if (onPath.has(cur)) {
        end = DEAD
        break
      }
      const item = lookup(cur)
      if (item === undefined) {
        end = { kind: 'need', need: cur, dist: 0 }
      } else if (item === null) {
        end = DEAD
      } else if (!item.replyTo) {
        end = { kind: 'root', root: cur, post: item, top: null, dist: 0 }
      } else {
        const parent = refOf(item.replyTo)
        if (parent === null) {
          end = DEAD
        } else {
          path.push(cur)
          onPath.add(cur)
          cur = parent
          continue
        }
      }
      memo.set(cur, end)
      break
    }
    let result = end
    for (let i = path.length - 1; i >= 0; i--) {
      const dist = end.dist + (path.length - i)
      let out = DEAD
      if (end !== DEAD && dist <= FOLD_WALK_MAX) {
        if (end.kind === 'root') {
          const top = end.top === null ? path[path.length - 1] : end.top
          out = { kind: 'root', root: end.root, post: end.post, top, dist }
        } else {
          out = { kind: 'need', need: end.need, dist }
        }
      }
      memo.set(path[i], out)
      if (i === 0) result = out
    }
    return result
  }
}

// -> { rows, attached }. rows: the list with comments folded, untouched
// items as the same objects; attached: Map(row key -> { by, lines,
// comments }) for a root or repost row that already holds its comments.
export function foldFeed (items, options) {
  const list = Array.isArray(items) ? items : []
  const opts = isPlain(options) ? options : {}
  const maxLines = isCount(opts.maxLines) ? opts.maxLines : 2
  const own = typeof opts.ownKey === 'string' && opts.ownKey !== '' ? opts.ownKey.toLowerCase() : null
  const pendingOf = typeof opts.pendingOf === 'function' ? opts.pendingOf : () => false
  const isBlocked = blockedBy(opts.blocked)
  const resolve = makeResolver(postsAtHand(list), opts.originalOf)

  const rootRows = new Map()
  const firstRepost = new Map()
  const groups = new Map()
  const replace = new Map()
  const drop = new Set()

  for (let i = 0; i < list.length; i++) {
    const row = list[i]
    if (isRepost(row)) {
      // BlockGate hides a blocked reposter's row: it cannot hold a group.
      if (isBlocked(authorOf(row))) continue
      const to = refOf(row.to)
      if (to !== null && !firstRepost.has(to)) firstRepost.set(to, i)
      continue
    }
    if (!isPost(row)) continue
    const ref = refOf(row)
    if (ref === null) continue
    if (!row.replyTo) {
      const at = rootRows.get(ref)
      if (at === undefined) rootRows.set(ref, [i])
      else at.push(i)
      continue
    }
    const author = authorOf(row)
    // BlockGate hides a blocked author's row; it never joins a card.
    if (isBlocked(author)) continue
    const mine = own !== null && author === own
    const outcome = resolve(ref)
    if (outcome.kind === 'root' && outcome.root !== ref) {
      // No card shows a blocked root: others' comments stay plain rows.
      if (isBlocked(outcome.root.slice(0, outcome.root.indexOf(':')))) {
        if (mine) drop.add(i)
        continue
      }
      let group = groups.get(outcome.root)
      if (group === undefined) {
        group = { root: outcome.root, post: outcome.post, comments: [], seen: new Set() }
        groups.set(outcome.root, group)
      }
      if (group.seen.has(ref)) {
        drop.add(i)
        continue
      }
      group.seen.add(ref)
      group.comments.push({ i, item: row, ref, top: outcome.top, mine })
      continue
    }
    if (mine) {
      drop.add(i)
      continue
    }
    if (outcome.kind === 'need' && pendingOf(outcome.need) === true) {
      replace.set(i, { kind: 'comentarios', state: 'pending', key: feedKey(row) })
    }
  }

  const attached = new Map()
  for (const group of groups.values()) {
    const plain = rootRows.get(group.root) || []
    const others = group.comments.find((c) => !c.mine)
    const candidates = []
    if (plain.length > 0) candidates.push(plain[0])
    if (firstRepost.has(group.root)) candidates.push(firstRepost.get(group.root))
    if (others !== undefined) candidates.push(others.i)
    for (const c of group.comments) drop.add(c.i)
    if (candidates.length === 0) continue
    const place = Math.min(...candidates)
    const { by, lines, comments } = summarize(group.comments, maxLines)
    if (others === undefined || place !== others.i) {
      attached.set(feedKey(list[place]), { by, lines, comments })
      continue
    }
    replace.set(place, { kind: 'comentarios', key: 'c:' + group.root, root: group.root, post: group.post, by, comments, lines })
    drop.delete(place)
    for (const at of plain) if (at > place) drop.add(at)
  }

  const rows = []
  for (let i = 0; i < list.length; i++) {
    const swap = replace.get(i)
    if (swap !== undefined) rows.push(swap)
    else if (!drop.has(i)) rows.push(list[i])
  }
  return { rows, attached }
}

// Comments arrive newest first, as the list holds them.
function summarize (comments, maxLines) {
  const by = []
  const byAuthor = new Map()
  const lines = []
  const out = []
  for (const c of comments) {
    out.push({ ref: c.ref, top: c.top })
    const name = c.mine ? OWN_NAME : previewName(c.item)
    if (!c.mine) {
      const author = authorOf(c.item)
      const entry = byAuthor.get(author)
      if (entry === undefined) {
        const next = { author, name }
        byAuthor.set(author, next)
        by.push(next)
      } else if (entry.name === '' && name !== '') {
        entry.name = name
      }
    }
    if (lines.length >= maxLines) continue
    // A photo-only comment has no line to show; it must not take a slot.
    const text = typeof c.item.text === 'string' ? rpc.displayText(c.item.text, { multiline: true }) : ''
    if (text.trim() === '') continue
    lines.push({ key: c.ref, name, text })
  }
  return { by, lines, comments: out }
}

// Per unresolved chain, the first ancestor ref not at hand (neither in the
// list nor given by originalOf), distinct, in list order. A chain longer than
// FOLD_WALK_MAX, a cycle or a known-unreadable ancestor needs nothing.
export function foldNeeds (items, originalOf) {
  const list = Array.isArray(items) ? items : []
  const resolve = makeResolver(postsAtHand(list), originalOf)
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (!isReply(item)) continue
    const outcome = resolve(refOf(item))
    if (outcome.kind !== 'need' || seen.has(outcome.need)) continue
    seen.add(outcome.need)
    out.push(outcome.need)
  }
  return out
}

// by: foldFeed's commenters, newest first.
export function commentedLabel (by) {
  const list = Array.isArray(by) ? by.filter(isPlain) : []
  if (list.length === 0) return ''
  const name = (entry) => {
    const text = shown(entry.name)
    return text === '' || readsAs(text, OWN_NAME) ? UNNAMED : text
  }
  if (list.length === 1) return name(list[0]) + ' comentou'
  if (list.length === 2) {
    const first = name(list[0])
    const second = name(list[1])
    // 'Alguém e Alguém' reads as a typo; two people with one name are still two.
    if (first === second) return first + ' e outra pessoa comentaram'
    return first + ' e ' + second + ' comentaram'
  }
  return name(list[0]) + ' e mais ' + (list.length - 1) + ' comentaram'
}

export function withOwnReplies (items, own, ownKey) {
  const list = Array.isArray(items) ? items : []
  if (!Array.isArray(own) || typeof ownKey !== 'string' || ownKey === '') return list
  const author = ownKey.toLowerCase()
  const replies = own.filter((item) => isReply(item) && authorOf(item) === author)
  return replies.length === 0 ? list : replies.concat(list)
}

export function keepOwnReply (list, item, max = 20) {
  const ref = refOf(item)
  if (ref === null) return list
  return [item, ...list.filter((entry) => refOf(entry) !== ref)].slice(0, max)
}

export function dropOwnReplies (list, refs) {
  const remaining = list.filter((item) => !refs.has(refOf(item)))
  return remaining.length === list.length ? list : remaining
}

// Once the feed carries a reply it is the truth: the local copy goes, so a
// deletion made on another device is not kept alive by it.
export function dropFedReplies (list, items) {
  if (!Array.isArray(list) || list.length === 0 || !Array.isArray(items)) return list
  const fed = new Set()
  for (const item of items) {
    const ref = refOf(item)
    if (ref !== null) fed.add(ref)
  }
  return dropOwnReplies(list, fed)
}

// The index counts direct replies only, so use the larger of the two counts.
export function knownReplies (fold) {
  if (!isPlain(fold) || (fold.kind !== undefined && fold.kind !== 'comentarios') || !Array.isArray(fold.comments)) return 0
  const tops = new Set()
  for (const comment of fold.comments) {
    if (!isPlain(comment)) continue
    const { top } = comment
    if (typeof top === 'string' && top !== '') tops.add(top)
  }
  return tops.size
}
