import { pictures } from './pictures.js'
import { sha256 } from '@noble/hashes/sha2.js'
import rpc from '@varanda/rpc'
import { ed25519 } from '@noble/curves/ed25519.js'

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const unhex = (text) => Uint8Array.from(text.match(/../g), (b) => parseInt(b, 16))
// Public demo seeds only: anyone can sign as these keys, so they never
// belong to real accounts and must never be seeded into a real deployment.
// Not the node's sodium: Metro keeps packages/web-member out of the app bundle.
const fixtureKeys = [1, 2].map((n) => {
  const seed = new Uint8Array(32).fill(n)
  return { publicKey: hex(ed25519.getPublicKey(seed)), seed }
})

export function signVitrineConsent (listingAuthor, listingSeq, rater, offerId) {
  const pair = fixtureKeys.find((pair) => pair.publicKey === listingAuthor)
  if (!pair) throw new Error('identidade indisponível')
  return hex(ed25519.sign(rpc.feira.dealPayload({ listingAuthor, listingSeq, rater, offerId }), pair.seed))
}

export function verifyVitrineConsent (listingAuthor, listingSeq, rater, offerId, consent) {
  try {
    return listingAuthor !== rater && /^[0-9a-f]{128}$/.test(consent) && ed25519.verify(unhex(consent), rpc.feira.dealPayload({ listingAuthor, listingSeq, rater, offerId }), unhex(listingAuthor), { zip215: false })
  } catch { return false }
}

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

// Public post photos carry the real length and SHA-256 of the drawing, so the
// verified media client accepts them (./publicMedia.js answers their route).
const hexBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)))
const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const POST_BYTES = pictures.map((picture) => hexBytes(picture.hex))
const POST_SHA = POST_BYTES.map((bytes) => hexOf(sha256(bytes)))
export const postPhoto = (n, p) => ({ core: key(300), mime: 'image/jpeg', start: 1 + n, blocks: 1, bytes: POST_BYTES[p].byteLength, sha256: POST_SHA[p], width: PICTURE_SIZE[p][0], height: PICTURE_SIZE[p][1] })
// Which drawing a post photo's SHA-256 names, or -1.
export const postPictureIndex = (sha) => POST_SHA.indexOf(sha)
// A fresh copy of the drawing a post photo names, or null.
export const postPictureBytes = (sha) => {
  const i = POST_SHA.indexOf(sha)
  return i < 0 ? null : new Uint8Array(POST_BYTES[i])
}
const privatePhoto = (n, p) => ({ core: key(740), mime: 'application/octet-stream', start: 1 + n, blocks: 1, bytes: 32768, sha256: key(750 + n), key: key(760 + n), nonce: '0'.repeat(46) + (n % 100).toString().padStart(2, '0'), plainMime: 'image/jpeg', plainSha256: key(PICTURE_BASE + p), w: PICTURE_SIZE[p][0], h: PICTURE_SIZE[p][1], ms: 0 })

// The member and page handles appear in the varanda.app screenshots, so the
// account service reserves them (RESERVED in apps/cli/lib/account/store.js and
// pages-routes.js). A renamed or new handle goes there too.
export const members = [
  ['Lia Oliveira', 'lia_oliveira', 'Café, livros e encontros na praça.'],
  ['João Nascimento', 'joao_nascimento', 'Pedalando pelo bairro.'],
  ['Cecília Ramos', 'cecilia_ramos', 'Cultivo plantas e boas conversas.'],
  ['André Costa', 'andre_costa', 'Fotografia e memória da cidade.'],
  ['Bia Araújo', 'bia_araujo', 'Sempre com um livro por perto.'],
  ['Tomás Ferreira', 'tomas_ferreira', 'Música para compartilhar.']
].map(([name, username, bio], i) => ({ author: fixtureKeys[i]?.publicKey || key(i + 1), name, username, bio, avatar: null }))

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

// Photos of the Mural: a few of the first posts carry one.
const feedPhotos = { 0: [postPhoto(0, 0)], 6: [postPhoto(1, 2)], 11: [postPhoto(2, 3)], 18: [postPhoto(3, 1)] }

