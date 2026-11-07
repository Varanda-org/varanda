'use strict'

// The plan of the hosted lab's dataset (scripts/lab-dataset.js runs it):
// pure and deterministic from a seed, so two runs with the same seed build
// diaries with the same shape. Each member's diary starts with HEADER
// (certificate, username, profile); the first photo adds the media-core
// declaration right before its post, as the browser node writes it, so every
// action knows the seq it lands on and a target can be named by
// `<key>:<seq>` before its author has written it.

const HEADER = ['member-cert', 'username', 'profile']
const TARGETABLE = new Set(['post', 'photo', 'reply', 'quote'])
const PHOTO_SIZES = [[160, 120], [120, 160], [200, 150], [150, 150]]
const MIN_BLOCKS = HEADER.length + 1
const MAX_MEMBERS = 1000
const MAX_BLOCKS_PER_MEMBER = 10000

const FIRST = [
  ['Ana', 'ana'], ['Bruno', 'bruno'], ['Carla', 'carla'], ['Diego', 'diego'], ['Elisa', 'elisa'],
  ['Fábio', 'fabio'], ['Gabriela', 'gabriela'], ['Heitor', 'heitor'], ['Isabela', 'isabela'],
  ['João', 'joao'], ['Karina', 'karina'], ['Lucas', 'lucas'], ['Marina', 'marina'], ['Nicolas', 'nicolas'],
  ['Olívia', 'olivia'], ['Paulo', 'paulo'], ['Quitéria', 'quiteria'], ['Rafael', 'rafael'], ['Sofia', 'sofia'],
  ['Tiago', 'tiago'], ['Úrsula', 'ursula'], ['Vitor', 'vitor'], ['Yasmin', 'yasmin'], ['Zeca', 'zeca']
]
const LAST = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Lima', 'Pereira', 'Costa', 'Ribeiro', 'Almeida', 'Carvalho', 'Gomes', 'Rocha']
const WORDS = [
  'hoje', 'café', 'praia', 'chuva', 'feira', 'samba', 'livro', 'trabalho', 'cidade', 'bairro', 'sol', 'noite',
  'almoço', 'ônibus', 'música', 'jogo', 'amigos', 'família', 'viagem', 'festa', 'rua', 'varanda', 'cachorro',
  'gato', 'pão', 'mercado', 'domingo', 'segunda', 'escola', 'praça', 'show', 'foto', 'receita', 'bicicleta'
]
const OPENERS = ['Olha só', 'Acabei de ver', 'Pensando aqui', 'Alguém mais', 'Que dia', 'Bom dia', 'Fim de tarde', 'Sério']
const REPLIES = ['Concordo demais', 'Verdade!', 'Kkkkk', 'Também acho', 'Que legal', 'Nossa, sim', 'Discordo um pouco', 'Boa!']
const BIOS = ['Gosto de café e de conversa', 'Fotos do bairro', 'Música, livros e chuva', 'Sempre na varanda', 'Daqui do centro']
const COMMUNITY_NAMES = ['Vizinhança', 'Clube do Livro', 'Futebol de Domingo', 'Receitas da Vó']

