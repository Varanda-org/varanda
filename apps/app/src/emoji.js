// Curated composer emoji and pure UTF-16 selection helpers.
export const EMOJI_GROUPS = [
  {
    label: 'Carinhas',
    emojis: [
      { e: '😀', name: 'sorriso' },
      { e: '😃', name: 'alegria' },
      { e: '😄', name: 'sorriso de olhos fechados' },
      { e: '😁', name: 'sorriso radiante' },
      { e: '😆', name: 'gargalhada' },
      { e: '😅', name: 'sorriso com suor' },
      { e: '😂', name: 'chorando de rir' },
      { e: '🤣', name: 'rolando de rir' },
      { e: '😊', name: 'sorriso tímido' },
      { e: '😉', name: 'piscadinha' },
      { e: '😍', name: 'apaixonado' },
      { e: '🥰', name: 'rosto com corações' },
      { e: '😘', name: 'mandando beijo' },
      { e: '😎', name: 'óculos de sol' },
      { e: '🤔', name: 'pensativo' },
      { e: '🥺', name: 'olhar de pedido' },
      { e: '😢', name: 'triste' },
      { e: '😭', name: 'chorando' },
      { e: '😴', name: 'dormindo' },
      { e: '🤩', name: 'encantado' }
    ]
  },
  {
    label: 'Gestos',
    emojis: [
      { e: '👍', name: 'positivo' },
      { e: '👎', name: 'negativo' },
      { e: '👏', name: 'palmas' },
      { e: '🙌', name: 'mãos para o alto' },
      { e: '🙏', name: 'gratidão' },
      { e: '👋', name: 'aceno' },
      { e: '🤝', name: 'aperto de mãos' },
      { e: '💪', name: 'força' },
      { e: '🤞', name: 'dedos cruzados' },
      { e: '✌️', name: 'paz e vitória' },
      { e: '🤟', name: 'eu te amo' },
      { e: '🤙', name: 'me liga' },
      { e: '👌', name: 'tudo certo' },
      { e: '🤌', name: 'dedos juntos' },
      { e: '👊', name: 'soquinho' },
      { e: '✊', name: 'punho erguido' },
      { e: '🫶', name: 'mãos em coração' },
      { e: '👀', name: 'de olho' },
      { e: '🫂', name: 'abraço' },
      { e: '💅', name: 'unhas pintadas' }
    ]
  },
  {
    label: 'Corações e festa',
    emojis: [
      { e: '❤️', name: 'coração vermelho' },
      { e: '🧡', name: 'coração laranja' },
      { e: '💛', name: 'coração amarelo' },
      { e: '💚', name: 'coração verde' },
      { e: '💙', name: 'coração azul' },
      { e: '💜', name: 'coração roxo' },
      { e: '🖤', name: 'coração preto' },
      { e: '🤍', name: 'coração branco' },
      { e: '🤎', name: 'coração marrom' },
      { e: '💔', name: 'coração partido' },
      { e: '💕', name: 'dois corações' },
      { e: '💖', name: 'coração brilhante' },
      { e: '🎉', name: 'festa' },
      { e: '🎊', name: 'confete' },
      { e: '🎈', name: 'balão' },
      { e: '🎂', name: 'bolo de aniversário' },
      { e: '🎁', name: 'presente' },
      { e: '🥳', name: 'comemorando' },
      { e: '✨', name: 'brilhos' },
      { e: '🎆', name: 'fogos de artifício' }
    ]
  },
  {
    label: 'Natureza e bichos',
    emojis: [
      { e: '🌴', name: 'palmeira' },
      { e: '🌳', name: 'árvore' },
      { e: '🌱', name: 'broto' },
      { e: '🌿', name: 'folhagem' },
      { e: '🌻', name: 'girassol' },
      { e: '🌺', name: 'hibisco' },
      { e: '🌹', name: 'rosa' },
      { e: '☀️', name: 'sol' },
      { e: '🌙', name: 'lua' },
      { e: '⭐', name: 'estrela' },
      { e: '🌈', name: 'arco-íris' },
      { e: '🌧️', name: 'chuva' },
      { e: '🌊', name: 'onda' },
      { e: '🔥', name: 'fogo' },
      { e: '🐶', name: 'cachorro' },
      { e: '🐱', name: 'gato' },
      { e: '🦋', name: 'borboleta' },
      { e: '🐦', name: 'pássaro' },
      { e: '🐢', name: 'tartaruga' },
      { e: '🐝', name: 'abelha' }
    ]
  },
  {
    label: 'Comidas e bebidas',
    emojis: [
      { e: '☕', name: 'café' },
      { e: '🧉', name: 'chimarrão' },
      { e: '🥥', name: 'coco' },
      { e: '🍍', name: 'abacaxi' },
      { e: '🥭', name: 'manga' },
      { e: '🍌', name: 'banana' },
      { e: '🍉', name: 'melancia' },
      { e: '🍓', name: 'morango' },
      { e: '🍊', name: 'laranja' },
      { e: '🍋', name: 'limão' },
      { e: '🍞', name: 'pão' },
      { e: '🧀', name: 'queijo' },
      { e: '🍕', name: 'pizza' },
      { e: '🍔', name: 'hambúrguer' },
      { e: '🍿', name: 'pipoca' },
      { e: '🍫', name: 'chocolate' },
      { e: '🍦', name: 'sorvete' },
      { e: '🍻', name: 'brinde com cerveja' },
      { e: '🥤', name: 'bebida com canudo' },
      { e: '🍽️', name: 'prato e talheres' }
    ]
  },
  {
    label: 'Brasil e cotidiano',
    emojis: [
      { e: '🇧🇷', name: 'Brasil' },
      { e: '⚽', name: 'futebol' },
      { e: '🏆', name: 'troféu' },
      { e: '🏖️', name: 'praia' },
      { e: '🏡', name: 'casa com jardim' },
      { e: '🎶', name: 'música' },
      { e: '🎸', name: 'guitarra' },
      { e: '🥁', name: 'tambor' },
      { e: '💃', name: 'dançarina' },
      { e: '🕺', name: 'dançarino' },
      { e: '📚', name: 'livros' },
      { e: '💡', name: 'ideia' },
      { e: '📷', name: 'câmera' },
      { e: '🎨', name: 'arte' },
      { e: '🚲', name: 'bicicleta' },
      { e: '🚌', name: 'ônibus' },
      { e: '✈️', name: 'avião' },
      { e: '✅', name: 'confirmado' },
      { e: '💬', name: 'conversa' },
      { e: '🚀', name: 'foguete' }
    ]
  }
]

export const EMOJI = EMOJI_GROUPS.flatMap(group => group.emojis)

// A collapsed caret inside a pair moves right. Ranges expand to whole pairs.
export function insertAt (text, selection, insert) {
  const clamp = n => typeof n !== 'number' || Number.isNaN(n)
    ? text.length
    : Math.max(0, Math.min(text.length, Math.trunc(n)))
  let start = clamp(selection?.start)
  let end = clamp(selection?.end ?? selection?.start)
  if (start > end) [start, end] = [end, start]
  const insidePair = i => i > 0 && i < text.length &&
    text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff &&
    text.charCodeAt(i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff
  if (start === end) {
    if (insidePair(start)) start = end = start + 1
  } else {
    if (insidePair(start)) start--
    if (insidePair(end)) end++
  }
  const caret = start + insert.length
  return {
    text: text.slice(0, start) + insert + text.slice(end),
    selection: { start: caret, end: caret }
  }
}

// Counts Unicode code points, including each code point in joined emoji.
export function countAfterInsert (text, insert, max = 1000) {
  const count = Array.from(text + insert).length
  return { count, allowed: count <= max }
}
