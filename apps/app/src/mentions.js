// Composer mention helpers. Pure: no React, React Native or Node built-ins.

import rpc from '@varanda/rpc'

const { activeMention, MAX_TEXT } = rpc

export const MENTION_SUGGESTIONS_MAX = 5
export const MENTION_MIN_QUERY = 2

const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
const HEX6_RE = /^[0-9a-f]{6}$/

export function validUsername (username) {
  return typeof username === 'string' && USERNAME_RE.test(username) && !HEX6_RE.test(username)
}

function unchanged (text, selection) {
  return { text, selection, changed: false }
}

export function insertMention (text, selection, username, max = MAX_TEXT) {
  try {
    if (typeof text !== 'string' || selection === null || typeof selection !== 'object' ||
      typeof selection.start !== 'number' || !Number.isFinite(selection.start) ||
      selection.start !== selection.end || !validUsername(username)) {
      return unchanged(text, selection)
    }
    const active = activeMention(text, selection.start)
    if (active === null) return unchanged(text, selection)
    const name = '@' + username
    const after = text.slice(active.end)
    // Reuse existing whitespace so a mid-text pick does not double the space.
    const spaced = /^[ \t\n]/.test(after)
    let insert = spaced ? name : name + ' '
    let next = text.slice(0, active.start) + insert + after
    if (Array.from(next).length > max && !spaced) {
      // Drop only the courtesy space when the name itself still fits.
      insert = name
      next = text.slice(0, active.start) + insert + after
    }
    if (Array.from(next).length > max) return unchanged(text, selection)
    const caret = active.start + insert.length + (spaced ? 1 : 0)
    return { text: next, selection: { start: caret, end: caret }, changed: true }
  } catch {
    return unchanged(text, selection)
  }
}

export function suggestionRows (hits, query, ownKey, max = MENTION_SUGGESTIONS_MAX) {
  try {
    if (!Array.isArray(hits)) return []
    const limit = typeof max === 'number' && Number.isFinite(max)
      ? Math.max(0, Math.floor(max))
      : MENTION_SUGGESTIONS_MAX
    const own = typeof ownKey === 'string' ? ownKey.toLowerCase() : null
    const prefix = typeof query === 'string' ? query.toLowerCase() : ''
    const ranked = []
    for (const hit of hits) {
      if (hit === null || typeof hit !== 'object' || !validUsername(hit.username)) continue
      if (hit.closed === true || hit.moved === true) continue
      if (own !== null && typeof hit.author === 'string' && hit.author.toLowerCase() === own) continue
      ranked.push(hit)
    }
    // An exact @nome comes first, whoever owns it; then username prefixes,
    // with people before Páginas on that tie; the rest keeps the search order,
    // so a Página the search ranked high is not pushed out by the cap.
    const bucket = (h) => h.username === prefix ? 0 : h.username.startsWith(prefix) ? 1 : 2
    ranked.sort((a, b) => bucket(a) - bucket(b) ||
      (bucket(a) === 1 ? Number(a.page === true) - Number(b.page === true) : 0))
    return ranked.slice(0, limit)
  } catch {
    return []
  }
}
