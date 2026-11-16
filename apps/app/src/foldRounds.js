// The reads behind A Rua's comment fold (./feedFold.js), kept apart from the
// screen so they run in plain Node tests. Nothing here talks to the node:
// resolve, loadFollows and the rest are handed in by ARua.js useSocial.
//
// One fold ingest reads this page's reply parents first (uncapped, as the
// reply mark always read them), then at most FOLD_READ_ROUNDS rounds of the
// ancestors still missing. Strangers' ancestors cost a member lookup
// (/index/member) and a turn of the one peek slot each, so at most
// FOLD_STRANGER_READS of them are read per ingest; the rest wait for a later
// one. A ref the fold gives up on (a stranger this node cannot read, or one
// deeper than the rounds reach) goes to a dead set the fold alone consults,
// never into the shared originals: a later repost, quote or reply mark that
// needs the same post still reads it.

import { foldFeed, foldNeeds } from './feedFold.js'

export const FOLD_READ_ROUNDS = 3
export const FOLD_STRANGER_READS = 8

const authorOf = (ref) => ref.slice(0, ref.indexOf(':'))

// One fold round over `needs` (foldNeeds' refs). Own and followed authors
// are read on any node; strangers only when `strangers` (hosted and online)
// and while `budget` lasts. A stranger's ref this node cannot read is
// declined, so nothing waits on a read that never starts. One over the
// budget is left alone for a later ingest. A blocked author's ref is
// neither read nor declined (no card shows a blocked root).
export function foldAsk (needs, { isKnown, isBlocked, strangers, budget, skip }) {
  const ask = []
  const decline = []
  const later = []
  let left = budget
  for (const ref of needs) {
    if (skip && skip.has(ref)) continue
    const author = authorOf(ref)
    if (isBlocked(author)) continue
    if (isKnown(author)) ask.push(ref)
    else if (strangers !== true) decline.push(ref)
    else if (left > 0) {
      left--
      ask.push(ref)
    } else later.push(ref)
  }
  return { ask, decline, later, budget: left }
}

// The reply parents an ingest reads. Strangers' only when `strangers`
// (hosted and online), for the reply mark's verified name, as before the
// fold. With `fold`, also those of own and followed authors on any node, and
// no blocked author's at all.
export function parentAsks (parents, { fold, strangers, isKnown, isBlocked }) {
  const refs = Array.isArray(parents) ? parents.filter((r) => typeof r === 'string') : []
  const far = strangers === true
    ? refs.filter((r) => !isKnown(authorOf(r)) && !(fold === true && isBlocked(authorOf(r))))
    : []
  const kin = fold === true ? refs.filter((r) => isKnown(authorOf(r)) && !isBlocked(authorOf(r))) : []
  return { strangers: far, kin }
}

// The roots of the fold rows `list` makes that are no feed item: their
// counts and own like/repost state are read like a feed post's.
export function foldRoots (list, { originalOf, ownKey, blocked }) {
  const isBlocked = (ref) => !!blocked && typeof blocked.has === 'function' && blocked.has(authorOf(ref)) === true
  const out = []
  for (const row of foldFeed(list, { originalOf, ownKey, blocked }).rows) {
    if (!row || row.kind !== 'comentarios' || row.state === 'pending' || typeof row.root !== 'string') continue
    if (!isBlocked(row.root)) out.push(row.root)
  }
  return out
}