const baseFeed = postTexts.map((text, i) => {
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
    media: feedPhotos[i] || null
  }
})

const photoPost = (member, seq, when, text, media, replyTo = null) => ({ kind: 'post', author: member.author, name: member.name, username: member.username, seq, at: when, text, replyTo, quote: null, media })

// Later photo posts, in time order after the posts above. The own diary gets
// six more tiles plus a reply with a photo (never a tile), a followed member
// and one who is not followed get a few each.
const photoPosts = [
  photoPost(members[0], 12, at(5, 10, 0), 'Primeiras fotos da exposição no bairro.', [postPhoto(4, 0)]),
  photoPost(members[0], 13, at(5, 10, 10), '', [postPhoto(5, 1), postPhoto(6, 2)]),
  photoPost(members[0], 14, at(5, 10, 20), 'Mutirão da horta: antes e depois.', [postPhoto(7, 3), postPhoto(8, 0)]),
  photoPost(members[0], 15, at(5, 10, 30), '', [postPhoto(9, 2)]),
  photoPost(members[0], 16, at(5, 10, 40), 'Passeio de bicicleta no fim da tarde 🚲', [postPhoto(10, 3), postPhoto(11, 1), postPhoto(12, 0), postPhoto(13, 2)]),
  photoPost(members[0], 17, at(5, 10, 50), '', [postPhoto(14, 1), postPhoto(15, 0)]),
  photoPost(members[0], 18, at(5, 10, 55), 'Que foto bonita da praça!', [postPhoto(16, 2)], { author: members[1].author, seq: 3 }),
  photoPost(members[1], 50, at(5, 11, 0), 'Pedal de domingo pelo parque.', [postPhoto(17, 3)]),
  photoPost(members[1], 51, at(5, 11, 10), '', [postPhoto(18, 0), postPhoto(19, 1)]),
  photoPost(members[1], 52, at(5, 11, 20), 'Parada para um café no caminho.', [postPhoto(20, 2)]),
  photoPost(members[1], 53, at(5, 11, 30), '', [postPhoto(21, 3)]),
  photoPost(members[4], 40, at(5, 12, 0), 'Meu canto de leitura hoje.', [postPhoto(22, 1)]),
  photoPost(members[4], 41, at(5, 12, 10), '', [postPhoto(23, 0)]),
  photoPost(members[4], 42, at(5, 12, 20), 'Livros novos para o clube.', [postPhoto(24, 2), postPhoto(25, 3)]),
  photoPost(members[4], 43, at(5, 12, 30), '', [postPhoto(26, 1), postPhoto(27, 0), postPhoto(28, 2)]),
  photoPost(members[4], 44, at(5, 12, 40), 'A biblioteca da praça em uma tarde de chuva.', [postPhoto(29, 3)])
]

export const feed = [...baseFeed, ...photoPosts]

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
  // A repost is no tile, and the likes make the own log longer than one
  // log.read page (32 blocks), so older photos sit on a second page.
  { author: own, seq: 19, record: { type: 'repost', to: { author: members[2].author, seq: 3 }, on: true, at: at(5, 11, 0) } },
  ...baseFeed.filter((post) => post.author !== own && post.quote === null).slice(0, 16).map((post, i) => ({ author: own, seq: 20 + i, record: { type: 'like', to: { author: post.author, seq: post.seq }, on: true, at: at(5, 13, i) } })),
  ...pages.flatMap((p) => members.filter((m) => m.author !== own).map((m, i) => ({ author: p.author, seq: 30 + i, record: { type: 'follow', key: m.author, on: true, at: now } })))
]

