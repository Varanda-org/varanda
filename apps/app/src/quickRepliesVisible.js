// The Feira quick replies stack 3 to 4 buttons above the composer. With the
// keyboard open they leave no room for any message (#917), so they hide.
export function quickRepliesVisible (eligible, keyboardOpen) {
  return eligible === true && keyboardOpen !== true
}
