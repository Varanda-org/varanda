// Sorte do dia: one bundled line per day, chosen on the device from the local
// date and a random per-device salt. No network, no account data.
export const SORTES = Object.freeze([
  'Hoje, uma conversa simples vai valer mais do que parecia.',
  'Alguém perto de você está esperando uma mensagem sua.',
  'O café de hoje vai estar na temperatura certa.',
  'Um pequeno passo feito agora poupa uma corrida amanhã.',
  'Uma boa notícia vem pelo caminho mais comprido.',
  'Quem você lembrar hoje também vai lembrar de você.',
  'Respire fundo: o que parecia grande vai caber no dia.',
  'Uma ideia antiga vai ganhar força de repente.',
  'Hoje é dia de dizer obrigado a quem nunca ouviu.',
  'A resposta que você procura está numa conversa de vizinho.',
  'O que você plantou com calma começa a dar sombra.',
  'Um convite inesperado merece um sim.',
  'Hoje o relógio vai estar do seu lado.',
  'Uma lembrança boa volta na hora certa.',
  'Seu jeito de fazer as coisas inspira alguém em silêncio.',
  'Não precisa resolver tudo: resolva o próximo passo.',
  'A sorte de hoje mora numa porta que você ainda não abriu.',
  'Uma risada sincera vai desfazer um nó do dia.',
  'Cuide do que é seu com carinho e o resto se ajeita.',
  'Hoje você vai ouvir uma frase que merece ser guardada.',
  'O que ficou pela metade pede só mais um empurrãozinho.',
  'Uma pessoa querida vai aparecer sem avisar.',
  'Seja gentil com quem está cansado: pode ser você.',
  'A tarde guarda uma surpresa pequena e boa.',
  'Um não de hoje abre espaço para um sim melhor.',
  'Confie no seu primeiro instinto em algo simples.',
  'Hoje vale mais ouvir do que explicar.',
  'Uma música antiga vai tocar na hora certa.',
  'O que você deu sem esperar volta em forma de alegria.',
  'Um gesto de cuidado seu vai ser lembrado por muito tempo.',
  'Há luz no fim do dia, e ela é sua.',
  'Hoje é um bom dia para recomeçar uma coisa pequena.',
  'A paciência vai render mais do que a pressa.',
  'Alguém vai elogiar o que você fez sem você perceber.',
  'Uma pausa na hora certa muda o resto do dia.',
  'O melhor da semana começa por uma conversa de hoje.',
  'Sua curiosidade vai levar você a um bom lugar.',
  'Compartilhe o que sabe: alguém precisava justamente disso.',
  'O vento está a favor de quem começa devagar.',
  'Hoje o simples vai ser suficiente, e isso é bom.',
  'Uma mesa cheia de gente querida está mais perto do que parece.',
  'Quem escuta com calma costuma achar o caminho mais curto.',
  'Uma lista curta hoje vale mais que uma lista longa amanhã.',
  'Quem sorri primeiro costuma ganhar o dia.',
  'Hoje a coragem cabe num gesto pequeno.',
  'Um velho amigo vai lembrar de você de repente.',
  'O que parecia atraso era só o tempo certo chegando.',
  'Abra a janela: o dia tem mais cor do que parece lá de dentro.',
  'Um pedido de ajuda hoje vira uma amizade amanhã.',
  'Você tem mais jeito para isso do que imagina.',
  'Uma pequena alegria vai chegar disfarçada de rotina.',
  'Hoje o que for dito com carinho será bem recebido.',
  'Faça uma coisa só, e faça bem: o resto espera.',
  'Uma boa lembrança de infância vai trazer um sorriso.',
  'O dia vai ficar mais leve depois do almoço.',
  'Alguém vai agradecer por algo que você já esqueceu.',
  'Ande um pouco: a ideia boa vem no caminho.',
  'Sua história de hoje merece ser contada a alguém.',
  'Uma porta que parecia fechada está só encostada.',
  'Hoje, quem planta uma palavra boa colhe duas.',
  'Seja o primeiro a cumprimentar: o dia agradece.',
  'Um detalhe bonito do dia vai passar despercebido, a não ser que você olhe.',
  'A sorte de hoje é a de quem acredita no próximo.'
])

// The salt is generated once per device and kept by the store.
export function newSalt () {
  const bytes = new Uint8Array(8)
  try {
    globalThis.crypto.getRandomValues(bytes)
  } catch {
    // Not secret (it only spreads the lines across devices), so Math.random is fine.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function isSalt (value) {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)
}

// 'YYYY-MM-DD' on the device's own calendar.
export function dateKey (date) {
  const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date(0)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// FNV-1a, 32 bits: stable across runtimes (no Math.random, no Date inside).
function hash (text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function sorteIndex (key, salt) {
  return hash(`${salt}|${key}`) % SORTES.length
}

export function sorteDoDia (date, salt) {
  return SORTES[sorteIndex(dateKey(date), isSalt(salt) ? salt : '')]
}
