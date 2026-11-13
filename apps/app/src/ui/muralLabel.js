// The spoken label of a Mural tile. Pure (no React, no react-native), so
// test/muralGrid.test.js calls it in Node; MuralGrid.js re-exports it.

import { relativeTime } from '../format.js'
import { videoPair } from '../media/plan.js'

export function tileLabel (tile, now) {
  const media = tile && Array.isArray(tile.media) ? tile.media : []
  const n = media.length
  const when = relativeTime(tile && tile.at, now)
  // The pair is one poster plus the clip, not several photos.
  const kind = videoPair(media) ? 'vídeo' : (n > 1 ? n + ' fotos' : 'foto')
  return kind + (when ? ', ' + when : '')
}