// Small, fast, 32-bit: enough for synthetic content (never for keys).
function mulberry32 (a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedHash (seed) {
  const s = String(seed)
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

function makeRandom (seed) {
  const next = mulberry32(seedHash(seed))
  const int = (n) => Math.floor(next() * n)
  const pick = (list) => list[int(list.length)]
  return { next, int, pick }
}

function sentence (rnd) {
  const n = 3 + rnd.int(8)
  const words = []
  for (let i = 0; i < n; i++) words.push(rnd.pick(WORDS))
  const tag = rnd.next() < 0.15 ? ' #' + rnd.pick(WORDS) : ''
  return rnd.pick(OPENERS) + ', ' + words.join(' ') + tag
}

function checkInt (name, v, min) {
  if (!Number.isSafeInteger(v) || v < min) throw new TypeError(name + ' must be an integer >= ' + min)
}

// planDataset({ seed, members, blocksPerMember, photoShare, communities })
// -> { seed, members: [{ index, name, username, bio, blocks, actions }],
//      communities: [{ index, name, creator, members, posts }], totals }.
// Each action is { id, member, kind, seq, text?, photo?, target? } where
// target is { id, member, seq } of an earlier action (in the round-robin
// order the ids follow) by another member. A member never likes or reposts
// the same target twice, so every action writes exactly one block.
function planDataset ({ seed, members = 60, blocksPerMember = 150, photoShare = 0.2, communities = 2 } = {}) {
  if (seed === undefined || seed === null || String(seed) === '') throw new TypeError('seed is required')
  checkInt('members', members, 1)
  checkInt('blocksPerMember', blocksPerMember, MIN_BLOCKS)
  checkInt('communities', communities, 0)
  if (typeof photoShare !== 'number' || !(photoShare >= 0 && photoShare <= 1)) throw new TypeError('photoShare must be within 0..1')
  const rnd = makeRandom(seed)

  // Kinds first, per member: whether a member has photos decides how many
  // actions fit in its blocks (the media-core declaration takes one).
  const kindsOf = []
  for (let m = 0; m < members; m++) {
    const n = blocksPerMember - HEADER.length
    const kinds = []
    for (let i = 0; i < n; i++) {
      // The first action is a plain post, so every member has something to
      // be replied to early on.
      if (i === 0) { kinds.push('post'); continue }
      if (rnd.next() < photoShare) { kinds.push('photo'); continue }
      const r = rnd.next()
      kinds.push(r < 0.35 ? 'post' : r < 0.55 ? 'reply' : r < 0.65 ? 'quote' : r < 0.75 ? 'repost' : 'like')
    }
    if (kinds.includes('photo')) {
      let drop = kinds.length - 1
      while (drop > 0 && kinds[drop] === 'photo') drop--
      kinds.splice(drop > 0 ? drop : kinds.length - 1, 1)
      if (!kinds.includes('photo')) kinds.push('post')
    }
    kindsOf.push(kinds)
  }

  const plan = { seed: String(seed), members: [], communities: [], totals: { blocks: 0, actions: 0, photos: 0, kinds: {} } }
  for (let m = 0; m < members; m++) {
    const [name, ascii] = FIRST[m % FIRST.length]
    const last = LAST[(m + Math.floor(m / FIRST.length)) % LAST.length]
    const suffix = String(m + 1).padStart(2, '0')
    plan.members.push({
      index: m,
      name: name + ' ' + last,
      username: (ascii.slice(0, 16) + '_' + suffix).slice(0, 20),
      bio: BIOS[m % BIOS.length],
      blocks: HEADER.length,
      actions: []
    })
  }

  // Round-robin ids: action r of every member before action r + 1 of any,
  // which is the "earlier" a target must be.
  const targetable = []
  const engaged = new Set()
  const rounds = Math.max(...kindsOf.map((k) => k.length))
  let id = 0
  for (let r = 0; r < rounds; r++) {
    for (let m = 0; m < members; m++) {
      let kind = kindsOf[m][r]
      if (kind === undefined) continue
      const member = plan.members[m]
      const action = { id: id++, member: m, kind, seq: 0 }
      if (kind === 'reply' || kind === 'quote' || kind === 'repost' || kind === 'like') {
        let target = null
        for (let tries = 0; tries < 8 && target === null; tries++) {
          const t = targetable.length === 0 ? null : targetable[rnd.int(targetable.length)]
          if (t === null || t.member === m) continue
          if ((kind === 'like' || kind === 'repost') && engaged.has(kind + ':' + m + ':' + t.id)) continue
          target = t
        }
        if (target === null) {
          kind = 'post'
          action.kind = kind
        } else {
          action.target = { id: target.id, member: target.member, seq: target.seq }
          if (kind === 'like' || kind === 'repost') engaged.add(kind + ':' + m + ':' + target.id)
        }
      }
      if (kind === 'photo') {
        if (!member.actions.some((a) => a.kind === 'photo')) member.blocks++
        const [width, height] = rnd.pick(PHOTO_SIZES)
        action.photo = { seed: Math.floor(rnd.next() * 4294967296), width, height }
        action.text = rnd.next() < 0.6 ? sentence(rnd) : ''
      } else if (kind === 'post') {
        action.text = sentence(rnd)
      } else if (kind === 'reply') {
        action.text = rnd.pick(REPLIES) + (rnd.next() < 0.5 ? ', ' + sentence(rnd).toLowerCase() : '')
      } else if (kind === 'quote') {
        action.text = sentence(rnd)
      }
      action.seq = member.blocks++
      member.actions.push(action)
      if (TARGETABLE.has(kind)) targetable.push(action)
    }
  }

  const size = members > 1 ? Math.max(1, Math.min(members - 1, Math.floor(members / 3))) : 0
  for (let c = 0; c < communities; c++) {
    const creator = c % members
    const others = []
    for (let m = 0; m < members; m++) if (m !== creator) others.push(m)
    const chosen = []
    while (chosen.length < size && others.length > 0) chosen.push(others.splice(rnd.int(others.length), 1)[0])
    chosen.sort((a, b) => a - b)
    const posters = [creator, ...chosen]
    const posts = []
    for (let i = 0; i < Math.min(5, posters.length * 2); i++) posts.push({ member: posters[rnd.int(posters.length)], text: sentence(rnd) })
    plan.communities.push({ index: c, name: COMMUNITY_NAMES[c % COMMUNITY_NAMES.length] + (c >= COMMUNITY_NAMES.length ? ' ' + (c + 1) : ''), creator, members: chosen, posts })
  }

  for (const member of plan.members) {
    plan.totals.blocks += member.blocks
    plan.totals.actions += member.actions.length
    for (const a of member.actions) {
      plan.totals.kinds[a.kind] = (plan.totals.kinds[a.kind] || 0) + 1
      if (a.kind === 'photo') plan.totals.photos++
    }
  }
  return plan
}

// "<members>x<blocks>" -> { members, blocksPerMember }, or null when malformed.
function parseDatasetSize (value) {
  const m = /^(\d{1,4})x(\d{1,6})$/.exec(String(value))
  if (m === null) return null
  const members = Number(m[1])
  const blocksPerMember = Number(m[2])
  // Far below the protocol limits (a reader's follow list, MAX_LOG_BLOCKS
  // per diary, plus the community blocks a member adds), so a size the
  // parser accepts never fails halfway through generation.
  if (members < 1 || members > MAX_MEMBERS || blocksPerMember < MIN_BLOCKS || blocksPerMember > MAX_BLOCKS_PER_MEMBER) return null
  return { members, blocksPerMember }
}

module.exports = { planDataset, parseDatasetSize, makeRandom, HEADER, MIN_BLOCKS }
