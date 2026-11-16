// One registry per app process, so every screen reads the same once marks
// without a prop chain. Memory only: the shell names the member whose marks
// sync (its seen member, null otherwise) and moves tokens through the seen
// pass.
import { createOnceRegistry } from './onceMarks.js'

const HEX64 = /^[0-9a-f]{64}$/

export const onceRegistry = createOnceRegistry()

let syncing = null

export function setOnceMember (member) {
  syncing = typeof member === 'string' && HEX64.test(member) ? member : null
}

export function onceMember () {
  return syncing
}

// A member's marks count only while its own seen document syncs here.
export function onceMemberFor (syncingMember, member) {
  if (typeof syncingMember !== 'string' || !HEX64.test(syncingMember) || typeof member !== 'string') return null
  return member.toLowerCase() === syncingMember ? syncingMember : null
}

// The answer of seen.onceKey, or null: anything else (an older node, the
// vitrine, a malformed reply) leaves the marks of that member off.
export function onceKeyOf (answer) {
  const key = answer && typeof answer === 'object' ? answer.key : null
  return typeof key === 'string' && HEX64.test(key) ? key : null
}

// The invite monitor waits for the first seen pass of a member and for its
// once key (each answered or failed), or for the timer, so a mark written by
// another device is known before its first poll.
export const FIRST_PASS_MS = 4000

export const FIRST_PASS_IDLE = Object.freeze({ member: null, pass: false, key: false, settled: false })

export function firstPassStep (state, event) {
  const cur = state && typeof state === 'object' ? state : FIRST_PASS_IDLE
  if (!event || typeof event !== 'object') return cur
  const member = typeof event.member === 'string' && HEX64.test(event.member) ? event.member : null
  if (event.type === 'member') return cur.member === member ? cur : { member, pass: false, key: false, settled: false }
  if (event.type !== 'pass' && event.type !== 'key' && event.type !== 'timeout') return cur
  if (member === null || cur.member !== member || cur.settled) return cur
  const pass = cur.pass || event.type === 'pass'
  const key = cur.key || event.type === 'key'
  return { member, pass, key, settled: event.type === 'timeout' || (pass && key) }
}

export function firstPassReady (state, member) {
  return !!state && typeof member === 'string' && state.member === member && state.settled === true
}

// Without a syncing member nothing waits, exactly as before the marks.
export function inviteWaitsForSeen (state, syncingMember) {
  return typeof syncingMember === 'string' && !firstPassReady(state, syncingMember)
}
