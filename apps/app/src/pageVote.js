// A Page's own pick in a group poll or event, from a group.voters answer
// ({ voters: [{ pick, by: [diary key] }] }). The node's `poll.mine` and
// `event.mine` are the member's: while acting as a Page they are never shown.
// -> the option index the page's key sits under, null when it sits under none,
// undefined when the answer cannot tell (not an answer, a bad page key, a
// bad list, or a missing key on an option whose list is cut), so the caller shows no pick and writes nothing from it.

const HEX64 = /^[0-9a-f]{64}$/

export function pagePickOf (answer, pageKey, count) {
  if (typeof pageKey !== 'string' || !HEX64.test(pageKey)) return undefined
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.voters)) return undefined
  let pick = null
  let cut = false
  for (const v of answer.voters) {
    if (!v || typeof v !== 'object' || !Number.isSafeInteger(v.pick) || v.pick < 0 || !Array.isArray(v.by)) return undefined
    if (Number.isSafeInteger(count) && v.pick >= count) continue
    // The service lists at most a bounded number of keys per option: a key
    // missing from a cut list may still be among the voters.
    if (Number.isSafeInteger(v.count) && v.count > v.by.length) cut = true
    if (v.by.includes(pageKey)) {
      // Two options for one key is a fold that cannot be trusted.
      if (pick !== null) return undefined
      pick = v.pick
    }
  }
  return pick === null && cut ? undefined : pick
}
