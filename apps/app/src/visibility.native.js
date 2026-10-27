// The worklet already suspends the node in the background.
export function isVisible () {
  return true
}

export function subscribeVisible () {
  return () => {}
}