// Depoimentos. Nothing is sealed for real in the Vitrine: the hash is the
// real SHA-256 commitment, and the box is filler bytes of the length a real
// seal would have, so the records validate. `sealed` stands in for opening
// the box with the recipient's key.
const utf8 = (s) => Uint8Array.from(encodeURIComponent(s).match(/%[0-9A-F]{2}|[^%]/g), (c) => c.length === 3 ? parseInt(c.slice(1), 16) : c.charCodeAt(0))
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64 (bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0)
    out += BASE64[n >> 18 & 63] + BASE64[n >> 12 & 63] + (i + 1 < bytes.length ? BASE64[n >> 6 & 63] : '=') + (i + 2 < bytes.length ? BASE64[n & 63] : '=')
  }
  return out
}
const SEAL_BYTES = 48
// The commitment of docs/protocol.md: bound to the writer's key.
export const testimonialHash = (from, nonce, text) => hexOf(sha256(utf8(from + nonce + text)))
export function sealedTestimonial ({ from, to, text, nonce, at, gen = 1 }) {
  const hash = testimonialHash(from, nonce, text)
  const length = utf8(JSON.stringify({ text, nonce })).byteLength + SEAL_BYTES
  const box = new Uint8Array(length)
  let fill = sha256(utf8(hash))
  for (let i = 0; i < length; i++) {
    if (i % 32 === 0 && i > 0) fill = sha256(fill)
    box[i] = fill[i % 32]
  }
  return { type: 'testimonial', to, gen, hash, box: base64(box), at }
}

// [writer, writer seq, recipient, text, at]. Lia shows João's and Cecília's,
// Bia's waits for her, and João shows the one Lia wrote to him.
const testimonialRows = [
  [members[1].author, 60, own, 'A Lia é daquelas vizinhas que fazem o bairro parecer uma casa só. Foi ela quem organizou o primeiro café na praça, e até hoje lembra o nome de cada pessoa que passa por lá. Quando minha bicicleta quebrou no meio do passeio, ela apareceu com uma bomba de ar e um sorriso. Obrigado por tanto cuidado, Lia!', at(5, 11, 40)],
  [members[2].author, 60, own, 'Lia me apresentou ao clube de leitura e às melhores conversas de domingo. Pessoa generosa, sempre com uma indicação de livro na ponta da língua.', at(5, 11, 50)],
  [own, 38, members[1].author, 'João conhece cada atalho do bairro e nunca deixa ninguém para trás nos passeios. Companhia certa para pedalar e conversar.', at(5, 14, 10)],
  [members[4].author, 60, own, 'Lia, obrigada pelas mudas de manjericão e pela paciência na oficina de compostagem. Você deixa tudo mais leve! 🌿', at(5, 14, 30)]
]

export const sealed = testimonialRows.map(([author, seq, , text], i) => ({ author, seq, text, nonce: key(800 + i) }))

// [show diary, show seq, testimonialRows index, at]
const showRows = [
  [own, 36, 0, at(5, 14, 0)],
  [own, 37, 1, at(5, 14, 5)],
  [members[1].author, 61, 2, at(5, 14, 20)]
]

export const testimonialRecords = [
  ...testimonialRows.map(([author, seq, to, text, when], i) => ({ author, seq, record: sealedTestimonial({ from: author, to, text, nonce: sealed[i].nonce, at: when }) })),
  ...showRows.map(([author, seq, i, when]) => ({ author, seq, record: { type: 'testimonial-show', from: sealed[i].author, seq: sealed[i].seq, text: sealed[i].text, nonce: sealed[i].nonce, at: when } }))
]

const place = { uf: 'SP', city: 'São Paulo', bairro: 'Vila Mariana' }
const listing = (author, seq, kind, title, price, unit, cat, media) => ({
  author,
  seq,
  record: { type: 'listing', kind, title, text: 'Combine os detalhes pela conversa.', price, unit, cat, place, at: at(4, 14, seq - 40), ...(media ? { media } : {}) }
})

export const listings = [
  listing(own, 40, 'produto', 'Bicicleta azul', 25000, null, 'esporte', [postPhoto(40, 3), postPhoto(41, 0)]),
  listing(own, 41, 'procura', 'Procuro estante pequena', 18000, null, 'moveis'),
  listing(own, 42, 'produto', 'Livros de receitas', 3500, null, 'casa'),
  listing(members[1].author, 40, 'servico', 'Aulas de bicicleta', 6000, 'hora', 'aulas'),
  listing(members[1].author, 41, 'produto', 'Capacete de ciclismo', 8000, null, 'esporte'),
  listing(pages[0].author, 40, 'produto', 'Livros da biblioteca', 1500, null, 'outros'),
  { author: own, seq: 44, record: { type: 'listing-edit', seq: 40, title: 'Bicicleta azul revisada', text: 'Revisada e pronta para passear.', price: 25000, unit: null, cat: 'esporte', place, media: [postPhoto(40, 3), postPhoto(41, 0)], at: at(5, 12) } },
  { author: own, seq: 45, record: { type: 'listing-status', seq: 42, status: 'vendido', at: at(5, 12, 10) } },
  { author: members[1].author, seq: 42, record: { type: 'listing-status', seq: 41, status: 'reservado', at: at(5, 12, 20) } }
]

