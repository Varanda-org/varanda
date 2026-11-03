// iOS/Android: no stored entry record. Native has no page load, its Google
// step runs in an auth session without a reload, and its links arrive
// through Linking into App.js state. No imports: the tests load this module
// with import().

export function captureEntryLink () {
  return null
}

export function dropEntryLink () {
  return false
}
