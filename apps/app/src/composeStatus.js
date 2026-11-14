// One composer note, as an id. The screen keeps the sentence for it.
// An uncertain outcome counts as an error: a write may already have landed,
// so that note stays even when a quieter one also applies.

export function composeStatus (flags) {
  if (flags === null || typeof flags !== 'object') return null
  if (flags.error || flags.uncertain) return 'error'
  if (flags.locked) return 'locked'
  if (flags.media) return 'media'
  if (flags.draft) return 'draft'
  return null
}
