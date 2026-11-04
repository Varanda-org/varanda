'use strict'

// Composer emoji data and insertion work in UTF-16, limits in code points.
const test = require('brittle')
const load = () => import('../src/emoji.js')

test('emoji list: unique named entries in eleven Portuguese groups', async (t) => {
  const { EMOJI, EMOJI_GROUPS } = await load()
  t.ok(EMOJI.length >= 380 && EMOJI.length <= 420)
  t.is(EMOJI_GROUPS.length, 11)
  t.alike(EMOJI_GROUPS.map(group => group.label), [
    'Carinhas', 'Pessoas', 'Gestos', 'Corações', 'Bichos e natureza', 'Comida',
    'Atividades', 'Viagens e lugares', 'Objetos', 'Símbolos', 'Bandeiras'
  ])
  t.is(new Set(EMOJI.map(item => item.e)).size, EMOJI.length)
  t.is(new Set(EMOJI.map(item => item.name)).size, EMOJI.length)
  for (const item of EMOJI) {
    t.alike(Object.keys(item).sort(), ['e', 'name'])
    t.ok(typeof item.e === 'string' && item.e.length > 0)
    t.ok(typeof item.name === 'string' && item.name.trim().length > 0)
    t.absent(Array.from(item.e).some(ch => {
      const cp = ch.codePointAt(0)
      return cp >= 0x1f3fb && cp <= 0x1f3ff
    }))
    // Enclosed alphanumerics read as part of a name, so an @nome typed right
    // after one is not a mention (packages/rpc/lib/mentions.js).
    t.absent(Array.from(item.e).some(ch => {
      const cp = ch.codePointAt(0)
      return cp >= 0x1f100 && cp <= 0x1f1e5
    }))
    t.ok(Array.from(item.e).every(ch => {
      const cp = ch.codePointAt(0)
      return cp < 0xd800 || cp > 0xdfff
    }))
  }
  for (const group of EMOJI_GROUPS) {
    t.ok(typeof group.label === 'string' && group.label.trim().length > 0)
    t.ok(group.emojis.length >= 16)
  }
  const flags = EMOJI_GROUPS.find(group => group.label === 'Bandeiras').emojis
  t.ok(flags.length >= 16 && flags.length <= 24)
  t.is(flags[0].e, '🇧🇷')
  t.alike(EMOJI_GROUPS.flatMap(group => group.emojis), EMOJI)
  for (const e of ['🇧🇷', '⚽', '🌴', '☕']) t.ok(EMOJI.some(item => item.e === e))
})

test('filterEmoji: accent-insensitive pt-BR name filter', async (t) => {
  const { EMOJI, filterEmoji } = await load()
  for (const query of ['', '   ', null, 42]) t.is(filterEmoji(query), null)
  const hearts = filterEmoji('coracao')
  t.ok(hearts.length > 0)
  t.ok(hearts.every(item => item.name.includes('coração')))
  t.ok(hearts.some(item => item.e === '❤️'))
  t.alike(filterEmoji('CORAÇÃO'), hearts)
  t.alike(filterEmoji('zzzz'), [])
  const indexes = hearts.map(item => EMOJI.indexOf(item))
  t.ok(indexes.every(i => i >= 0))
  t.alike(indexes, [...indexes].sort((a, b) => a - b))
  t.is(new Set(indexes).size, indexes.length)
  t.alike(filterEmoji('❤️'), [])
})

test('insertAt: start, middle, end and replacement return a UTF-16 caret', async (t) => {
  const { insertAt } = await load()
  for (const [start, expected] of [[0, '😀olá'], [1, 'o😀lá'], [3, 'olá😀']]) {
    t.alike(insertAt('olá', { start, end: start }, '😀'), {
      text: expected,
      selection: { start: start + 2, end: start + 2 }
    })
  }
  t.alike(insertAt('bom dia', { start: 4, end: 7 }, '☕'), { text: 'bom ☕', selection: { start: 5, end: 5 } })
  t.alike(insertAt('', { start: 0, end: 0 }, '🇧🇷'), { text: '🇧🇷', selection: { start: 4, end: 4 } })
  t.alike(insertAt('abc', { start: 1, end: 2 }, ''), { text: 'ac', selection: { start: 1, end: 1 } })
})

test('insertAt: clamps, normalizes reversed ranges and never mutates selection', async (t) => {
  const { insertAt } = await load()
  const selection = Object.freeze({ start: -100, end: 100 })
  t.alike(insertAt('abc', selection, '😀'), { text: '😀', selection: { start: 2, end: 2 } })
  t.alike(selection, { start: -100, end: 100 })
  t.alike(insertAt('abc', { start: -5, end: -1 }, 'X'), { text: 'Xabc', selection: { start: 1, end: 1 } })
  t.alike(insertAt('abc', { start: 7, end: 9 }, 'X'), { text: 'abcX', selection: { start: 4, end: 4 } })
  t.alike(insertAt('abc', { start: 2, end: 1 }, 'X'), { text: 'aXc', selection: { start: 2, end: 2 } })
  t.alike(insertAt('abc', undefined, 'X'), { text: 'abcX', selection: { start: 4, end: 4 } })
  t.alike(insertAt('abc', { start: -Infinity, end: Infinity }, 'X'), { text: 'X', selection: { start: 1, end: 1 } })
})

test('insertAt: surrogate pairs stay intact for carets and range endpoints', async (t) => {
  const { insertAt } = await load()
  t.alike(insertAt('a😀b', { start: 2, end: 2 }, '☕'), { text: 'a😀☕b', selection: { start: 4, end: 4 } })
  t.alike(insertAt('a😀b', { start: 1, end: 2 }, '☕'), { text: 'a☕b', selection: { start: 2, end: 2 } })
  t.alike(insertAt('a😀b', { start: 2, end: 3 }, '☕'), { text: 'a☕b', selection: { start: 2, end: 2 } })
  t.alike(insertAt('😀😁', { start: 1, end: 3 }, '☕'), { text: '☕', selection: { start: 1, end: 1 } })
  const text = 'a😀b😁c'
  for (let start = 0; start <= text.length; start++) {
    for (let end = 0; end <= text.length; end++) {
      const result = insertAt(text, { start, end }, '🌴')
      t.ok(Array.from(result.text).every(char => {
        const point = char.codePointAt(0)
        return point < 0xd800 || point > 0xdfff
      }))
      t.is(result.selection.start, result.selection.end)
      t.is(result.text.slice(0, result.selection.start).at(-1), '🌴'.at(-1))
    }
  }
})

test('countAfterInsert: counts code points at and beyond the configured limit', async (t) => {
  const { countAfterInsert } = await load()
  t.alike(countAfterInsert('a'.repeat(999), '😀'), { count: 1000, allowed: true })
  t.alike(countAfterInsert('a'.repeat(1000), '😀'), { count: 1001, allowed: false })
  t.alike(countAfterInsert('😀', '🇧🇷', 3), { count: 3, allowed: true })
  t.alike(countAfterInsert('😀', '🇧🇷', 2), { count: 3, allowed: false })
  t.alike(countAfterInsert('', '', 0), { count: 0, allowed: true })
  t.alike(countAfterInsert('', '👩‍💻', 3), { count: 3, allowed: true })
})
