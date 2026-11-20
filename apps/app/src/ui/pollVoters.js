// Who voted for one option, from the voters' own signed diaries (the
// seeder only points). Pure: no React, no request.
//
// A voter's live choice is the LAST one in their diary (core polls.js
// livePick), so the block the seeder named only counts while no newer choice
// on the same poll follows it: a pick of another option or a withdrawal moves
// or clears the vote. The newer blocks are read through a bounded tail.

// Blocks read after the pointed one (the pointed block included in the peek).
export const TAIL_BLOCKS = 8

// Same value as packages/core/lib/polls.js MAX_FUTURE_MS: a choice dated more
// than a day ahead is not written yet and counts from its date.
export const MAX_FUTURE_MS = 86400000

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// The diary.peek seqs for a voter pointed at `seq`: the block and the tail.
export function voterSeqs (seq) {
  const out = []
  for (let i = 0; i <= TAIL_BLOCKS; i++) out.push(seq + i)
  return out
}

const futureAt = (at, now) => {
  const t = typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isNaN(t) || t - now > MAX_FUTURE_MS
}

const sameTarget = (to, author, seq) => isObject(to) && to.author === author && to.seq === seq

// items: the seeder's pointers [{ key, seq }]; peeked: Map key -> { entries,
// profile, username } as peeked with voterSeqs; (author, seq): the poll post;
// pick: the option listed; now: ms clock. A block that was deleted or hidden
// is absent from the peek and so never counts.
export function confirmedVoters (items, peeked, author, seq, pick, now = Date.now()) {
  const out = []
  for (const it of Array.isArray(items) ? items : []) {
    const peek = peeked.get(it.key)
    const entries = peek && Array.isArray(peek.entries) ? peek.entries.filter((e) => isObject(e) && Number.isSafeInteger(e.seq) && isObject(e.record)) : []
    const own = entries.find((e) => e.seq === it.seq)
    const r = own ? own.record : null
    if (!r || r.type !== 'choice' || r.pick !== pick || !sameTarget(r.to, author, seq) || futureAt(r.at, now)) continue
    const superseded = entries.some((e) => e.seq > it.seq && e.record.type === 'choice' && sameTarget(e.record.to, author, seq) && !futureAt(e.record.at, now))
    if (superseded) continue
    out.push({ key: it.key, name: peek.profile && typeof peek.profile.name === 'string' ? peek.profile.name : null, username: typeof peek.username === 'string' ? peek.username : null })
  }
  return out
}
