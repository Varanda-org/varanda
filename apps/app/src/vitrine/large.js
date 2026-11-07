// Rows for timing the native list, built only from the fixtures passed in.
// Diaries are ones feed.read already shows, so the pages need no node.
// Times step back from the newest fixture item by one minute: no clock and
// no randomness. Rows carry no photos: the Vitrine does not serve /media for
// them, so photo cost is measured on the hosted lab instead.

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

function newestMs (feed) {
  let best = Number.NEGATIVE_INFINITY
  for (const item of feed || []) {
    const ms = Date.parse(item.at)
    if (Number.isFinite(ms) && ms > best) best = ms
  }
  return best === Number.NEGATIVE_INFINITY ? Date.parse('2026-11-05T09:45:00.000Z') : best
}

export function largeFeed (fixtures, count = 200) {
  const authors = visibleMembers(fixtures)
  if (!Number.isInteger(count) || count < 1 || authors.length === 0) return []
  const posts = postsOf(fixtures)
  const newest = newestMs(fixtures.feed)
  const items = []
  for (let i = 0; i < count; i++) {
    const repost = posts.length > 0 && (i % 50 === 13)
    const quote = posts.length > 0 && !repost && (i % 50 === 3)
    const target = repost || quote ? posts[i % posts.length] : null
    let member = authors[i % authors.length]
    if (target && member.author === target.author && authors.length > 1) member = authors[(i + 1) % authors.length]
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
    items.push({
      kind: 'post',
      author: member.author,
      name: member.name,
      username: member.username,
      seq,
      at,
      text: quote ? quoteLines[i % quoteLines.length] : lines[i % lines.length],
      replyTo: null,
      quote: quote ? { author: target.author, seq: target.seq } : null,
      media: null
    })
  }
  return items
}
