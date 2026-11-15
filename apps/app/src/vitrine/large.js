// Rows for timing the native list, built only from the fixtures passed in.
// Diaries are ones feed.read already shows, so the pages need no node.
// Times step back from the newest fixture item by one minute: no clock and
// no randomness. By default the rows are text, plus the repost and quote
// slots. With options.rich they also carry the row kinds people see (photos,
// grids, carousels, link cards, replies), so list timing covers real cost.
// Photos reuse descriptors the fixture feed already names, which the
// Vitrine's /media stand-in (./publicMedia.js) serves as real bytes.

const MINUTE = 60 * 1000

const lines = [
  'Um café na varanda para continuar o dia.',
  'Passei na praça e o banco da sombra estava livre.',
  'As mudas novas pedem água ainda esta semana.',
  'Separei um livro curto para o encontro de domingo.',
  'O caminho de volta deu vontade de pedalar de novo.',
  'Alguém deixou flores na porta da biblioteca.',
  'A reunião do bairro cabe numa tarde sem pressa.',
  'Guardei sementes de girassol para a troca.',
  'A chuva de ontem fez bem para a horta.',
  'Hoje o pão saiu no ponto e sobrou para dividir.'
]

const quoteLines = [
  'Isso combina com o que a gente conversa na praça.',
  'Vale levar esta ideia para o próximo encontro.',
  'Fiquei com vontade de continuar esse assunto.',
  'Guardei isto para mostrar no domingo.'
]

// Fixed slots per block of 50 rows when options.rich is on. Slots 3 and 13
// are the quote and repost of the plain feed and stay put. A feed post with
// two or more photos is a carousel; the mosaic grid is drawn only inside a
// quote card (src/ui/MediaGrid.js), so grid rows quote a post with 2 to 4
// photos. Link rows carry a stored card, as a published post does.
export const RICH_BLOCK = 50
export const RICH_SLOTS = {
  photo: [0, 10, 20, 30, 40],
  grid: [5, 25],
  carousel: [8, 38],
  link: [1, 11, 21, 31, 41],
  reply: [7, 17, 27, 37],
  quote: [3, 33],
  repost: [13, 23]
}
const CAROUSEL_PHOTOS = 6
// Link slots that become a provider player when options.embeds is on: one
// per provider in every block, so the first screen already mixes them.
const EMBED_LINK_SLOTS = [1, 11, 31, 41]

