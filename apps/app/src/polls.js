// Enquetes: the pure card model and the editor state. A poll has 2 to 4
// options of 1 to 60 characters, distinct by pollKey, and no closing date.
// A vote is public (it sits in the voter's own diary), so the card carries the
// notice the screen shows before the first vote. Totals are the seeder's
// claim: the model says so and never turns them into a verified number. The
// own pick is read from the own diary, so it is the only verified part.
//
// No React, no platform module, no request, nothing from the network trusted
// beyond the shape checks below. The limits are kept here by hand, in step with
// the poll shape of the contract (docs/rpc.md).

export const POLL_OPTIONS_MIN = 2
export const POLL_OPTIONS_MAX = 4
export const POLL_OPTION_MAX = 60

export const NOTICES = Object.freeze({
  publicVote: 'Seu voto é público: quem vê o seu diário pode ver em quem você votou.',
  claimedTotals: 'Os totais vêm do semeador e podem estar incompletos.',
  noTotals: 'Ainda não deu para ler os totais.',
  tooFew: 'Coloque pelo menos duas opções.',
  tooMany: 'No máximo quatro opções.',
  emptyOption: 'Preencha ou remova as opções vazias.',
  tooLong: 'Cada opção tem no máximo 60 caracteres.',
  duplicate: 'As opções precisam ser diferentes.'
})

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isCount = (n) => Number.isSafeInteger(n) && n >= 0

// The characters that draw nothing, as the contract's poll rule strips them
// (packages/rpc/lib/poll.js, kept in step by hand).
const INVISIBLE = /[\u200b-\u200d\u2060\u00ad\u115f\u1160\u3164\uffa0\u2800\ufff9-\ufffb]|\udb40[\udc00-\udc7f]/g

// The text two options are compared by, as the contract's pollKey: NFKC when
// the runtime has it, without invisible characters, runs of whitespace as
// one space, trimmed. 'Sim' and 'Sim' + U+200B are the same option.
// The wire ref of a poll or event post: '<hex64>:<seq>' (rpc 5.135, 5.136).
export function choiceRef (author, seq) {
  return author + ':' + seq
}

export function pollKey (v) {
  let s = String(v)
  if (typeof String.prototype.normalize === 'function') {
    try {
      s = s.normalize('NFKC')
    } catch {}
  }
  return s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
}

// ---- the poll shape -------------------------------------------------------

// The poll as {options}, or null. Takes the shapes the contract carries: the
// bare array of a poll post (records, feeds), {options} and the summary
// {options, totals, mine} of group.topics (totals and mine are not read here).
// Options are peer data: counted in code points, never required to be
// trimmed, refused only when empty by pollKey or equal by pollKey. Trimming
// is the editor's job.
export function pollOf (v) {
  let o = null
  if (Array.isArray(v)) {
    o = v
  } else if (isObject(v) && Array.isArray(v.options) && Object.keys(v).every((k) => k === 'options' || k === 'totals' || k === 'mine')) {
    o = v.options
  }
  if (o === null || o.length < POLL_OPTIONS_MIN || o.length > POLL_OPTIONS_MAX) return null
  const seen = new Set()
  for (let i = 0; i < o.length; i++) {
    const x = o[i]
    if (typeof x !== 'string') return null
    const n = Array.from(x).length
    const key = pollKey(x)
    if (n < 1 || n > POLL_OPTION_MAX || key === '' || seen.has(key)) return null
    seen.add(key)
  }
  return { options: o.slice() }
}

// ---- the editor -----------------------------------------------------------

export function editorInit () {
  return { options: ['', ''] }
}

export function editorSetOption (state, index, text) {
  if (!isObject(state) || !Array.isArray(state.options) || !Number.isSafeInteger(index) || index < 0 || index >= state.options.length) return state
  const options = state.options.slice()
  options[index] = typeof text === 'string' ? text : ''
  return { options }
}

export function editorAddOption (state) {
  if (!isObject(state) || !Array.isArray(state.options) || state.options.length >= POLL_OPTIONS_MAX) return state
  return { options: state.options.concat('') }
}

export function editorRemoveOption (state, index) {
  if (!isObject(state) || !Array.isArray(state.options) || state.options.length <= POLL_OPTIONS_MIN) return state
  if (!Number.isSafeInteger(index) || index < 0 || index >= state.options.length) return state
  return { options: state.options.filter((_, i) => i !== index) }
}

