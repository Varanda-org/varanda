// Pure logic of the 'curtidas' screen (engagers.js): verification of the
// seeder's list against peeked records, view state and strings.
'use strict'

const test = require('brittle')
const load = () => import('../src/engagers.js')

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const C = 'ef'.repeat(32)
const D = '12'.repeat(32)
const E = '34'.repeat(32)
const F = '56'.repeat(32)
const G = '78'.repeat(32)
const H = '9a'.repeat(32)
const FOCAL = A + ':7'

function peek (key, seq, record, extra = {}) {
  return { key, entries: [{ seq, record }], profile: null, username: null, ...extra }
}

const like = (to = { author: A, seq: 7 }, on = true) => ({ type: 'like', on, to })

test('confirmEngagers keeps a verified like and counts every unproven item', async (t) => {
  const { confirmEngagers } = await load()
  const peeked = new Map([
    [B, peek(B, 2, like(), { profile: { name: 'Bia' }, username: 'bia_s' })],
    [C, peek(C, 4, { type: 'repost', on: true, to: { author: A, seq: 7 } })],
    [D, peek(D, 5, like(undefined, false))],
    [E, peek(E, 6, like({ author: B, seq: 7 }))],
    [F, peek(F, 8, like({ author: A, seq: 8 }))],
    [G, peek(G, 1, like())],
    [H, peek(B, 3, like())]
  ])
  const items = [B + ':2', C + ':4', D + ':5', E + ':6', F + ':8', G + ':2', H + ':3', '12'.repeat(31) + 'ff:1']
  const out = confirmEngagers({ kind: 'likes', focal: FOCAL, items, peeked })
  t.alike(out.rows, [{ author: B, seq: 2, name: 'Bia', username: 'bia_s' }])
  t.is(out.unconfirmed, 7, 'repost on likes, on false, other author, other seq, seq missing, wrong key, no peek')
})

test('confirmEngagers: a like with no profile and no username keeps its row', async (t) => {
  const { confirmEngagers } = await load()
  const out = confirmEngagers({ kind: 'likes', focal: FOCAL, items: [B + ':2'], peeked: new Map([[B, peek(B, 2, like())]]) })
  t.alike(out.rows, [{ author: B, seq: 2, name: null, username: null }])
  t.is(out.unconfirmed, 0)
})

test('confirmEngagers: names only from the profile, valid usernames, order and first repeat', async (t) => {
  const { confirmEngagers } = await load()
  const repost = { type: 'repost', on: true, to: { author: A, seq: 7 } }
  const peeked = new Map([
    [B, { key: B, entries: [{ seq: 2, record: { ...repost, text: 'nome' } }], profile: { name: 42 }, username: 'Not Valid' }],
    [C, { key: C, entries: [{ seq: 1, record: repost }, { seq: 9, record: repost }], profile: { name: 'Caio' }, username: 'abc123' }],
    [D, { key: D, entries: [{ seq: 3, record: repost }], profile: 'Dani', username: 'dani' }]
  ])
  const out = confirmEngagers({ kind: 'reposts', focal: FOCAL, items: [C + ':9', B + ':2', C + ':1', D + ':3'], peeked })
  t.alike(out.rows, [
    { author: C, seq: 9, name: 'Caio', username: null },
    { author: B, seq: 2, name: null, username: null },
    { author: D, seq: 3, name: null, username: 'dani' }
  ])
  t.is(out.unconfirmed, 0)
  for (const row of out.rows) {
    for (const v of [row.name, row.username]) t.ok(v === null || !v.includes(row.author.slice(0, 6)), 'no key-derived text')
  }
})

test('confirmEngagers never throws on bad input', async (t) => {
  const { confirmEngagers } = await load()
  const items = [B + ':2', 'x', null, 42, B + ':0']
  t.alike(confirmEngagers(), { rows: [], unconfirmed: 0 })
  t.alike(confirmEngagers(null), { rows: [], unconfirmed: 0 })
  t.alike(confirmEngagers({ kind: 'likes', focal: FOCAL, items: 'x', peeked: null }), { rows: [], unconfirmed: 0 })
  t.is(confirmEngagers({ kind: 'likes', focal: FOCAL, items, peeked: {} }).unconfirmed, 5)
  const peeked = new Map([[B, peek(B, 2, like())]])
  t.is(confirmEngagers({ kind: 'like', focal: FOCAL, items: [B + ':2'], peeked }).unconfirmed, 1, 'bad kind')
  t.is(confirmEngagers({ kind: 'likes', focal: A, items: [B + ':2'], peeked }).unconfirmed, 1, 'bad focal')
  const odd = new Map([
    [B, { key: B, entries: null }],
    [C, { key: C, entries: [null, { seq: 1, record: null }, { seq: 1, record: [] }] }],
    [D, { key: D, entries: [{ seq: 1, record: { type: 'like', on: true, to: null } }] }],
    [E, 'nope']
  ])
  t.is(confirmEngagers({ kind: 'likes', focal: FOCAL, items: [B + ':1', C + ':1', D + ':1', E + ':1'], peeked: odd }).unconfirmed, 4)
})

