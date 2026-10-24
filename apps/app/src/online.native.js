// iOS/Android: the node reaches the seeder on its own; nothing to observe.
export function isOnline () {
  return true
}

export function subscribeOnline () {
  return () => {}
}
