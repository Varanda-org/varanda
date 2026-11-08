// The member's own block list on screen: the texts and the pure rules. The node
// is what enforces a block (docs/rpc.md 5.111): these rules only clear what is
// already on screen, so a row goes at once instead of on the next read.
// No imports and no globals, so the Node tests load it directly.

const HEX64 = /^[0-9a-f]{64}$/

export const BLOCK_TEXTS = Object.freeze({
  block: 'Bloquear',
  unblock: 'Desbloquear',
  cancel: 'Cancelar',
  confirmNote: 'Você deixa de ver as publicações, as respostas e os avisos dessa pessoa, e as mensagens dela não chegam mais. Você também deixa de seguir essa pessoa. Ela não é avisada. Como os diários são públicos, ela ainda pode ver o que você publica.',
  done: 'Pessoa bloqueada. Desfaça em Ajustes.',
  undone: 'Pessoa desbloqueada.',
  profileTitle: 'Você bloqueou esta pessoa',
  profileBody: 'As publicações dela não aparecem para você. Ela não foi avisada.',
  listTitle: 'Pessoas bloqueadas',
  listNote: 'Você não vê as publicações, as respostas nem os avisos dessas pessoas, e as mensagens delas não chegam. Elas não são avisadas.',
  emptyTitle: 'Ninguém bloqueado',
  emptyBody: 'Para bloquear alguém, use o menu de uma publicação ou o perfil da pessoa.',
  unnamed: 'Alguém sem nome'
})

export function confirmTitle (name) {
  return typeof name === 'string' && name !== '' ? 'Bloquear ' + name + '?' : 'Bloquear esta pessoa?'
}

// The Set of a block.list answer. Anything that is not a key is left out.
export function blockedSetOf (answer) {
  const keys = answer && Array.isArray(answer.keys) ? answer.keys : []
  return new Set(keys.filter((key) => typeof key === 'string' && HEX64.test(key)))
}

// What a PostRow draws: null for a post by a blocked author or a repost by one,
// else the row's quote, which reads as unavailable when its author is blocked.
export function blockedRowView ({ author, repostedBy, quote }, has) {
  if (has(author)) return null
  if (repostedBy && has(repostedBy.author)) return null
  if (!quote || !has(quote.author)) return { quote }
  return { quote: { author: quote.author, name: null, username: null, avatar: null, at: null, text: null, media: null, preview: null, persist: false, missing: true, onOpen: quote.onOpen } }
}

// Rows that carry the person in `key`: notices, followers and following. The
// same array when nothing goes, so the list keeps its data identity.
export function withoutBlockedKeys (items, has) {
  const kept = items.filter((item) => !item || typeof item.key !== 'string' || !has(item.key))
  return kept.length === items.length ? items : kept
}

// 'author:seq' refs of who liked or reposted, left out before they are checked,
// so a like by a blocked person does not read as someone not yet confirmed.
export function withoutBlockedRefs (refs, has) {
  const kept = refs.filter((ref) => typeof ref !== 'string' || !has(ref.split(':')[0]))
  return kept.length === refs.length ? refs : kept
}

function validSeq (seq) {
  return Number.isSafeInteger(seq) && seq >= 1
}

// The diary.peek params that read a blocked person's name and @nome from the
// index's hints, or null when the index knows neither block.
export function blockedPeekParams (key, hints) {
  const profileSeq = hints && validSeq(hints.profileSeq) ? hints.profileSeq : null
  const usernameSeq = hints && validSeq(hints.usernameSeq) ? hints.usernameSeq : null
  if (profileSeq === null && usernameSeq === null) return null
  const seqs = [...new Set([profileSeq, usernameSeq].filter((seq) => seq !== null))].sort((a, b) => a - b)
  const params = { author: key, seqs, profileOnly: true }
  if (profileSeq !== null) params.profileSeq = profileSeq
  if (usernameSeq !== null) params.usernameSeq = usernameSeq
  return params
}
