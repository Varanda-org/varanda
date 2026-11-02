export function uploadDeps () {
  // A wrapper, so the call never depends on the receiver fetch is invoked with.
  return { fetch: (url, init) => globalThis.fetch(url, init) }
}
