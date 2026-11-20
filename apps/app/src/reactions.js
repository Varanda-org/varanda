// One reaction per person per message. Entries are { emoji, count, mine }.
// toggleOf returns '' when that emoji is already yours on a chip, otherwise
// the emoji to set. applyOptimistic drops one from every own emoji before
// adding the new one, and a count that would pass through zero is removed.
// whoLines lists every name for the sheet. reactorsLabel stays a short line.

import { EMOJI } from './emoji.js'

// U+FE0F stays on the heart: without it the character is not the emoji people tap.
export const QUICK = Object.freeze([
  '\u2764\ufe0f',
  '\u{1F44D}',
  '\u{1F602}',
  '\u{1F62E}',
  '\u{1F622}',
  '\u{1F64F}'
])

const nameByEmoji = new Map(EMOJI.map((item) => [item.e, item.name]))

// A screen reader should say the Portuguese name. An emoji the catalogue
// does not know stays itself, so the label is never empty.
export function reactionName (emoji) {
  if (typeof emoji !== 'string') return ''
  const name = nameByEmoji.get(emoji)
  return typeof name === 'string' && name !== '' ? name : emoji
}

function clampCount (value) {
  if (!Number.isSafeInteger(value) || value < 0) return 0
  return value
}

// First-seen order. A later row for the same emoji adds to the count.
function aggregate (reactions) {
  const out = []
  if (!Array.isArray(reactions)) return out
  for (const row of reactions) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    if (typeof row.emoji !== 'string' || row.emoji === '') continue
    const count = clampCount(row.count)
    if (count === 0) continue
    const mine = row.mine === true
    const prev = out.find((item) => item.emoji === row.emoji)
    if (prev) {
      prev.count += count
      if (mine) prev.mine = true
    } else {
      out.push({ emoji: row.emoji, count, mine })
    }
  }
  return out
}

function chipLabel (emoji, count, mine) {
  const name = reactionName(emoji)
  const word = count === 1 ? 'reação' : 'reações'
  const label = name + ', ' + count + ' ' + word
  return mine ? label + ', sua reação' : label
}

export function reactionChips (reactions, opts) {
  const max = opts && Number.isSafeInteger(opts.max) && opts.max >= 0 ? opts.max : 6
  const chips = []
  let hiddenOwn = null
  for (const row of aggregate(reactions)) {
    const chip = {
      emoji: row.emoji,
      count: row.count,
      mine: row.mine,
      label: chipLabel(row.emoji, row.count, row.mine)
    }
    if (chips.length < max) chips.push(chip)
    else if (row.mine && hiddenOwn === null) hiddenOwn = chip
  }
  // The caller's list can outgrow the row. Replacing the last chip keeps the
  // own reaction on screen instead of cutting it.
  if (hiddenOwn && chips.length > 0 && !chips.some((chip) => chip.mine)) {
    chips[chips.length - 1] = hiddenOwn
  }
  return chips
}

export function toggleOf (reactions, emoji) {
  if (typeof emoji !== 'string' || emoji === '') return ''
  // The chips drop a count that is not a positive integer. Treating that
  // mine flag as "already yours" would clear a reaction that is not shown.
  for (const row of aggregate(reactions)) {
    if (row.mine === true && row.emoji === emoji) return ''
  }
  return emoji
}

export function applyOptimistic (reactions, emoji) {
  const adding = typeof emoji === 'string' && emoji !== ''
  const next = []
  let placed = false
  for (const row of aggregate(reactions)) {
    // Each mine flag counts this person once. Two flags would leave them in
    // the old total after the new emoji is added.
    let count = row.mine ? row.count - 1 : row.count
    if (count < 0) count = 0
    let mine = false
    if (adding && row.emoji === emoji) {
      count += 1
      mine = true
      placed = true
    }
    if (count > 0) next.push({ emoji: row.emoji, count, mine })
  }
  if (adding && !placed) next.push({ emoji, count: 1, mine: true })
  return next
}

function cleanNames (names) {
  const clean = []
  if (!Array.isArray(names)) return clean
  for (const name of names) {
    if (typeof name !== 'string') continue
    const text = name.trim()
    if (text === '') continue
    clean.push(text)
  }
  return clean
}

function totalOf (clean, count) {
  return Number.isSafeInteger(count) && count >= 0 ? count : clean.length
}

function peoplePhrase (n) {
  return n === 1 ? '1 pessoa' : n + ' pessoas'
}

function morePhrase (n) {
  return 'e mais ' + n
}

// Up to three names. The rest is "e mais N", from count when it is known.
// No names at all: "N pessoas", or "1 pessoa".
export function reactorsLabel (names, count) {
  const clean = cleanNames(names)
  const total = totalOf(clean, count)
  if (clean.length === 0) return peoplePhrase(total)
  const shown = clean.slice(0, Math.min(3, total))
  const extra = total - shown.length
  if (shown.length === 0) return ''
  if (extra > 0) return shown.join(', ') + ' ' + morePhrase(extra)
  if (shown.length === 1) return shown[0]
  if (shown.length === 2) return shown[0] + ' e ' + shown[1]
  return shown[0] + ', ' + shown[1] + ' e ' + shown[2]
}

// The sheet scrolls, so it can show every name it was given. "e mais N" is
// only the people past that list. reactorsLabel stays the three-name line.
export function whoLines (names, count) {
  const clean = cleanNames(names)
  const total = totalOf(clean, count)
  if (clean.length === 0) return [peoplePhrase(total)]
  if (total > clean.length) clean.push(morePhrase(total - clean.length))
  return clean
}