export function editorCanAdd (state) {
  return isObject(state) && Array.isArray(state.options) && state.options.length < POLL_OPTIONS_MAX
}

export function editorCanRemove (state) {
  return isObject(state) && Array.isArray(state.options) && state.options.length > POLL_OPTIONS_MIN
}

// -> {ok: true, poll} with trimmed options, or {ok: false, error} (a notice).
export function editorPoll (state) {
  const raw = isObject(state) && Array.isArray(state.options) ? state.options : []
  const options = raw.map((x) => (typeof x === 'string' ? x.trim() : ''))
  if (options.length < POLL_OPTIONS_MIN) return { ok: false, error: NOTICES.tooFew }
  if (options.length > POLL_OPTIONS_MAX) return { ok: false, error: NOTICES.tooMany }
  if (options.some((x) => pollKey(x) === '')) return { ok: false, error: NOTICES.emptyOption }
  if (options.some((x) => Array.from(x).length > POLL_OPTION_MAX)) return { ok: false, error: NOTICES.tooLong }
  if (new Set(options.map(pollKey)).size !== options.length) return { ok: false, error: NOTICES.duplicate }
  return { ok: true, poll: { options } }
}

// ---- the card -------------------------------------------------------------

export function votesLabel (n) {
  if (!isCount(n)) return ''
  return n === 1 ? '1 voto' : n + ' votos'
}

// Totals as a seeder claim: {counts: [n per option], complete: boolean}, or
// null when they are missing or do not fit the poll. Takes a plain totals
// array (group.topics summary), {totals, indexing, complete} (/index/poll;
// totals is [] while the seeder is still indexing) or {counts, complete}.
// A bare array does not say whether it is complete, so it reads as incomplete.
function totalsOf (totals, size) {
  let counts = null
  let complete = false
  if (Array.isArray(totals)) {
    counts = totals
  } else if (isObject(totals) && Array.isArray(totals.counts)) {
    counts = totals.counts
    complete = totals.complete === true
  } else if (isObject(totals) && Array.isArray(totals.totals)) {
    counts = totals.totals
    complete = totals.complete === true && totals.indexing !== true
  }
  if (counts === null || counts.length !== size || !counts.every(isCount)) return null
  return { counts: counts.slice(), complete }
}

// poll: any shape pollOf takes; totals: the seeder's claim or null; own: the own pick read
// from the own diary (0..3), null for no vote, undefined when not read yet.
// -> null for a poll that is not valid, else the model the screen draws.
export function pollCard ({ poll, totals = null, own } = {}) {
  const p = pollOf(poll)
  if (p === null) return null
  const claim = totalsOf(totals, p.options.length)
  const pick = Number.isSafeInteger(own) && own >= 0 && own < p.options.length ? own : null
  const sum = claim === null ? 0 : claim.counts.reduce((a, b) => a + b, 0)
  const rows = p.options.map((label, index) => {
    const count = claim === null ? null : claim.counts[index]
    return {
      index,
      label,
      count,
      countLabel: count === null ? '' : votesLabel(count),
      percent: count === null || sum === 0 ? 0 : Math.round((count * 100) / sum),
      own: pick === index
    }
  })
  return {
    options: rows,
    own: pick,
    ownKnown: own !== undefined,
    total: claim === null ? null : sum,
    totalLabel: claim === null ? '' : votesLabel(sum),
    // Seeder claims, never verified here; incomplete when the seeder said so.
    claimed: claim !== null,
    incomplete: claim === null || !claim.complete,
    // Shown before the first vote, until the own diary has one.
    notice: pick === null ? NOTICES.publicVote : null,
    totalsNote: claim === null ? NOTICES.noTotals : NOTICES.claimedTotals,
    canVote: true
  }
}

// What a tap on option `index` does: the pick to write. Tapping the pick again
// takes the vote back (null). A bad index or an unread own pick writes nothing.
export function nextPick (card, index) {
  if (!isObject(card) || !card.ownKnown || !Number.isSafeInteger(index) || index < 0 || index >= card.options.length) return { write: false }
  return { write: true, pick: card.own === index ? null : index }
}