// The rounds of one fold ingest. `list`: the feed posts at hand, this page's
// first. `parents`: this ingest's reply parents, already recorded as asked.
// `answered`: the other refs this ingest read (originals, quotes). `stored(ref)`
// -> what the originals hold (null for a deleted post); `transient(ref)` ->
// whether that is a transient failure; `isDead(ref)` -> given up on by an
// earlier ingest. `onAsk(refs)` records the fold's asks before they are
// read, `onDead(refs)` its give-ups. `live()` turns false when the screen
// left or the originals were dropped. `tracker` (foldTracker) follows the
// rounds for pending()'s guess and is always stopped, whatever throws.
// -> { roots, dead }: foldRoots after the rounds (empty if no longer live)
// and the refs this ingest gave up on.
export async function foldRounds ({
  list, parents = [], answered = [], stored, transient = () => false, isDead = () => false,
  resolve, isKnown, isBlocked, live, loadFollows, strangers, onAsk = () => {}, onDead = () => {},
  ownKey = null, blocked = null, tracker = null
}) {
  const dead = new Set()
  const asked = new Set(answered)
  // A transient failure is an answer for what this ingest asked: it is not
  // asked again until the next ingest.
  // A stored answer wins over a give-up, as in foldOriginalOf.
  const originalOf = (ref) => {
    const blip = transient(ref)
    const item = stored(ref)
    if (item !== undefined && !blip) return item
    if (dead.has(ref) || isDead(ref)) return null
    if (blip) return asked.has(ref) ? null : undefined
    return item
  }
  const giveUp = (refs) => {
    const fresh = refs.filter((ref) => !dead.has(ref))
    if (fresh.length === 0 || !live()) return
    for (const ref of fresh) dead.add(ref)
    onDead(fresh)
  }
  const later = new Set()
  let budget = FOLD_STRANGER_READS
  if (tracker !== null) tracker.start({ budget, strangers: strangers === true, isBlocked })
  try {
    for (const ref of parents) asked.add(ref)
    if (parents.length > 0 && live()) await resolve(parents)
    let rounds = 0
    for (; rounds < FOLD_READ_ROUNDS; rounds++) {
      if (!live()) return { roots: [], dead }
      const needs = foldNeeds(list, originalOf)
      if (needs.some((ref) => !isKnown(authorOf(ref)))) await loadFollows()
      if (!live()) return { roots: [], dead }
      const plan = foldAsk(needs, { isKnown, isBlocked, strangers, budget, skip: later })
      budget = plan.budget
      if (tracker !== null) tracker.budget(budget)
      for (const ref of plan.later) later.add(ref)
      giveUp(plan.decline)
      if (plan.ask.length === 0) break
      for (const ref of plan.ask) asked.add(ref)
      onAsk(plan.ask)
      await resolve(plan.ask)
    }
    if (!live()) return { roots: [], dead }
    // Deeper than the rounds reach: given up on, never left waiting.
    if (rounds === FOLD_READ_ROUNDS) {
      giveUp(foldNeeds(list, originalOf).filter((ref) => !later.has(ref) && !isBlocked(authorOf(ref))))
    }
    return { roots: foldRoots(list, { originalOf, ownKey, blocked }), dead }
  } finally {
    if (tracker !== null) tracker.stop()
  }
}

// What pending() guesses for a ref nobody asked yet while a fold ingest is
// queued or running. Before the running ingest knows the follow list, and
// for every ingest still waiting behind it: any author not blocked. Once it
// does (start, right after follow.list): what its reads would ask for, so a
// stranger this node cannot read draws as the chip row at once. A render
// follows settle() only when a guess said pending, since only then can a row
// have drawn a state that no longer holds.
export function foldTracker () {
  let queued = 0
  let folding = null
  let guessed = false
  return {
    queue () { queued++ },
    start (state) { folding = { ...state } },
    budget (n) { if (folding !== null) folding.budget = n },
    stop () { folding = null },
    busy () { return queued > 0 || folding !== null },
    guess (author, { isKnown, isBlocked }) {
      let out = false
      if (folding !== null) {
        out = !folding.isBlocked(author) && (isKnown(author) || (folding.strangers === true && folding.budget > 0))
      }
      // The running ingest is one of the queued: the rest wait behind it.
      const waiting = queued - (folding !== null ? 1 : 0)
      if (!out && waiting > 0) out = !isBlocked(author)
      if (out) guessed = true
      return out
    },
    // A fold ingest ended, by any way out: its reading state goes with it.
    // -> true when the last queued fold ingest ended after a guess.
    settle () {
      folding = null
      if (queued > 0) queued--
      if (queued > 0) return false
      const out = guessed
      guessed = false
      return out
    }
  }
}

// Queues `run` after `tail` (ingests run one after the other). A fold
// ingest is marked queued at once, before it starts, and settled on every
// way out: done, thrown, or skipped because the screen left.
export function queueIngest (tail, run, { fold = false, tracker = null, onRender = null } = {}) {
  const tracked = fold === true && tracker !== null
  if (tracked) tracker.queue()
  return tail.then(run).catch(() => {}).then(() => {
    if (!tracked || !tracker.settle() || typeof onRender !== 'function') return
    try { onRender() } catch {}
  })
}

