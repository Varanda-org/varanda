// The first byte varies so avatar colours (first byte mod 5) vary as on a
// real network; the rest still encodes n, so keys stay unique.
const key = (n) => (n % 256).toString(16).padStart(2, '0') + n.toString(16).padStart(62, '0')
const id = (n) => n.toString(16).padStart(32, '0')
const at = (day, hour, minute = 0) => `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`

export const now = at(5, 15)

// Chat photos. Picture p is one of the tiny drawings of ./pictures.js: an
// item names it through its sha256 (key(PICTURE_BASE + p)), which the
// Vitrine's media handle reads back (./media.js). Declared sizes are the
// size a phone photo would have; the drawn pixels are far fewer.
export const PICTURE_BASE = 700
const PICTURE_BYTES = [1405, 1291, 1391, 1605]
const PICTURE_SIZE = [[1280, 960], [768, 1024], [1024, 1024], [1344, 896]]
const dmPhoto = (n, p) => ({ id: key(710 + n), key: key(720 + n), nonce: '0'.repeat(46) + (n % 100).toString().padStart(2, '0'), chunks: 1, bytes: PICTURE_BYTES[p] + 16, sha256: key(PICTURE_BASE + p), mime: 'image/jpeg', w: PICTURE_SIZE[p][0], h: PICTURE_SIZE[p][1], ms: 0 })
const publicPhoto = (n, p) => ({ core: key(730), mime: 'image/jpeg', start: 1 + n, blocks: 1, bytes: PICTURE_BYTES[p], sha256: key(PICTURE_BASE + p), width: PICTURE_SIZE[p][0], height: PICTURE_SIZE[p][1] })
const privatePhoto = (n, p) => ({ core: key(740), mime: 'application/octet-stream', start: 1 + n, blocks: 1, bytes: 32768, sha256: key(750 + n), key: key(760 + n), nonce: '0'.repeat(46) + (n % 100).toString().padStart(2, '0'), plainMime: 'image/jpeg', plainSha256: key(PICTURE_BASE + p), w: PICTURE_SIZE[p][0], h: PICTURE_SIZE[p][1], ms: 0 })

export const members = [
  ['Lia Oliveira', 'lia_oliveira', 'Café, livros e encontros na praça.'],
  ['João Nascimento', 'joao_nascimento', 'Pedalando pelo bairro.'],
  ['Cecília Ramos', 'cecilia_ramos', 'Cultivo plantas e boas conversas.'],
  ['André Costa', 'andre_costa', 'Fotografia e memória da cidade.'],
  ['Bia Araújo', 'bia_araujo', 'Sempre com um livro por perto.'],
  ['Tomás Ferreira', 'tomas_ferreira', 'Música para compartilhar.']
].map(([name, username, bio], i) => ({ author: key(i + 1), name, username, bio, avatar: null }))

export const own = members[0].author
export const association = key(900)

export const applicants = [
  { author: key(60), name: 'Nina Souza', username: 'nina_souza', bio: 'Chegando para conhecer o bairro.', avatar: null },
  { author: key(61), name: 'Caio Lima', username: 'caio_lima', bio: 'Gosto de encontros na praça.', avatar: null }
]

export const pages = [
  { author: key(20), name: 'Biblioteca da Praça', username: 'biblioteca_praca', bio: 'Página da biblioteca comunitária. Histórias para todas as idades.', avatar: null },
  { author: key(21), name: 'Horta do Bairro', username: 'horta_do_bairro', bio: 'Página da horta: sementes, oficinas e mutirões.', avatar: null }
]

const exchanges = [
  ['Você vai ao passeio de sábado?', 'Vou sim! Qual é o ponto de encontro?', 'Na praça, perto da biblioteca.', 'Combinado! Levo água para o caminho.'],
  ['Separei as mudas de manjericão.', 'Que bom! Posso buscar amanhã?', 'Pode! Vou estar na horta depois das nove.', 'Tem uma muda de alecrim também 🌱'],
  ['Olha esta ideia para a exposição.', 'Gostei da proposta de usar fotos antigas.', 'Podemos pedir imagens às pessoas do bairro.', 'Vou levar o álbum da minha avó.'],
  ['Terminei o livro do clube!', 'Eu também. O último capítulo me surpreendeu.', 'Vamos conversar no encontro?', 'Sim, reservei a tarde de domingo.'],
  ['Já ouviu a seleção desta semana?', 'Ainda não. Tem alguma indicação?', 'Começa pela segunda faixa 🎶', 'Depois me conta o que achou.'],
  ['Olá! Vi seu post sobre a biblioteca.', 'Você sabe o horário da oficina?'],
  ['Oi, cheguei agora ao bairro.', 'Gostaria de conhecer o grupo de caminhada.'],
  ['Bom dia! Tenho sementes para trocar.', 'Posso levar no próximo encontro?']
]

