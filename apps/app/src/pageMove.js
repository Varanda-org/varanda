// A closed or moved page as the app shows it: which key to open, where K1's
// posts stop and whether 'Seguir a chave nova' is offered. Pure: the caller
// passes the page.read answers (and an optional successor statement) in.
//
// The app cannot verify signatures (Metro cannot reach packages/core), so
// only what the node verified counts: page.read's movedTo and movedFrom. The
// statement from GET /account/pages/successor/<K1> (a paused K1 that holds no
// page-moved) is a hint, applied only when page.read of K2 reports a
// page-origin naming the same pair.

export const MAX_HOPS = 4

const KEY_RE = /^[0-9a-f]{64}$/
const isKey = (v) => typeof v === 'string' && KEY_RE.test(v)
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isSeq = (v) => Number.isSafeInteger(v) && v >= 0

// The pagesSuccessor answer ({ moved }, or null on 404) as { page, to,
// fromSeq? }, or null when it is not one.
export function successorOf (answer) {
  if (!isObject(answer)) return null
  const moved = isObject(answer.moved) ? answer.moved : null
  if (moved === null || !isKey(moved.page) || !isKey(moved.to) || moved.page === moved.to) return null
  const out = { page: moved.page, to: moved.to }
  const fromSeq = isSeq(moved.fromSeq) ? moved.fromSeq : isSeq(answer.fromSeq) ? answer.fromSeq : null
  if (fromSeq !== null) out.fromSeq = fromSeq
  return out
}

// The verified move out of `read`: { to, cut } where `cut` is the first seq
// of K1 that is no longer shown, or null. A closed page has no move.
export function moveOf (read, { statement = null, targetRead = null } = {}) {
  if (!isObject(read) || !isKey(read.page) || read.closed === true) return null
  const k1 = read.page
  if (isObject(read.movedTo) && isKey(read.movedTo.to) && isSeq(read.movedTo.seq) && read.movedTo.to !== k1) {
    return { to: read.movedTo.to, cut: read.movedTo.seq }
  }
  if (!isObject(statement) || statement.page !== k1 || !isKey(statement.to) || statement.to === k1) return null
  if (!isObject(targetRead) || targetRead.page !== statement.to) return null
  const from = targetRead.movedFrom
  if (!isObject(from) || from.from !== k1 || !isSeq(from.fromSeq)) return null
  if (statement.fromSeq !== undefined && statement.fromSeq !== from.fromSeq) return null
  return { to: statement.to, cut: from.fromSeq + 1 }
}

// Follows the moves from `start` for at most MAX_HOPS. `lookup(key)` answers
// { read, statement?, targetRead? } or null. A repeated key ends the walk.
export function resolveChain (start, lookup) {
  let key = start
  let hops = 0
  let last = null
  const seen = new Set([start])
  while (hops < MAX_HOPS) {
    const entry = typeof lookup === 'function' ? lookup(key) : null
    if (!isObject(entry)) break
    const move = moveOf(entry.read, entry)
    if (move === null || seen.has(move.to)) break
    seen.add(move.to)
    key = move.to
    last = entry.targetRead !== undefined ? entry.targetRead : null
    hops++
  }
  return { key, hops, last }
}

// What the profile of `read.page` shows. `chain` is resolveChain's answer
// for it (or null: only the first hop is known).
export function pageMoveView (read, { statement = null, targetRead = null, chain = null } = {}) {
  const page = isObject(read) && isKey(read.page) ? read.page : null
  const closed = isObject(read) && read.closed === true
  const move = moveOf(read, { statement, targetRead })
  if (page === null || closed || move === null) {
    return { key: page, cut: null, moved: false, closed, follow: false }
  }
  const finalKey = isObject(chain) && chain.hops > 0 && isKey(chain.key) ? chain.key : move.to
  const finalRead = isObject(chain) && chain.hops > 0 ? chain.last : targetRead
  const endClosed = isObject(finalRead) && finalRead.page === finalKey && finalRead.closed === true
  return { key: finalKey, cut: move.cut, moved: true, closed: false, follow: !endClosed }
}

// Whether a post of K1 at `seq` is still shown under `cut`.
export const shownUnderCut = (cut, seq) => cut === null || cut === undefined || (isSeq(seq) && seq < cut)
