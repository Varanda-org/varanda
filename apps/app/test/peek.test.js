'use strict'

const test = require('brittle')
const { PEEK_RULE } = require('@varanda/core/lib/peek')
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
  t.is(PEEK_OFFLINE_MESSAGE, 'Confira sua internet.')
  t.is(PEEK_RULE_TEXT, PEEK_RULE, 'the rule is the node\'s, word for word')
  t.ok(!PEEK_RULE_TEXT.includes('o seu incluído'))
  t.is(PEEK_SHORT_TEXT, 'Até três publicações de cada diário que você não segue.')
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

test('an expired list is the USAGE error with the exact expiry sentence', async (t) => {
  const { isExpiredPeekError, isWebOnlyError } = await load()
  const expired = { code: 'USAGE', message: 'A lista expirou; atualize para continuar.' }
  t.is(isExpiredPeekError(expired), true)
  t.is(isWebOnlyError(expired), false, 'never read as web-only')
  t.is(isExpiredPeekError({ code: 'USAGE', message: 'A lista expirou' }), false)
  t.is(isExpiredPeekError({ code: 'NETWORK', message: 'A lista expirou; atualize para continuar.' }), false)
  t.is(isExpiredPeekError(new Error('A lista expirou; atualize para continuar.')), false)
  t.is(isExpiredPeekError({ code: 'USAGE', message: 'método desconhecido' }), false)
  t.is(isExpiredPeekError(null), false)
  t.is(isExpiredPeekError(undefined), false)
})

test('the skipped note is singular, plural or null, without reasons', async (t) => {
  const { skippedText } = await load()
  const singular = skippedText(1)
  const plural = skippedText(3)
  t.is(singular, '1 diário não aparece.')
  t.is(plural, '3 diários não aparecem.')
  t.is(skippedText(0), null)
  t.is(skippedText(-1), null)
  t.is(skippedText(undefined), null)
  t.is(skippedText(1.5), null)
  for (const note of [singular, plural]) {
    t.is(note.includes('certificado'), false)
    t.is(note.includes('('), false)
  }
})

test('page needs: a repost shows and needs its original, never the repost itself', async (t) => {
  const { pageNeeds, peekKey } = await load()
  const repost = Object.freeze({ kind: 'repost', author: 'r', seq: 4, round: 0, to: { author: 'AA', seq: 7 } })
  const needs = pageNeeds([repost])
  t.alike(needs.shown, ['aa:7'])
  t.alike(needs.need, ['aa:7'])
  t.is(needs.local.size, 0, 'nothing local for a repost')
  t.alike(needs.authors, [])
  t.is(peekKey(repost), 'r:4', 'the list key is the reposter\'s author:seq')
  t.not(peekKey(repost), needs.need[0], 'the requested target is the original\'s author:seq')
})

test('page needs: posts are local and shown; their quote and reply targets are needed', async (t) => {
  const { pageNeeds } = await load()
  const post = Object.freeze({ kind: 'post', author: 'a', seq: 1, round: 0, text: 'olá' })
  const reply = Object.freeze({ kind: 'post', author: 'b', seq: 2, round: 0, text: 'oi', replyTo: { author: 'C', seq: 3 } })
  const quote = Object.freeze({ kind: 'post', author: 'd', seq: 5, round: 1, text: 'veja', quote: { author: 'e', seq: 6 } })
  const needs = pageNeeds([post, reply, quote])
  t.alike(needs.shown, ['a:1', 'b:2', 'd:5'])
  t.alike(needs.need, ['c:3', 'e:6'])
  t.alike([...needs.local.keys()], ['a:1', 'b:2', 'd:5'])
  t.is(needs.local.get('b:2'), reply)
  t.alike(pageNeeds([{ kind: 'repost', author: 'r', seq: 1, to: { author: 'x', seq: 0 } }]).need, [], 'an invalid repost target is dropped')
  t.alike(pageNeeds([]), { local: new Map(), shown: [], need: [], authors: [] })
})
