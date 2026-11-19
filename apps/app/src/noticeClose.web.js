import { CLOSE_MAX, validTag } from './noticeTags.js'

export async function closeNotices (tags) {
  const close = Array.isArray(tags) ? [...new Set(tags.filter(validTag))].slice(0, CLOSE_MAX) : []
  if (close.length === 0) return
  try {
    const registration = await globalThis.navigator?.serviceWorker?.getRegistration()
    registration?.active?.postMessage({ type: 'varanda-notices-close', tags: close })
  } catch {}
}

export function subscribeSeenSync (wake) {
  const worker = globalThis.navigator?.serviceWorker
  const receive = ({ data }) => {
    if (data && !Array.isArray(data) && Object.keys(data).length === 1 && data.type === 'varanda-seen-sync') wake('remote')
  }
  try {
    worker?.addEventListener('message', receive)
    return () => { worker?.removeEventListener('message', receive) }
  } catch {
    return () => {}
  }
}
