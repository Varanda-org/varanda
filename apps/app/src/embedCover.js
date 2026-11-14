// The still cover drawn at a music player's size while the player loads.
// Pure: no React, React Native or Node built-ins, so the rules run in node
// tests. The cover never opens a link: a tap on it does nothing, so the
// person cannot reach the provider page before the player is there.

const ROW_MAX_HEIGHT = 200
const ROW_INSET = 24
const STACK_INSET = 24
// Room under the stacked art for the title and the provider name.
const STACK_TEXT = 112

const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0

// How the cover fills a slot `width` by `height`: YouTube's slot is the
// video's own 16:9 frame, so its picture fills it; the other players are
// short rows (art beside the words) or tall stacks (art above them), and the
// art is a square side in whole points.
export function coverLayout (provider, width, height) {
  if (!positive(width) || !positive(height)) return { kind: 'full', art: 0 }
  if (provider === 'youtube') return { kind: 'full', art: 0 }
  if (height <= ROW_MAX_HEIGHT) return { kind: 'row', art: Math.floor(Math.max(0, height - ROW_INSET)) }
  return { kind: 'stack', art: Math.floor(Math.max(0, Math.min(width - STACK_INSET, height - STACK_TEXT))) }
}

// Where the cover's picture comes from, following ./ui/LinkCard.js's choice
// so the cover shows the same picture the stored card would: the composer's
// local URI for a draft, a diary post's descriptor, or a chat card's item.
// Never throws.
export function coverSource (props) {
  try {
    const { draft, imageUri, card, thumb } = props
    if (draft) {
      return typeof imageUri === 'string' && imageUri !== '' ? { kind: 'uri', uri: imageUri } : { kind: 'none' }
    }
    const image = card && typeof card === 'object' ? card.image : null
    if (!image || typeof image !== 'object' || !thumb || typeof thumb !== 'object') return { kind: 'none' }
    if (thumb.kind === 'post' && typeof thumb.author === 'string') {
      return { kind: 'post', author: thumb.author, descriptor: image, persist: thumb.persist !== false }
    }
    if (thumb.kind === 'dm' || thumb.kind === 'group') return { kind: 'chat' }
    return { kind: 'none' }
  } catch {
    return { kind: 'none' }
  }
}

// The cover's accessibility label. `title` is expected already cleaned by
// displayText, as LinkCard does for its own label.
export function coverLabel (name, title) {
  const suffix = typeof title === 'string' && title !== '' ? ': ' + title : ''
  const head = typeof name === 'string' && name !== '' ? 'Player do ' + name + ' carregando' : 'Player carregando'
  return head + suffix
}

export function revealMs (reduceMotion, fast) {
  return reduceMotion ? 0 : fast
}

// Whether the cover stays over a live player that already reported ready,
// until its reveal settles, so the player never shows half drawn.
export function coverLingers (standIn, live, ready, settled) {
  return !standIn && live === true && ready === true && settled !== true
}
