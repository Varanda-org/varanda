import { fetchPersist, loadKept, persistMode } from './keptLoad.js'

// Capture the generation before the cache queues the load, just as useMedia
// does. The store and transport stay injected so both platforms share this.
export function prefetchLoad ({ keptUrl, keptBytes, keep, generation, fetchMedia, urlFromBytes, thumbBytesOk, mediaHashDeps, mediaFetch }) {
  return (author, d, policy = false) => {
    const persist = persistMode(policy)
    const requestedGeneration = generation()
    return signal => loadKept({
      kind: 'posts',
      author,
      d,
      persist,
      keptUrl,
      keptBytes,
      keep,
      fetchBytes: d => fetchMedia(author, d, { ...mediaHashDeps(), persist: fetchPersist(persist, author), fetch: mediaFetch(), signal }),
      urlFromBytes,
      generation,
      requestedGeneration,
      validate: thumbBytesOk
    })
  }
}
