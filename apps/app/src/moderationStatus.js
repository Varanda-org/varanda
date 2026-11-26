// The moderation list line of Sobre: the date of the signed list this node
// applies (moderation.status, docs/rpc.md 5.177). Pure, for the Node tests.

export const MODERATION_TITLE = 'Moderação'
export const MODERATION_NONE = 'Nenhuma lista de moderação recebida ainda.'

function pad (n) {
  return String(n).padStart(2, '0')
}

// A moderation.status answer -> the line to show, or '' when the answer is
// missing or malformed (the section is then left out, never guessed).
// The day is the device's local calendar day of the list's date.
export function moderationLine (answer) {
  if (answer === null || typeof answer !== 'object') return ''
  if (answer.seq === null && answer.date === null) return MODERATION_NONE
  if (!Number.isSafeInteger(answer.seq) || answer.seq < 1 || typeof answer.date !== 'string') return ''
  const at = new Date(answer.date)
  if (Number.isNaN(at.getTime())) return ''
  return 'Lista de moderação de ' + pad(at.getDate()) + '/' + pad(at.getMonth() + 1) + '/' + at.getFullYear() + '.'
}
