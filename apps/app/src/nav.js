// Pure screen stack for the screens that open above the tabs: 'conversa'
// (a post and its replies, keyed by the post ref '<author hex64>:<seq>') and
// 'membro' (a member's profile, keyed by the lowercase hex64 key). The stack
// is an immutable (frozen) array, oldest first. Invalid entries are refused
// by returning the stack unchanged (never throws); pushing the screen that is
// already on top is a no-op; past MAX_DEPTH the oldest entry is dropped.

export const MAX_DEPTH = 20
export const SCREENS = Object.freeze(['conversa', 'membro'])

const HEX64 = /^[0-9a-f]{64}$/
const REF = /^([0-9a-f]{64}):([1-9][0-9]*)$/

export const EMPTY = Object.freeze([])

// A canonical lowercase ref with seq >= 1 (records.js formatRef output).
export function isRef (s) {
  if (typeof s !== 'string') return false
  const m = REF.exec(s)
  if (!m) return false
  const seq = Number(m[2])
  return Number.isSafeInteger(seq) && String(seq) === m[2]
}

export function isAuthorKey (s) {
  return typeof s === 'string' && HEX64.test(s)
}

export function validEntry (entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.screen === 'conversa') return isRef(entry.key)
  if (entry.screen === 'membro') return isAuthorKey(entry.key)
  return false
}

function copyEntry (entry) {
  const params = entry.params && typeof entry.params === 'object' ? { ...entry.params } : {}
  return Object.freeze({ screen: entry.screen, key: entry.key, params: Object.freeze(params) })
}

export function top (stack) {
  return Array.isArray(stack) && stack.length > 0 ? stack[stack.length - 1] : null
}

export function depth (stack) {
  return Array.isArray(stack) ? stack.length : 0
}

export function push (stack, entry) {
  const base = Array.isArray(stack) ? stack : EMPTY
  if (!validEntry(entry)) return base
  const current = top(base)
  if (current && current.screen === entry.screen && current.key === entry.key) return base
  const next = base.concat([copyEntry(entry)])
  return Object.freeze(next.length > MAX_DEPTH ? next.slice(next.length - MAX_DEPTH) : next)
}

export function pop (stack) {
  if (!Array.isArray(stack) || stack.length <= 1) return EMPTY
  return Object.freeze(stack.slice(0, -1))
}

export function reset () {
  return EMPTY
}