test('mergeRows appends new authors, keeps identity when nothing is added', async (t) => {
  const { mergeRows } = await load()
  const current = Object.freeze([Object.freeze({ author: B, seq: 1 })])
  const merged = mergeRows(current, [{ author: B, seq: 5 }, { author: C, seq: 2 }, { author: C, seq: 3 }])
  t.alike(merged, [{ author: B, seq: 1 }, { author: C, seq: 2 }])
  t.is(current.length, 1, 'no mutation')
  t.is(mergeRows(current, []), current)
  t.is(mergeRows(current, [{ author: B, seq: 9 }]), current)
  t.is(mergeRows(current, null), current)
  t.alike(mergeRows(null, [{ author: C, seq: 2 }, null]), [{ author: C, seq: 2 }])
})

test('nextCursor', async (t) => {
  const { nextCursor } = await load()
  t.is(nextCursor(null, 'abc'), 'abc')
  t.is(nextCursor('abc', 'abc'), null)
  t.is(nextCursor('abc', ''), null)
  t.is(nextCursor('abc', null), null)
  t.is(nextCursor(undefined, 42), null)
})

test('listView branches, first match wins', async (t) => {
  const { listView } = await load()
  const base = { hosted: true, online: true, phase: 'done', rows: [], next: null, unconfirmed: 0, kind: 'likes', total: 0 }
  const view = (o) => listView({ ...base, ...o }).view
  t.is(view({ hosted: false }), 'web-only')
  t.is(view({ unsupported: true, rows: [{ author: B }] }), 'web-only')
  t.alike(listView({ ...base, online: false }), { view: 'offline', title: 'Sem conexão', body: 'A lista precisa de internet.', action: 'tentar de novo' })
  t.is(view({ online: false, rows: [{ author: B }] }), 'ready')
  t.is(view({ rows: [{ author: B }], phase: 'error' }), 'ready')
  t.is(view({ phase: 'idle' }), 'loading')
  t.is(view({ phase: 'loading', next: 'x' }), 'loading')
  t.alike(listView({ ...base, phase: 'error', error: 'falhou' }), { view: 'error', message: 'falhou' })
  t.alike(listView({ ...base, phase: 'error', error: '' }), { view: 'error', message: 'Não foi possível carregar a lista.' })
  t.alike(listView({ ...base, next: 'x', unconfirmed: 2 }), { view: 'more', title: 'Ninguém conferido até aqui', body: 'A lista continua.', action: 'mostrar mais' })
  t.alike(listView({ ...base, unconfirmed: 2 }), { view: 'unchecked', title: 'Ninguém pôde ser conferido agora', body: 'Tente de novo em instantes.', action: 'tentar de novo' })
  t.alike(listView(base), { view: 'empty', title: 'Ninguém curtiu ainda', body: 'Quando alguém curtir, aparece aqui.' })
  t.alike(listView({ ...base, kind: 'reposts' }), { view: 'empty', title: 'Ninguém republicou ainda', body: 'Quando alguém republicar, aparece aqui.' })
})

test('listView never claims nobody engaged when the list may omit someone', async (t) => {
  const { listView } = await load()
  const base = { hosted: true, online: true, phase: 'done', rows: [], next: null, unconfirmed: 0, kind: 'likes' }
  const hidden = { view: 'hidden', title: 'Ninguém para mostrar agora', body: 'Algumas pessoas não aparecem nesta lista agora.', action: 'tentar de novo' }
  t.alike(listView({ rows: [], next: null, unconfirmed: 0, total: 1, hosted: true, phase: 'done' }), hidden)
  t.alike(listView({ ...base, total: 0, complete: false }), hidden)
  t.alike(listView({ ...base, total: 0, indexing: true }), { ...hidden, body: 'Ainda montando a lista completa…' })
  t.is(listView({ ...base }).view, 'hidden', 'unknown total')
})