const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o)

// useSocial.pending(ref): asked and not answered. `stored(ref)` -> what the
// originals hold; `need` and `fold` the asked sets; `dead` the fold's
// give-ups; `guess(author)` the tracker's guess. A plain ask wins over a
// give-up (a repost or quote of that post is read), a give-up over the
// fold's asks and its guess.
export function pendingOf (ref, { stored, need, fold, dead, guess }) {
  if (typeof ref !== 'string' || stored(ref) !== undefined) return false
  if (need.has(ref)) return true
  if (dead.has(ref)) return false
  if (fold.has(ref)) return true
  return guess(authorOf(ref)) === true
}

// useSocial.foldOriginal(ref): the original as the fold sees it. A stored
// answer wins (a transient failure reads as still on its way, as
// original() has it); then a give-up ends the chain; then, while the ref is
// read again after a drop (`pending`), what the previous epoch held
// (`stale`), never for a blocked author.
export function foldOriginalOf (ref, { stored, isTransient, dead, stale, pending, isBlocked }) {
  if (typeof ref !== 'string') return null
  const item = stored(ref)
  if (item !== undefined) return isTransient(item) ? undefined : item
  if (dead.has(ref)) return null
  if (!stale.has(ref) || isBlocked(authorOf(ref))) return undefined
  return pending(ref) ? stale.get(ref) : undefined
}

// What a drop of the originals leaves the fold to show while each ref is
// read again: every post item, and null for each unavailable, deleted or
// given-up ref; a transient failure is no answer. `prev` (the last drop's
// map) keeps its entries for refs these originals do not hold yet, so a
// second drop before the answers does not split the cards again; never for
// a deleted ref or a blocked author.
export function staleOf (originals, { dead, deleted, isTransient, prev = null, isBlocked = () => false }) {
  const out = new Map()
  for (const [ref, item] of originals) if (!isTransient(item)) out.set(ref, deleted.has(ref) ? null : item)
  for (const ref of dead) if (!out.has(ref)) out.set(ref, null)
  if (prev instanceof Map) {
    for (const [ref, item] of prev) {
      if (out.has(ref) || isBlocked(authorOf(ref))) continue
      out.set(ref, deleted.has(ref) ? null : item)
    }
  }
  return out
}

// The ingest that reads the counts and own state of fold roots no feed item
// holds: refs not `shown` yet nor `done` this epoch (marked here). A plain
// ingest, never a fold one, so it cannot start more rounds. -> null when
// there is nothing to read.
export function rootIngest (roots, { shown, done }) {
  const fresh = []
  for (const ref of roots) {
    if (typeof ref !== 'string' || shown.has(ref) || done.has(ref) || fresh.includes(ref)) continue
    fresh.push(ref)
  }
  if (fresh.length === 0) return null
  for (const ref of fresh) done.add(ref)
  return { shown: fresh }
}

// The reply parents of `local` (ref -> feed post) that it does not hold.
export function replyParents (local) {
  const out = []
  for (const item of local.values()) {
    if (!isPlain(item) || item.kind === 'repost' || !isPlain(item.replyTo)) continue
    const t = item.replyTo
    if (typeof t.author !== 'string' || !Number.isSafeInteger(t.seq) || t.seq < 1) continue
    const ref = t.author.toLowerCase() + ':' + t.seq
    if (!local.has(ref) && !out.includes(ref)) out.push(ref)
  }
  return out
}

// After a follows drop: the plain asks (`need`) replayed as plain reads, and
// on a screen that folds (`foldOn`) one fold ingest over the posts at hand,
// with their reply parents as round 0, as a page ingest has them. The fold's
// own asks are never replayed as plain reads. -> null when nothing to do.
export function replayIngest ({ need, local }, foldOn) {
  const fold = foldOn === true
  if (need.size === 0 && !fold) return null
  return { need: [...need], local, fold, ...(fold ? { parents: replyParents(local) } : {}) }
}