// Three requests have no local profile yet, as with a new correspondent.
export const conversations = exchanges.map((texts, i) => {
  const peer = i < 5 ? members[i + 1].author : key(30 + i)
  const folder = i < 5 ? 'inbox' : 'request'
  const messages = texts.map((text, j) => {
    const mine = folder === 'inbox' && (j === 1 || (i % 2 === 0 && j === 3))
    return {
      id: id(100 + i * 10 + j),
      from: mine ? own : peer,
      text,
      replyTo: j === 2 ? id(100 + i * 10 + 1) : null,
      at: at(j < 2 ? 4 : 5, 10 + i % 4, j * 5),
      mine,
      media: null
    }
  })
  // A photo-only message, then two photos with a caption.
  if (i === 2) messages.push({ id: id(100 + i * 10 + 5), from: peer, text: '', replyTo: null, at: at(5, 13, 30), mine: false, media: [dmPhoto(1, 0)] })
  if (i === 3) messages.push({ id: id(100 + i * 10 + 5), from: peer, text: 'Fotos do encontro de domingo.', replyTo: null, at: at(5, 13, 40), mine: false, media: [dmPhoto(2, 1), dmPhoto(3, 2)] })
  return { peer, folder, unread: i % 2 === 1, blocked: false, messages }
})

// A pending composer belongs to the lab UI, never to dm.thread's confirmed rows.
export const uncertainSends = [{
  peer: conversations[0].peer,
  text: 'Também posso levar um lanche.',
  replyTo: null,
  at: now,
  uncertain: true,
  message: 'não deu para confirmar o envio'
}]

export const communities = [
  { community: key(40), name: 'Nosso Bairro', join: 'open', state: 'ready', role: 'member', general: key(50), creator: members[1].author },
  { community: key(41), name: 'Clube de Leitura', join: 'approval', state: 'ready', role: 'admin', general: key(52), creator: members[4].author },
  { community: key(42), name: 'Horta Comunitária', join: 'open', state: 'ready', role: 'member', general: key(54), creator: members[2].author }
]

const groupTexts = [
  ['Bom dia, vizinhança!', 'A feira começa às nove.', 'Podemos nos encontrar na praça.', 'Até sábado!'],
  ['Vamos organizar o passeio?', 'O trajeto passa pelo parque.', 'Prefiro sair depois das oito.', 'Fechado, encontro na entrada principal.'],
  ['Qual será a próxima leitura?', 'Sugiro um livro de contos.', 'Boa ideia! Cada pessoa escolhe um conto.', 'Levo algumas sugestões no domingo.'],
  ['Vamos preparar a roda de conversa?', 'Separei as perguntas do encontro.', 'Posso cuidar dos cartazes.', 'Obrigada! Vai ficar muito bonito.'],
  []
]

// Posts with photos added to a public group (1) and a private one (3).
const groupPhotos = {
  1: [
    ['Olha o caminho de hoje 🚲', [publicPhoto(1, 3)]],
    ['', [publicPhoto(2, 0), publicPhoto(3, 1), publicPhoto(4, 2)]]
  ],
  3: [
    ['Os cartazes ficaram prontos!', [privatePhoto(1, 2)]]
  ]
}

export const groups = ['Geral', 'Passeios de bicicleta', 'Geral', 'Organização do clube', 'Geral'].map((name, i) => {
  const community = communities[i < 2 ? 0 : i < 4 ? 1 : 2]
  const group = key(50 + i)
  const visibility = i === 3 ? 'private' : 'public'
  const items = groupTexts[i].map((text, j) => {
    const member = members[(i + j + 1) % members.length]
    return {
      writer: key(100 + i * 10 + j),
      diary: member.author,
      seq: 2,
      at: at(j < 2 ? 4 : 5, 12, j * 10),
      text,
      replyTo: i === 0 && j === 3 ? { writer: key(102), seq: 2 } : null,
      hidden: false,
      media: null,
      name: member.name,
      username: member.username
    }
  })
  const photos = groupPhotos[i] || []
  photos.forEach(([text, media], k) => {
    const member = members[(i + k + 2) % members.length]
    items.push({ writer: key(100 + i * 10 + 4 + k), diary: member.author, seq: 2, at: at(5, 13, 10 + k * 10), text, replyTo: null, hidden: false, media, name: member.name, username: member.username })
  })
  return {
    group,
    name,
    join: visibility === 'private' ? 'approval' : 'open',
    role: community.role,
    members: 6,
    community: community.community,
    creator: community.creator,
    visibility,
    writer: key(200 + i),
    seen: i === 0 ? null : items[1] ? { at: items[1].at, writer: items[1].writer, seq: items[1].seq } : null,
    items
  }
})

