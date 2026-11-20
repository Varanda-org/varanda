'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('@babel/core')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
const busca = read('screens/BuscaGlobal.js')
const topics = read('ui/TrendingTopics.js')

test('BuscaGlobal loads trending topics and opens the existing hashtag page', (t) => {
  t.ok(busca.includes("import { fetchTopicTrend } from '../indexClient'"), 'index client')
  t.ok(busca.includes("import { TrendingTopics } from '../ui/TrendingTopics'"), 'trending topics component')
  t.ok(busca.includes('useContext(HashtagContext)'), 'shared hashtag navigation')
  t.ok(busca.includes('TOPIC_TREND_REFRESH_MS'), 'shared refresh interval')
  t.ok(busca.indexOf('<TrendingTopics') > busca.indexOf("{recentList('publicacoes')}"), 'topics are below the post recents')
})

test('TrendingTopics has an accessible title and shows tags through displayText', (t) => {
  t.ok(topics.includes("import { displayText } from '@varanda/rpc'"), 'displayText import')
  t.ok(topics.includes('displayText(label)'), 'tag label is sanitized')
  t.ok(topics.includes("accessibilityRole='header'"), 'title role')
  t.ok(topics.includes("accessibilityRole='button'"), 'chip role')
  t.absent(/<Text[^>]*>\s*\{TOPIC_TREND_ORDER_TEXT\}\s*<\/Text>/.test(topics), 'no inline order rule')
  t.absent(topics.includes('Platform.OS'), 'shared across platforms')
})

function trendEffect (helpers, answers) {
  const start = busca.indexOf('  const [trend, setTrend]')
  const end = busca.indexOf('  // While typing', start)
  const refs = []
  let refIndex = 0
  let previous = []
  let trend = null
  let calls = 0
  let now = 0
  const render = runInNewContext('(active, refresh) => {\n' + busca.slice(start, end) + '}', {
    ...helpers,
    postsGate: null,
    drafts: { publicacoes: '' },
    openTag () {},
    visible: true,
    category: 'publicacoes',
    Date: { now: () => now },
    useState: () => [trend, (next) => { trend = next }],
    useRef (current) {
      const i = refIndex++
      return refs[i] || (refs[i] = { current })
    },
    useEffect (effect, deps) {
      if (!deps.length || deps.every((value, i) => value === previous[i])) return
      previous = deps
      effect()
    },
    fetchTopicTrend () {
      calls++
      return Promise.resolve(answers.shift())
    }
  })
  return {
    show (active, refresh, at = now) {
      now = at
      refIndex = 0
      render(active, refresh)
    },
    calls: () => calls,
    trend: () => trend
  }
}

const settle = () => new Promise(setImmediate)
const result = (topics, flags = {}) => ({ ok: true, value: { topics, indexing: false, ...flags } })

test('a failed trend read keeps the list and a later show can read again', async (t) => {
  const helpers = await import('../src/topicTrend.js')
  const { TOPIC_TREND_REFRESH_MS: interval } = helpers
  const h = trendEffect(helpers, [
    result([{ tag: 'horta', authors: 3 }]),
    { ok: false },
    result([], { indexing: true }),
    result([{ tag: 'bairro', authors: 4 }])
  ])
  h.show(true, 0)
  h.show(false, 0)
  h.show(true, 0)
  t.is(h.calls(), 1, 'showing again while the read is pending makes no duplicate')
  await settle()
  const previous = h.trend()
  t.is(previous?.rows[0]?.tag, 'horta')
  h.show(true, 1, interval - 1)
  t.is(h.calls(), 1, 'refreshes inside the interval are throttled after success')
  h.show(false, 1, interval)
  h.show(true, 1)
  await settle()
  t.is(h.calls(), 2, 'a later show after the interval made one read')
  t.is(h.trend(), previous, 'the error kept the list')
  h.show(true, 1)
  t.is(h.calls(), 2, 'the error does not trigger another read')
  h.show(false, 1)
  h.show(true, 1)
  await settle()
  t.is(h.calls(), 3, 'a new show can read again after the error')
  t.is(h.trend().indexing, true)
  t.is(h.trend().rows.length, 0)
  h.show(false, 1)
  h.show(true, 1)
  await settle()
  t.is(h.calls(), 4, 'an empty indexing result can also be read on the next show')
  t.is(h.trend().rows[0]?.tag, 'bairro')
  h.show(false, 1, interval * 2)
  h.show(true, 1)
  t.is(h.calls(), 4, 'a success is kept for the same refresh value')
})

test('BuscaGlobal forwards the completeness of a trend read to TrendingTopics', async (t) => {
  const helpers = await import('../src/topicTrend.js')
  const h = trendEffect(helpers, [result([], { complete: false }), result([])])
  h.show(true, 0)
  await settle()
  t.is(h.trend().complete, false)
  h.show(true, 1, helpers.TOPIC_TREND_REFRESH_MS)
  await settle()
  t.is(h.trend().complete, true, 'an omitted flag defaults to complete')
  t.ok(busca.includes('complete={trend.complete}'))
})

test('TrendingTopics puts the order rule in help and shows the incomplete note with or without rows', async (t) => {
  const helpers = await import('../src/topicTrend.js')
  const { code } = transformSync(topics, {
    babelrc: false,
    configFile: false,
    plugins: [
      [require.resolve('@babel/plugin-transform-react-jsx'), { runtime: 'automatic' }],
      require.resolve('@babel/plugin-transform-modules-commonjs')
    ]
  })
  const element = (type, props) => ({ type, props })
  const modules = {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Text: 'Text', View: 'View' },
    '@varanda/rpc': require('@varanda/rpc'),
    '../topicTrend': helpers,
    './Help': { HelpButton: ({ doc }) => [doc.title, ...doc.paragraphs] },
    './PressScale': { PressScale: 'PressScale' },
    './ThemeProvider': { useStyles: () => ({}) },
    './theme': {}
  }
  const exports = {}
  runInNewContext(code, { exports, require: (name) => modules[name] })
  const textOf = (node) => {
    if (typeof node === 'string') return [node]
    if (Array.isArray(node)) return node.flatMap(textOf)
    if (typeof node?.type === 'function') return textOf(node.type(node.props))
    return node ? textOf(node.props.children) : []
  }
  const render = (rows, complete, indexing = false) => textOf(exports.TrendingTopics({ rows, complete, indexing }))
  const note = 'Ainda montando a lista; algum assunto pode faltar.'
  const partial = render(helpers.trendRows([{ tag: 'horta', authors: 3 }]), false)
  t.alike(Array.from(partial.slice(0, 3)), [helpers.TOPIC_TREND_TITLE, 'Ordem de ' + helpers.TOPIC_TREND_TITLE, helpers.TOPIC_TREND_ORDER_TEXT], 'help beside the title has its own label and the original rule')
  t.ok(partial.includes('#horta'))
  t.ok(partial.includes(note))
  t.ok(render([], false).includes(note))
  t.absent(render([], false).includes(helpers.TOPIC_TREND_EMPTY))
  t.ok(render([], false, true).includes(note))
  t.ok(render([], true).includes(helpers.TOPIC_TREND_EMPTY))
})

test('the screen and component contain no em dash', (t) => {
  t.absent(busca.includes('\u2014'), 'BuscaGlobal')
  t.absent(topics.includes('\u2014'), 'TrendingTopics')
})
