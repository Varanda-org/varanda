// The stack's one-transition-at-a-time lock, owned by a token. Pure: the
// clock comes in as an argument, so the tests drive time and this module
// loads without React.
//
// Every slide, drag or pending pop acquires its own token, which replaces
// whatever held the lock before. Only the current token releases it: the
// completion of an older animation (one that a newer push or pop overtook)
// carries a stale token and changes nothing. The deadline frees the stack
// even when a holder never reports its end (a remount mid-slide, a dropped
// callback).

export function createStackLock () {
  let seq = 0
  let owner = 0
  let until = 0
  const holds = (now) => owner !== 0 && Number.isFinite(now) && now < until
  return {
    // A token for a hold of ms from now. A hold of 0 (or less) is issued but
    // never busy, and it still supersedes the previous holder.
    acquire (now, ms) {
      seq += 1
      owner = seq
      const span = Number.isFinite(ms) && ms > 0 ? ms : 0
      until = Number.isFinite(now) ? now + span : 0
      return seq
    },
    // True when token was the holder and the lock is now free.
    release (token) {
      if (!Number.isInteger(token) || token <= 0 || token !== owner) return false
      owner = 0
      until = 0
      return true
    },
    busy (now) {
      return holds(now)
    },
    // The token that holds the lock now, or 0.
    holder (now) {
      return holds(now) ? owner : 0
    }
  }
}