const consent = signVitrineConsent(own, 40, members[1].author, id(600))
export const rates = [
  { author: members[1].author, seq: 46, record: { type: 'listing-rate', to: { author: own, seq: 40 }, offer: id(600), consent, stars: 5, text: 'Combinamos tudo pela conversa.', at: at(5, 14) } },
  { author: members[2].author, seq: 46, record: { type: 'listing-rate', to: { author: own, seq: 40 }, offer: id(610), consent: '0'.repeat(128), stars: 1, text: 'Consentimento de demonstração inválido.', at: at(5, 14, 5) } }
]

const offerUrl = (author, seq, cents) => `https://vitrine.invalid/f/${author}/${seq}#oferta=${cents}`
const offerMessage = (n, mine, url, title, replyTo = null, image = null) => ({
  id: id(n),
  from: mine ? own : members[1].author,
  mine,
  text: title,
  replyTo,
  at: at(5, 14, n - 600),
  media: null,
  card: { url, host: rpc.cardUrlHost(url), title, desc: '', image }
})
export const offerThread = [
  offerMessage(600, false, offerUrl(own, 40, 24000), 'Proposta', null, dmPhoto(4, 3)),
  offerMessage(601, true, offerUrl(own, 40, 24000) + '&aceite=' + consent, 'Aceite', id(600)),
  offerMessage(602, false, offerUrl(own, 40, 20000), 'Proposta'),
  offerMessage(603, true, offerUrl(own, 40, 20000) + '&resposta=recusada', 'Recusa', id(602)),
  offerMessage(604, true, offerUrl(members[1].author, 40, 6000), 'Proposta'),
  offerMessage(605, false, offerUrl(members[1].author, 40, 6000) + '&aceite=' + signVitrineConsent(members[1].author, 40, own, id(604)), 'Aceite', id(604))
]
conversations[0].messages.push(...offerThread)

// Momentos (docs/rpc.md 5.113). A photo is one blob item, like a chat photo,
// that names its drawing through the sha256 (./media.js reads it back). The
// dates follow the demo clock `now`: the followed diaries and Lia have
// moments inside the 24 h, and Lia's two older ones are past, so the Diário
// lists them under "Momentos anteriores". Which ones were seen is the app's
// own state on the device, never fixture data.
const momentPhoto = (n, p) => ({ ...dmPhoto(40 + n, p), id: key(770 + n), key: key(780 + n) })
// [diary, seq, text, at, picture]
const momentRows = [
  [members[1].author, 70, 'Saindo para pedalar até o parque 🚲', at(5, 13, 20), 3],
  [members[1].author, 71, 'Parada para um café no meio do caminho.', at(5, 14, 10), 2],
  [members[2].author, 70, 'As mudas de manjericão estão prontas para troca 🌱', at(5, 11, 30), 1],
  [members[3].author, 70, 'Luz de fim de tarde na praça.', at(4, 18, 45), 0],
  [own, 48, 'Café na varanda antes do clube de leitura ☕', at(5, 12, 0), 0],
  [own, 47, 'Mutirão da horta, primeira hora.', at(3, 9, 30), 3],
  [own, 46, 'Livros novos na biblioteca da praça.', at(2, 16, 0), 2]
]

export const momentRecords = momentRows.map(([author, seq, text, when, p], i) => ({ author, seq, record: { type: 'moment', text, at: when, media: momentPhoto(i, p) } }))

export const fixtures = { now, own, association, members, applicants, pages, follows, conversations, uncertainSends, communities, groups, feed, noticePosts, notices, diaryRecords: [...diaryRecords, ...testimonialRecords, ...momentRecords], sealed, listings, rates }
