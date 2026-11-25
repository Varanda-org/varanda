// The member's own mute list on screen: the texts and the pure rules. The node
// is what enforces a mute (docs/rpc.md 5.177): it leaves a muted person out of
// A Rua and Avisos, and these rules only clear what is already on screen there.
// A mute hides nothing anywhere else: the profile, threads, Conversas and
// groups show the person as before.
// No imports and no globals, so the Node tests load it directly.

const HEX64 = /^[0-9a-f]{64}$/

export const MUTE_TEXTS = Object.freeze({
  mute: 'Silenciar',
  unmute: 'Deixar de silenciar',
  done: 'Pessoa silenciada. Desfaça em Ajustes.',
  undone: 'Pessoa não está mais silenciada.',
  failed: 'Não foi possível mudar. Tente de novo.',
  listTitle: 'Pessoas silenciadas',
  listNote: 'Pessoas que você silenciou.',
  emptyTitle: 'Ninguém silenciado',
  emptyBody: 'Para silenciar alguém, use o menu de uma publicação ou o perfil da pessoa.',
  unnamed: 'Alguém sem nome'
})

// The (i) text of the list: what a mute does and does not do.
export const MUTE_HELP = Object.freeze({
  title: 'Como funciona silenciar',
  paragraphs: Object.freeze([
    'Silenciar esconde as publicações, as republicações, os momentos e os avisos da pessoa em A Rua e em Avisos.',
    'Você continua seguindo a pessoa, as mensagens continuam chegando e o perfil dela mostra tudo como antes.',
    'A pessoa não é avisada. A lista vale em todos os seus aparelhos com a mesma passkey.'
  ])
})

// The Set of a mute.list answer. Anything that is not a key is left out.
export function mutedSetOf (answer) {
  const keys = answer && Array.isArray(answer.keys) ? answer.keys : []
  return new Set(keys.filter((key) => typeof key === 'string' && HEX64.test(key)))
}

function lower (key) {
  return typeof key === 'string' ? key.toLowerCase() : null
}

// The keys A Rua's comment fold treats as hidden (feedFold.js `blocked`):
// blocked and muted, so no card shows a muted author's post as its root when
// someone else comments on it. The blocked Set itself when nobody is muted.
export function hiddenInFold (blocked, muted) {
  if (!(muted instanceof Set) || muted.size === 0) return blocked
  return new Set([...(blocked instanceof Set ? blocked : []), ...muted])
}

// A Rua's rows without a muted author's posts and reposts of a muted author's
// post (`to` is the reposted post). The same array when nothing goes, so the
// list keeps its data identity.
export function withoutMutedRows (items, has) {
  if (!Array.isArray(items)) return items
  const kept = items.filter((item) => {
    if (!item || typeof item !== 'object') return true
    if (has(lower(item.author))) return false
    if (item.kind === 'repost' && item.to && has(lower(item.to.author))) return false
    return true
  })
  return kept.length === items.length ? items : kept
}
