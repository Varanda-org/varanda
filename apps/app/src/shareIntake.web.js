import { MAX_MEDIA_PER_POST } from './media/plan.js'

const ID = /^[0-9]{13}-[0-9a-f]{32}$/
const IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
// The worker may write three 4000 character fields, each JSON-escaped.
const MAX_META_CHARS = 1048576
const MAX_FILE_BYTES = 50 * 1024 * 1024

function validId (id) {
  return typeof id === 'string' && id.length === 46 && ID.test(id)
}

function shareKey (key) {
  try {
    const url = new URL(key.url)
    const parts = url.pathname.split('/')
    if (url.search || url.hash || parts.length !== 4 || parts[1] !== '__varanda-share' || !validId(parts[2]) || !parts[3]) return null
    return { id: parts[2], name: parts[3], base: url.origin + '/__varanda-share/' + parts[2] + '/' }
  } catch {
    return null
  }
}

export async function peek () {
  try {
    if (!globalThis.caches) return null
    const cache = await globalThis.caches.open('varanda-share')
    const metas = (await cache.keys())
      .map(shareKey)
      .filter((key) => key && key.name === 'meta')
      .sort((a, b) => b.id.localeCompare(a.id))
    for (const key of metas) {
      try {
        const response = await cache.match(key.base + 'meta')
        if (!response) continue
        const text = await response.text()
        if (text.length > MAX_META_CHARS) continue
        const meta = JSON.parse(text)
        if (!meta || meta.v !== 1 || meta.id !== key.id || meta.at !== Number(key.id.slice(0, 13)) || !Array.isArray(meta.files)) continue
        const files = []
        const seen = new Set()
        for (const file of meta.files.slice(0, MAX_MEDIA_PER_POST)) {
          try {
            if (!file || !Number.isSafeInteger(file.n) || file.n < 0 || !IMAGES.has(file.mime) || seen.has(file.n)) continue
            seen.add(file.n)
            const entry = await cache.match(key.base + file.n)
            if (!entry) continue
            const blob = await entry.blob()
            if (blob.size === 0 || blob.size > MAX_FILE_BYTES) continue
            files.push(new File([blob], 'foto-' + file.n, { type: file.mime }))
          } catch {
            // A read that failed may work on the next peek: offered without
            // its photos, the share would be released as empty. One that never
            // reads goes with the sweep.
            return null
          }
        }
        return {
          id: meta.id,
          at: meta.at,
          title: typeof meta.title === 'string' ? meta.title : '',
          text: typeof meta.text === 'string' ? meta.text : '',
          url: typeof meta.url === 'string' ? meta.url : '',
          total: Number.isSafeInteger(meta.total) && meta.total >= 0 ? meta.total : 0,
          files
        }
      } catch {}
    }
  } catch {}
  return null
}

async function removeShares (matches) {
  try {
    if (!globalThis.caches) return
    const cache = await globalThis.caches.open('varanda-share')
    const shares = new Map()
    for (const key of await cache.keys()) {
      const share = shareKey(key)
      if (!share || !matches(share.id)) continue
      if (!shares.has(share.base)) shares.set(share.base, { meta: share.base + 'meta', bodies: [] })
      const pending = shares.get(share.base)
      if (share.name === 'meta') pending.meta = key
      else pending.bodies.push(key)
    }
    for (const { meta, bodies } of shares.values()) {
      // Hide the share before deleting bodies so an interrupted cleanup cannot offer it partially.
      try { await cache.delete(meta) } catch { continue }
      for (const key of bodies) {
        try { await cache.delete(key) } catch {}
      }
    }
  } catch {}
}

export async function release (id) {
  if (validId(id)) await removeShares((other) => other === id)
}

// Sair and Recomeçar: a share stored by any open page, read or not, goes with
// the account. Through removeShares, so meta still goes first.
export async function clear () {
  await removeShares(() => true)
}

export async function sweep (maxAgeMs) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) return
  const cutoff = Date.now() - maxAgeMs
  await removeShares((id) => Number(id.slice(0, 13)) < cutoff)
}

// A share target opens a fresh page, so the mount peek is enough.
export function listen () {
  return function () {}
}