// Provider links the app's own tests already use (test/musicEmbed.test.js,
// test/linkPreview.test.js), each one a player for embedOf in
// src/musicEmbed.js. The card is what fallbackCard there stores: the
// canonical page URL, its host and the provider name, no thumbnail.
const providerCards = [
  { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', host: 'www.youtube.com', title: 'YouTube', desc: '', image: null },
  { url: 'https://soundcloud.com/artist-1/song_name', host: 'soundcloud.com', title: 'SoundCloud', desc: '', image: null },
  { url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', host: 'open.spotify.com', title: 'Spotify', desc: '', image: null },
  { url: 'https://music.apple.com/br/album/some-album/1440857781', host: 'music.apple.com', title: 'Apple Music', desc: '', image: null }
]

const linkTitles = [
  'Hortas comunitárias no bairro',
  'Como organizar uma troca de livros',
  'Rotas de bicicleta para o fim de semana'
]

const slotOf = (kind, i) => RICH_SLOTS[kind].includes(i % RICH_BLOCK)
// The row's place among the rows of its kind: indexing by i alone would
// pick the same target for every slot that shares a remainder.
const ordinalOf = (kind, i) => Math.floor(i / RICH_BLOCK) * RICH_SLOTS[kind].length + RICH_SLOTS[kind].indexOf(i % RICH_BLOCK)

function mediaPool (feed) {
  const pool = []
  const seen = new Set()
  for (const post of Array.isArray(feed) ? feed : []) {
    for (const d of Array.isArray(post && post.media) ? post.media : []) {
      const id = d.core + ':' + d.start + ':' + d.blocks
      if (!seen.has(id)) { seen.add(id); pool.push(d) }
    }
  }
  return pool
}

function pickMedia (pool, i, n) {
  if (pool.length === 0) return null
  const out = []
  for (let k = 0; k < Math.min(n, pool.length); k++) out.push(pool[(i * 7 + k) % pool.length])
  return out
}

function visibleMembers (fixtures) {
  const members = Array.isArray(fixtures.members) ? fixtures.members : []
  const follows = new Set(Array.isArray(fixtures.follows) ? fixtures.follows : [])
  const own = fixtures.own
  const visible = members.filter((m) => m && typeof m.author === 'string' && (m.author === own || follows.has(m.author)))
  return visible.length > 0 ? visible : members.filter((m) => m && typeof m.author === 'string')
}

function postsOf (fixtures) {
  return (Array.isArray(fixtures.feed) ? fixtures.feed : []).filter((p) => p && p.kind !== 'repost' && typeof p.author === 'string' && Number.isInteger(p.seq))
}

// Posts a grid row can quote: 2 to 4 photos, from a diary feed.read shows
// when there is one, so the quote card resolves like the others.
function gridTargets (posts, authors) {
  const fits = posts.filter((p) => Array.isArray(p.media) && p.media.length >= 2 && p.media.length <= 4)
  const shown = new Set(authors.map((m) => m.author))
  const visible = fits.filter((p) => shown.has(p.author))
  return visible.length > 0 ? visible : fits
}

function newestMs (feed) {
  let best = Number.NEGATIVE_INFINITY
  for (const item of feed || []) {
    const ms = Date.parse(item.at)
    if (Number.isFinite(ms) && ms > best) best = ms
  }
  return best === Number.NEGATIVE_INFINITY ? Date.parse('2026-11-05T09:45:00.000Z') : best
}

export function largeFeed (fixtures, count = 200, options = {}) {
  const rich = !!options && options.rich === true
  const embeds = rich && options.embeds === true
  const authors = visibleMembers(fixtures)
  if (!Number.isInteger(count) || count < 1 || authors.length === 0) return []
  const posts = postsOf(fixtures)
  const newest = newestMs(fixtures.feed)
  const pool = rich ? mediaPool(fixtures.feed) : []
  const grids = rich ? gridTargets(posts, authors) : []
  const items = []
  for (let i = 0; i < count; i++) {
    const repost = posts.length > 0 && (rich ? slotOf('repost', i) : i % 50 === 13)
    const grid = rich && grids.length > 0 && !repost && slotOf('grid', i)
    const quote = posts.length > 0 && !repost && (grid || (rich ? slotOf('quote', i) : i % 50 === 3))
    const reply = rich && posts.length > 0 && !repost && !quote && slotOf('reply', i)
    const target = grid ? grids[ordinalOf('grid', i) % grids.length] : repost || quote || reply ? posts[i % posts.length] : null
    let member = authors[i % authors.length]
    if (target && !reply && member.author === target.author && authors.length > 1) member = authors[(i + 1) % authors.length]
    // An own repost would need a reaction entry to be undone; these timing
    // rows leave reposts to the other authors.
    if (repost && member.author === fixtures.own) {
      const other = authors.find((m) => m.author !== fixtures.own && m.author !== target.author)
      if (!other) continue
      member = other
    }
    const at = new Date(newest - (i + 1) * MINUTE).toISOString()
    const seq = 1000 + i
    if (repost) {
      items.push({
        kind: 'repost',
        author: member.author,
        name: member.name,
        username: member.username,
        seq,
        at,
        to: { author: target.author, seq: target.seq },
        text: null,
        replyTo: null,
        quote: null,
        media: null
      })
      continue
    }
    let text = quote ? quoteLines[i % quoteLines.length] : lines[i % lines.length]
    let media = null
    let preview = null
    if (rich && !quote && !reply) {
      if (slotOf('photo', i)) media = pickMedia(pool, i, 1)
      else if (slotOf('carousel', i)) media = pickMedia(pool, i, CAROUSEL_PHOTOS)
      else if (slotOf('link', i)) {
        const player = embeds ? EMBED_LINK_SLOTS.indexOf(i % RICH_BLOCK) : -1
        if (player >= 0) {
          preview = { ...providerCards[player] }
          text = 'Música para ouvir agora: ' + preview.url
        } else {
          const url = 'https://example.org/leitura-' + i
          preview = { url, host: 'example.org', title: linkTitles[i % linkTitles.length], desc: 'Um texto curto para ler com calma.', image: null }
          text = 'Vale a leitura: ' + url
        }
      }
    }
    items.push({
      kind: 'post',
      author: member.author,
      name: member.name,
      username: member.username,
      seq,
      at,
      text,
      replyTo: reply ? { author: target.author, seq: target.seq } : null,
      quote: quote ? { author: target.author, seq: target.seq } : null,
      media,
      // Only link rows name the key, so the plain rows keep the fixture shape.
      ...(preview ? { preview } : {})
    })
  }
  return items
}