const postTexts = [
  'Um café na varanda para começar o dia. ☕',
  'O passeio de sábado está combinado! @lia_oliveira, vem com a gente?',
  'As primeiras flores apareceram na horta 🌻',
  'A cidade muda quando a gente começa a caminhar com calma.',
  'Qual livro fez você perder a noção do tempo?',
  'Uma seleção de músicas para a tarde: https://example.org/musica',
  'A biblioteca abre as portas para uma roda de histórias neste domingo.',
  'Oficina de compostagem: traga suas dúvidas e sua curiosidade.',
  'A ideia da @cecilia_ramos para a horta merece uma conversa!',
  'Pedalei até o parque hoje. O caminho está cheio de flores.',
  'Tem manjericão para trocar por sementes de girassol.',
  'Um registro do nosso último encontro na praça.',
  'Adorei esta proposta para o próximo encontro do bairro.',
  'Aprendendo uma música nova, um acorde de cada vez.',
  'Agenda da semana: https://example.org/agenda\nTem encontro para todos os gostos.',
  'Mutirão no sábado: luvas, água e muita disposição.',
  'Obrigada pela companhia de ontem, @bia_araujo!',
  'Hoje o caminho de volta virou um passeio.',
  'A chuva chegou na hora certa para as mudas.',
  'Pequenos encontros fazem uma grande diferença no bairro.'
]

// The own member follows these diaries; every other member is known only
// through follow notices, search and peeks.
export const follows = [members[1].author, members[2].author, members[3].author, pages[0].author, pages[1].author]

const feedAuthors = [members[0], members[1], members[2], members[3], pages[0], pages[1]]

export const feed = postTexts.map((text, i) => {
  const author = feedAuthors[i % feedAuthors.length]
  return {
    kind: 'post',
    author: author.author,
    name: author.name,
    username: author.username,
    seq: 3 + Math.floor(i / feedAuthors.length),
    at: at(i < 10 ? 4 : 5, 9, i % 10 * 5),
    text,
    replyTo: null,
    quote: i === 12 ? { author: members[2].author, seq: 3 } : null,
    media: i === 11 ? [{ core: key(300), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 2048, sha256: key(301), width: 1200, height: 800 }] : null
  }
})

const ownPost = (n) => feed.filter((post) => post.author === own)[n]

// [kind, member, own post it targets (index among the own posts)]
const noticeRows = [
  ['follow', 4],
  ['reply', 1, 0],
  ['quote', 3, 1],
  ['mention', 5],
  ['like', 2, 0],
  ['repost', 3, 1],
  ['follow', 5],
  ['reply', 2, 2],
  ['quote', 4, 0],
  ['mention', 1]
]

const noticeTexts = {
  reply: ['Também quero ir! Posso levar um lanche?', 'Concordo, vale a pena repetir o encontro.'],
  quote: ['Isso me lembrou o nosso último passeio.', 'Boa ideia para o bairro inteiro.'],
  mention: ['@lia_oliveira, guardei um lugar para você na roda de conversa.', 'Obrigado pela dica, @lia_oliveira!']
}

// Posts by other diaries that the own member reads through Avisos. They sit
// outside the feed because feed.read only lists followed diaries.
export const noticePosts = noticeRows.flatMap(([kind, m, target], i) => {
  if (!noticeTexts[kind]) return []
  const member = members[m]
  const base = { author: member.author, name: member.name, username: member.username, seq: 10 + i, at: at(5, 10, i * 4) }
  const text = noticeTexts[kind][i > 5 ? 1 : 0]
  const mine = target === undefined ? null : ownPost(target)
  return [{
    kind: 'post',
    ...base,
    text,
    replyTo: kind === 'reply' ? { author: own, seq: mine.seq } : null,
    quote: kind === 'quote' ? { author: own, seq: mine.seq } : null,
    media: null
  }]
})

export const notices = noticeRows.map(([kind, m, target], i) => {
  const member = members[m]
  return {
    kind,
    key: member.author,
    seq: 10 + i,
    at: at(5, 10, i * 4),
    name: member.name,
    username: member.username,
    seen: id(400 + i),
    avatar: null,
    ...(kind === 'like' || kind === 'repost' ? { post: `${own}:${ownPost(target).seq}` } : {})
  }
})

// Public operations behind notices and the following lists use real fixture
// block references, so diary.peek can resolve them just like posts.
export const diaryRecords = [
  ...notices.filter((n) => ['follow', 'like', 'repost'].includes(n.kind)).map((n) => ({
    author: n.key,
    seq: n.seq,
    record: n.kind === 'follow'
      ? { type: 'follow', key: own, on: true, at: n.at }
      : { type: n.kind, to: { author: own, seq: Number(n.post.split(':')[1]) }, on: true, at: n.at }
  })),
  ...follows.map((key, i) => ({ author: own, seq: 7 + i, record: { type: 'follow', key, on: true, at: now } })),
  ...pages.flatMap((p) => members.filter((m) => m.author !== own).map((m, i) => ({ author: p.author, seq: 30 + i, record: { type: 'follow', key: m.author, on: true, at: now } })))
]

export const fixtures = { now, own, association, members, applicants, pages, follows, conversations, uncertainSends, communities, groups, feed, noticePosts, notices, diaryRecords }
