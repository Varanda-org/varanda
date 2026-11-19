'use strict'

const test = require('brittle')
const { hashtagsOf } = require('@varanda/core/lib/topic-trend')
const { BLOCKED_TERMS } = require('@varanda/rpc')

const load = () => import('../src/topicTrend.js')

test('topic trend copy and refresh interval', async (t) => {
  const trend = await load()
  t.is(trend.TOPIC_TREND_TITLE, 'Assuntos do momento')
  t.is(trend.TOPIC_TREND_ORDER_TEXT, 'As hashtags usadas por mais pessoas nas últimas 24 horas, em publicações públicas guardadas por este semeador. Cada pessoa conta uma vez. A mesma lista para todo mundo.')
  t.is(trend.TOPIC_TREND_INDEXING, 'Montando a lista…')
  t.is(trend.TOPIC_TREND_EMPTY, 'Nenhum assunto em alta agora')
  t.is(trend.TOPIC_TREND_REFRESH_MS, 60000)
  for (const [name, value] of Object.entries(trend)) {
    if (typeof value === 'string') t.is(value.includes('\u2014'), false, name)
  }
})

test('authorsLabel uses singular only for one person', async (t) => {
  const { authorsLabel } = await load()
  t.is(authorsLabel(1), '1 pessoa')
  t.is(authorsLabel(2), '2 pessoas')
})

test('trendRows drops blocked tags and preserves the order of the other rows', async (t) => {
  const { trendRows } = await load()
  const blocked = BLOCKED_TERMS.find((term) => /^[a-z]{2,32}$/.test(term))
  t.alike(trendRows([
    { tag: 'sol', authors: 1 },
    { tag: blocked, authors: 4 },
    { tag: 'cafe', authors: 2 }
  ]), [
    { tag: 'sol', label: '#sol', meta: '1 pessoa' },
    { tag: 'cafe', label: '#cafe', meta: '2 pessoas' }
  ])
})

test('trendRows returns an empty list for empty or malformed input', async (t) => {
  const { trendRows } = await load()
  t.alike(trendRows([]), [])
  t.alike(trendRows(null), [])
  t.alike(trendRows({ tag: 'sol', authors: 1 }), [])
  t.alike(trendRows([{ tag: 'sol', authors: 1 }, null]), [])
  t.alike(trendRows([{ tag: '#sol', authors: 1 }]), [])
  t.alike(trendRows([{ tag: 'sol', authors: '1' }]), [])
})

const CORPUS = [
  'Um dia de #sol e #chuva',
  '#Café #cafe\u0301',
  '#VARANDA',
  '#2026',
  '#a',
  '#' + 'a'.repeat(33),
  '#a#b #ab#cd',
  '#tag.',
  '#tag,',
  'https://x.com#frag #fora',
  'https://x.com/path#frag #fora',
  'https://x.com/#frag',
  'https://x.com/path?tag=#inside www.x.com?#inside x.com/#inside',
  '#東京 #한국 #кофе',
  '#🌻 🌻#flor #sol🌻',
  'texto\n#nova',
  '#sol #Café #SOL #lua #cafe'
]

test('the app and seeder extract the same distinct hashtag tokens in order', async (t) => {
  const { findTags } = await import('../src/hashtags.js')
  for (const input of CORPUS) {
    const appTags = [...new Set(findTags(input).map(({ tag }) => tag))]
    t.alike(appTags, hashtagsOf(input), JSON.stringify(input))
  }
})

test('the seeder keeps the first ten of twelve distinct tags, as the app finds them', async (t) => {
  const { findTags } = await import('../src/hashtags.js')
  const input = Array.from({ length: 12 }, (_, i) => '#tag' + String.fromCharCode(97 + i)).join(' ')
  const appTags = [...new Set(findTags(input).map(({ tag }) => tag))]
  t.is(appTags.length, 12)
  t.alike(hashtagsOf(input), appTags.slice(0, 10))
})

test('trendRows drops a multi-word blocked term glued into one tag, exactly', async (t) => {
  const { trendRows } = await load()
  const glued = BLOCKED_TERMS.filter((term) => term.includes(' ')).map((term) => term.replace(/ /g, '')).find((tag) => /^[a-z0-9]{2,28}$/.test(tag))
  t.ok(glued, 'the list has a multi-word term that fits a tag')
  const rows = trendRows([
    { tag: glued, authors: 5 },
    { tag: glued + '2026', authors: 4 },
    { tag: '7' + glued, authors: 4 },
    { tag: 'xy' + glued + 'z', authors: 3 },
    { tag: 'sol', authors: 2 }
  ])
  t.alike(rows.map((r) => r.tag), ['xy' + glued + 'z', 'sol'], 'only the longer word and the plain tag stay')
})
