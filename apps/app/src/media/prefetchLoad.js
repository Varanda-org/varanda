import { loadKept } from './keptLoad.js'

// Capture the generation before the cache queues the load, just as useMedia
// does. The store and transport stay injected so both platforms share this.
export function prefetchLoad ({ keptUrl, keptBytes, keep, generation, fetchMedia, urlFromBytes, thumbBytesOk, mediaHashDeps, mediaFetch }) {
  return (author, d, persist = false) => {
    const requestedGeneration = generation()
    return signal => loadKept({
      kind: 'posts',
      author,
      d,
      persist,
      keptUrl,
      keptBytes,
      keep,
      fetchBytes: d => fetchMedia(author, d, { ...mediaHashDeps(), persist: persist === 'peek' ? false : persist, fetch: mediaFetch(), signal }),
      urlFromBytes,
      generation,
      requestedGeneration,
      validate: thumbBytesOk
    })
  }
}
