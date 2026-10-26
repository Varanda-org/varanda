'use strict'

const test = require('brittle')
const load = () => import('../src/peek.js')
const item = (author, seq, round = 0) => Object.freeze({ author, seq, round, text: 'olá' })

test('peek keys identify a post by author and sequence', async (t) => {
  const { peekKey } = await load()
  t.is(peekKey(item('a', 1)), 'a:1')
  t.is(peekKey(item('a:1', 2)), 'a:1:2')
  t.not(peekKey(item('a', 12)), peekKey(item('a1', 2)), 'different authors never collide')
})

test('merging a page appends new rows in page order and skips repeats', async (t) => {
  const { mergePage } = await load()
  const a = item('a', 1)
  const b = item('b', 1)
  const c = item('a', 2)
  const d = item('c', 1)
  const current = Object.freeze([a, b])
  const page = Object.freeze([c, b, d, c])
  t.alike(mergePage(current, page), { items: [a, b, c, d], added: 2 })
  t.alike(mergePage(current, []), { items: [a, b], added: 0 })
  t.alike(mergePage([], page), { items: [c, b, d], added: 3 })
  t.alike(mergePage(current, [a]), { items: [a, b], added: 0 }, 'a page of repeats adds nothing')
})

test('merging never mutates the inputs', async (t) => {
  const { mergePage } = await load()
  const current = Object.freeze([item('a', 1)])
  const page = Object.freeze([item('b', 1)])
  const result = mergePage(current, page)
  t.is(current.length, 1)
  t.is(page.length, 1)
  t.not(result.items, current, 'a new array is returned')
  t.is(result.items[0], current[0])
})

test('a page is the last one when next is null or the page is empty', async (t) => {
  const { isLastPeekPage } = await load()
  t.is(isLastPeekPage({ items: [item('a', 1)], next: null }), true)
  t.is(isLastPeekPage({ items: [], next: 'cursor' }), true)
  t.is(isLastPeekPage({ items: [item('a', 1)], next: 'cursor' }), false)
})

test('withoutAuthor drops every row of one author and keeps the rest in order', async (t) => {
  const { withoutAuthor } = await load()
  const items = Object.freeze([item('a', 1), item('b', 1), item('a', 2), item('c', 1)])
  t.alike(withoutAuthor(items, 'a'), [item('b', 1), item('c', 1)])
  t.alike(withoutAuthor(items, 'z'), [...items])
  t.alike(withoutAuthor([], 'a'), [])
  t.is(items.length, 4, 'the input is not changed')
})

test('round starts mark the first row and every change of round', async (t) => {
  const { roundStarts } = await load()
  const rows = [item('a', 1, 0), item('b', 1, 0), item('a', 2, 1), item('c', 1, 1), item('a', 3, 2)]
  t.alike([...roundStarts(rows)], [0, 2, 4])
  t.alike([...roundStarts([item('a', 1, 0), item('b', 1, 0)])], [0])
  t.alike([...roundStarts([])], [])
  t.alike([...roundStarts([item('a', 1, 1), item('b', 1, 0)])], [0, 1])
})

test('round labels name the second and third post of each diary only', async (t) => {
  const { roundLabel } = await load()
  t.is(roundLabel(0), null)
  t.is(roundLabel(1), '2ª publicação de cada diário')
  t.is(roundLabel(2), '3ª publicação de cada diário')
  t.is(roundLabel(3), null)
  t.is(roundLabel(-1), null)
  t.is(roundLabel(undefined), null)
})

test('the notice is web-only first, then offline, else none', async (t) => {
  const { peekNotice } = await load()
  t.is(peekNotice({ supported: true, hosted: true, online: true, loadedAt: 1 }), null)
  t.is(peekNotice({ supported: true, hosted: true, online: true, loadedAt: null }), null)
  t.is(peekNotice({ supported: true, hosted: true, online: false, loadedAt: 1 }), null)
  t.is(peekNotice({ supported: true, hosted: true, online: false, loadedAt: null }), 'offline')
  t.is(peekNotice({ supported: true, hosted: false, online: false, loadedAt: null }), 'web-only')
  t.is(peekNotice({ supported: true, hosted: false, online: true, loadedAt: 1 }), 'web-only')
  t.is(peekNotice({ supported: false, hosted: true, online: false, loadedAt: null }), 'web-only')
  t.is(peekNotice({ supported: false, hosted: true, online: true, loadedAt: 1 }), 'web-only')
})

test('the fixed texts are the approved Portuguese', async (t) => {
  const { PEEK_WEB_ONLY_MESSAGE, PEEK_OFFLINE_MESSAGE, PEEK_RULE_TEXT, PEEK_SHORT_TEXT } = await load()
  t.is(PEEK_WEB_ONLY_MESSAGE, 'Nesta versão, a Espiadinha só funciona na versão web no site da associação.')
  t.is(PEEK_OFFLINE_MESSAGE, 'A Espiadinha precisa de conexão com o semeador.')
  t.ok(PEEK_RULE_TEXT.startsWith('A Espiadinha mostra a publicação mais recente de cada diário que você não segue'))
  t.ok(PEEK_RULE_TEXT.includes('e, por fim, a terceira mais recente de cada um'))
  t.ok(PEEK_RULE_TEXT.endsWith('sem curtidas, sem sugestões e sem pesos escondidos.'))
  t.is(PEEK_SHORT_TEXT, 'Até três publicações de cada diário que você não segue, uma rodada por vez, da mais nova para a mais antiga.')
})

test('a web-only error is a USAGE error with one of the two known messages', async (t) => {
  const { isWebOnlyError } = await load()
  t.is(isWebOnlyError({ code: 'USAGE', message: 'método desconhecido' }), true)
  t.is(isWebOnlyError({ code: 'USAGE', message: 'Espiadinha disponível só no navegador' }), true)
  t.is(isWebOnlyError({ code: 'USAGE', message: 'outra coisa' }), false)
  t.is(isWebOnlyError({ code: 'NETWORK', message: 'método desconhecido' }), false)
  t.is(isWebOnlyError({ message: 'método desconhecido' }), false)
  t.is(isWebOnlyError(new Error('Espiadinha disponível só no navegador')), false)
  t.is(isWebOnlyError(null), false)
  t.is(isWebOnlyError(undefined), false)
  t.is(isWebOnlyError('USAGE'), false)
})
