// Which momento photo A Rua reads ahead while idle: the one the person is
// most likely to tap next. Pure: no React, no react-native, no Node built-ins.

import { momentRefOf } from './moments.js'

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function isSeen (seen, ref) {
  if (typeof ref !== 'string' || ref === '') return false
  if (seen instanceof Set) return seen.has(ref)
  if (Array.isArray(seen)) return seen.includes(ref)
  return false
}

// rings: viewerRings() output. The first ring that is not the own one and
// whose start item is unseen (a fully seen ring starts at 0, a seen item).
// A video there ends the search: only the most likely tap is warmed.
export function stripWarmRef (rings, ownKey, seen) {
  if (!Array.isArray(rings)) return null
  for (const ring of rings) {
    if (!isObject(ring) || typeof ring.author !== 'string' || ring.author === ownKey) continue
    const items = Array.isArray(ring.items) ? ring.items : []
    const item = items[ring.start]
    if (!isObject(item) || isSeen(seen, item.ref)) continue
    if (isObject(item.media) && item.media.mime === 'video/mp4') return null
    return momentRefOf(ring.author, item)
  }
  return null
}
