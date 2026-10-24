// iOS/Android: no service worker.
export function startPwa () {
  return Promise.resolve(false)
}