test('listView, errorFor, countLabel and notesOf never throw', async (t) => {
  const { listView, countLabel, notesOf, errorFor } = await load()
  t.is(listView().view, 'web-only')
  t.is(listView(null).view, 'web-only')
  t.alike(notesOf(), [])
  t.alike(notesOf(null), [])
  t.is(countLabel(), '')
  t.is(countLabel('likes', -1), '')
  t.is(countLabel('likes', 1.5), '')
  t.is(countLabel('likes', '2'), '')
  t.is(countLabel('like', 2), '')
  t.is(errorFor(), 'Não foi possível carregar a lista.')
})

test('countLabel, errorFor, notesOf, kinds', async (t) => {
  const { countLabel, errorFor, notesOf, KINDS, isKind, recordType } = await load()
  t.alike(KINDS, ['likes', 'reposts'])
  t.ok(isKind('likes') && isKind('reposts'))
  t.absent(isKind('like'))
  t.is(recordType('likes'), 'like')
  t.is(recordType('reposts'), 'repost')
  t.is(recordType('x'), null)
  t.is(countLabel('likes', 1), '1 curtida')
  t.is(countLabel('likes', 0), '0 curtidas')
  t.is(countLabel('likes', 3), '3 curtidas')
  t.is(countLabel('reposts', 1), '1 republicação')
  t.is(countLabel('reposts', 2), '2 republicações')
  t.is(errorFor('not-found'), 'Esta lista não está disponível agora.')
  t.is(errorFor('rate-limited'), 'Muitas consultas ao semeador agora. Tente de novo em alguns segundos.')
  t.is(errorFor('outro'), 'Não foi possível carregar a lista.')
  t.alike(notesOf({ indexing: true, complete: false, unconfirmed: 1 }), ['Ainda montando a lista completa…', '1 pessoa indisponível'])
  t.alike(notesOf({ complete: false, unconfirmed: 3 }), ['Alguém pode faltar nesta lista.', '3 pessoas indisponíveis'])
  t.alike(notesOf({ complete: true, unconfirmed: 0 }), [])
  // A finished list shorter than the seeder's total says so; an unfinished
  // one or one whose gap is the unchecked people does not.
  t.alike(notesOf({ complete: true, unconfirmed: 0, total: 2, listed: 1, atEnd: true }), ['Algumas pessoas não aparecem nesta lista agora.'])
  t.alike(notesOf({ complete: true, unconfirmed: 0, total: 2, listed: 1, atEnd: false }), [])
  t.alike(notesOf({ complete: true, unconfirmed: 1, total: 2, listed: 1, atEnd: true }), ['1 pessoa indisponível'])
  t.alike(notesOf({ complete: true, unconfirmed: 0, total: 1, listed: 1, atEnd: true }), [])
  t.alike(notesOf({ complete: false, total: 5, listed: 1, atEnd: true }), ['Alguém pode faltar nesta lista.'])
})

test('constants and no exported string has an em dash', async (t) => {
  const mod = await load()
  t.is(mod.ENGAGERS_TITLE, 'Curtidas e republicações')
  t.alike(mod.TAB_LABEL, { likes: 'Curtidas', reposts: 'Republicações' })
  t.is(mod.SEEDER_DOWN, 'Sem conexão com o servidor agora.')
  t.is(mod.MORE_FAILED, 'Não foi possível carregar mais pessoas.')
  t.is(mod.END_TEXT, 'Isso é tudo nesta lista.')
  const strings = []
  const collect = (v) => {
    if (typeof v === 'string') strings.push(v)
    else if (Array.isArray(v)) v.forEach(collect)
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  collect(Object.values(mod).filter((v) => typeof v !== 'function'))
  for (const kind of [...mod.KINDS, 'x']) {
    for (const o of [{}, { hosted: true, online: false }, { hosted: true, phase: 'error' }, { hosted: true, next: 'x' }, { hosted: true, unconfirmed: 1 }, { hosted: true, total: 0 }, { hosted: true, indexing: true }]) {
      collect(mod.listView({ ...o, kind }))
    }
    collect(mod.countLabel(kind, 1))
    collect(mod.countLabel(kind, 2))
  }
  for (const r of ['not-found', 'rate-limited', 'x']) collect(mod.errorFor(r))
  collect(mod.notesOf({ indexing: true, unconfirmed: 1 }))
  collect(mod.notesOf({ complete: false, unconfirmed: 2 }))
  t.ok(strings.length > 20)
  for (const s of strings) t.absent(s.includes(String.fromCodePoint(0x2014)), s)
})
