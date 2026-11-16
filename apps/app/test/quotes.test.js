// Pure logic of the 'citacoes' screen (quotes.js): verification of the
// index's quote list against peeked records, view state and strings.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/quotes.js')

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const C = 'ef'.repeat(32)
const D = '12'.repeat(32)
const E = '34'.repeat(32)
const FOCAL = A + ':7'

const peek = (key, seq, record, extra = {}) => ({ key, entries: [{ seq, record }], profile: null, username: null, ...extra })
const quote = (to = { author: A, seq: 7 }, extra = {}) => ({ type: 'post', text: 'concordo', at: '2026-11-01T10:00:00.000Z', replyTo: null, quote: to, ...extra })

test('confirmQuotes keeps a post whose signed quote is the focal post and counts the rest', async (t) => {
  const { confirmQuotes } = await load()
  const peeked = new Map([
    [B, peek(B, 2, quote(), { profile: { name: 'Bia' }, username: 'bia_s' })],
    [C, peek(C, 4, quote({ author: A, seq: 8 }))],
    [D, peek(D, 5, { type: 'post', text: 'oi', at: '2026-11-01T10:00:00.000Z', replyTo: { author: A, seq: 7 } })],
    [E, peek(E, 6, { type: 'like', on: true, to: { author: A, seq: 7 } })]
  ])
  const items = [B + ':2', C + ':4', D + ':5', E + ':6', '99'.repeat(32) + ':1', 'nope']
  const out = confirmQuotes({ focal: FOCAL, items, peeked })
  t.alike(out.rows, [{ author: B, seq: 2, ref: B + ':2', at: '2026-11-01T10:00:00.000Z', text: 'concordo', media: false, name: 'Bia', username: 'bia_s', avatar: null }])
  t.is(out.unconfirmed, 5, 'other target, a reply, not a post, no peek, malformed ref')
})

test('confirmQuotes drops a record for another seq or another key, and repeats', async (t) => {
  const { confirmQuotes } = await load()
  const peeked = new Map([[B, peek(B, 3, quote())], [C, peek(B, 2, quote())]])
  const out = confirmQuotes({ focal: FOCAL, items: [B + ':2', C + ':2', B + ':3', B + ':3'], peeked })
  t.is(out.rows.length, 1, 'the seq the index listed was not peeked, the key does not match, a repeat shows once')
  t.is(out.rows[0].seq, 3)
  t.is(out.unconfirmed, 2)
})

test('confirmQuotes never throws on junk and keeps the index order', async (t) => {
  const { confirmQuotes } = await load()
  t.alike(confirmQuotes(null), { rows: [], unconfirmed: 0 })
  t.alike(confirmQuotes({ focal: 'x', items: [B + ':2'], peeked: new Map() }), { rows: [], unconfirmed: 1 })
  const peeked = new Map([[B, peek(B, 2, quote(undefined, { media: [{}] }))], [C, peek(C, 9, quote())]])
  const out = confirmQuotes({ focal: FOCAL, items: [C + ':9', B + ':2'], peeked })
  t.alike(out.rows.map((r) => r.author), [C, B], 'newest first, as listed')
  t.is(out.rows[1].media, true)
})

test('listView: web-only, offline, loading, error, empty, hidden and ready', async (t) => {
  const { listView } = await load()
  t.is(listView({ hosted: false }).view, 'web-only')
  t.is(listView({ hosted: true, unsupported: true }).view, 'unavailable')
  t.is(listView({ hosted: true, online: false, rows: [] }).view, 'offline')
  t.is(listView({ hosted: true, online: false, rows: [{}] }).view, 'ready', 'a loaded list stays')
  t.is(listView({ hosted: true, phase: 'loading', rows: [] }).view, 'loading')
  t.is(listView({ hosted: true, phase: 'error', rows: [], error: 'x' }).message, 'x')
  t.is(listView({ hosted: true, phase: 'ready', rows: [], total: 0, indexing: false, complete: true }).view, 'empty')
  t.is(listView({ hosted: true, phase: 'ready', rows: [], total: 3 }).view, 'hidden', 'a positive total never claims nobody quoted')
  t.is(listView({ hosted: true, phase: 'ready', rows: [], total: 3, unconfirmed: 3 }).view, 'unchecked')
  t.is(listView({ hosted: true, phase: 'ready', rows: [], total: 0, indexing: true }).view, 'hidden')
})

test('notesOf says when the list is partial and how many were unavailable', async (t) => {
  const { notesOf, countLabel } = await load()
  t.alike(notesOf({ total: 2, listed: 2, unconfirmed: 0 }), [])
  t.alike(notesOf({ total: 80, listed: 50, unconfirmed: 0 }), ['Esta lista mostra só as citações mais recentes.'])
  t.alike(notesOf({ indexing: true, total: 1, listed: 0, unconfirmed: 1 }), ['Ainda montando a lista completa…', '1 citação indisponível'])
  t.alike(notesOf({ complete: false, unconfirmed: 2 }), ['Alguma citação pode faltar nesta lista.', '2 citações indisponíveis'])
  t.is(countLabel(1), '1 citação')
  t.is(countLabel(3), '3 citações')
  t.is(countLabel(null), '')
})

test('the Citações list is wired from the post row to the screen', (t) => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const row = read('src/ui/PostRow.js')
  t.ok(row.includes("{ id: 'quotes', icon: 'citar'"), 'a row in the mais sheet with the count')
  t.ok(row.includes('fn(onOpenQuotes) && quotes !== null && quotes > 0'), 'only with a handler and a known positive count')
  t.ok(row.includes("if (row.id === 'quotes') return onOpenQuotes"))
  const rua = read('src/screens/ARua.js')
  t.ok(rua.includes('onOpenQuotes: offers.quotes ? () => live.h.onOpenQuotes({ ref }) : undefined'))
  t.is(rua.split('const handlers = { onOpenThread, onOpenMember, onOpenMention, onOpenEngagers, onOpenQuotes,').length - 1, 2, 'both feeds pass the handler')
  const app = read('App.js')
  t.ok(app.includes("pushScreen({ screen: 'citacoes', key: ref, params: {} })"))
  t.ok(app.includes("entry.screen === 'citacoes' ? Citacoes"))
  t.ok(app.includes('onOpenQuotes: openQuotes,'), 'the stacked screens get it too')
  const screen = read('src/screens/Citacoes.js')
  t.ok(screen.includes('fetchPost(focal)'), 'the existing post index method, no new request')
  t.ok(screen.includes('displayText(row.text)'), 'peer text goes through displayText')
})

test('sources have no em dash', (t) => {
  t.absent(fs.readFileSync(path.join(__dirname, '../src/quotes.js'), 'utf8').includes('\u2014'))
  t.absent(fs.readFileSync(__filename, 'utf8').includes('\u2014'))
})

test('every screen that opens the likers list also opens the quotes list', (t) => {
  const dir = path.join(__dirname, '..', 'src', 'screens')
  let checked = 0
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8')
    if (!/onOpenEngagers[,}= ]/.test(source)) continue
    checked++
    t.ok(source.includes('onOpenQuotes'), file + ' passes onOpenQuotes next to onOpenEngagers')
  }
  t.ok(checked >= 7, 'the screens that render post rows were found')
})
