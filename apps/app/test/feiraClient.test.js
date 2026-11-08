// Feira reads (src/feiraClient.js): index hints verified by diary.peek and
// folded, ratings only as the node verified them. fetch and the node are
// stubbed; no network.
'use strict'

const test = require('brittle')

const load = () => import('../src/feiraClient.js')
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const R = 'ef'.repeat(32)
const CURSOR = '1761000000000.' + B + '.7'
const AT = '2026-11-01T10:00:00.000Z'
const LATER = '2026-11-02T10:00:00.000Z'
const slots = { run: (fn) => fn() }

const place = { uf: 'SP', city: 'Campinas', bairro: null }
const root = (over = {}) => ({ type: 'listing', kind: 'produto', title: 'Bicicleta', text: 'aro 26', price: 30000, unit: null, cat: 'esporte', place, at: AT, ...over })
const edit = (seq, over = {}) => ({ type: 'listing-edit', seq, title: 'Bicicleta revisada', text: 'aro 26, pneus novos', price: 25000, unit: null, cat: 'esporte', place, at: LATER, ...over })
const status = (seq, s) => ({ type: 'listing-status', seq, status: s, at: LATER })
const post = { type: 'post', text: 'oi', at: AT }

// A node whose diary.peek answers from `diaries` ({ author: { seq: record } }),
// with `invalid` seqs per author; every call is recorded.
function fakeNode (diaries, { invalid = {}, ratings = null, fail = null } = {}) {
  const calls = []
  const request = async (method, params) => {
    calls.push({ method, params })
    if (fail) throw fail
    if (method === 'listing.ratings') return ratings
    if (method !== 'diary.peek') throw new Error('unexpected ' + method)
    const d = diaries[params.author] || {}
    const bad = invalid[params.author] || []
    const out = { key: params.author, length: 100, entries: [], invalid: [], missing: [], profile: params.profileSeq ? { name: 'Ana‮', bio: '', avatar: null } : null, username: params.usernameSeq ? 'ana' : null }
    for (const s of params.seqs) {
      if (bad.includes(s)) out.invalid.push(s)
      else if (d[s]) out.entries.push({ seq: s, record: d[s] })
      else out.missing.push(s)
    }
    return out
  }
  return { calls, request }
}

const hint = { profileSeq: 1, usernameSeq: 2 }
const item = (ref, over = {}) => ({ ref, status: 'disponivel', statusSeq: null, editSeq: null, ...over })
const answer = (items, over = {}) => {
  const authors = {}
  for (const it of items) authors[it.ref.split(':')[0]] = hint
  return { ok: true, value: { items, next: null, authors, indexing: false, complete: true, ...over } }
}
const deps = (value) => ({ peekSlots: slots, fetchFeira: async () => value, fetchFeiraAuthor: async () => value })
const Q = { uf: 'SP', cityKey: 'campinas' }

test('search -> peek -> the edited content, with the hinted status', async (t) => {
  const { search } = await load()
  const node = fakeNode({ [A]: { 5: root(), 8: edit(5), 9: status(5, 'reservado') } })
  const res = await search(node.request, Q, deps(answer([item(A + ':5', { status: 'reservado', statusSeq: 9, editSeq: 8 })])))
  t.is(res.ok, true)
  t.is(res.items.length, 1)
  const row = res.items[0]
  t.is(row.ref, A + ':5')
  t.is(row.title, 'Bicicleta revisada', 'the edit is folded over the root')
  t.is(row.price, 25000)
  t.is(row.edited, true)
  t.is(row.editSeq, 8)
  t.is(row.status, 'reservado', 'status from the verified block')
  t.is(row.kind, 'produto', 'kind always from the root')
  t.is(row.username, 'ana')
  t.absent(row.name.includes('‮'), 'peer name through displayText')
  t.is(node.calls.length, 1, 'one peek for the root, edit and status')
  t.alike(node.calls[0].params, { author: A, seqs: [5, 8, 9], profileSeq: 1, usernameSeq: 2 })
})

test('a lying ref is dropped: a post, an edit of another root, a status of another root', async (t) => {
  const { search } = await load()
  const node = fakeNode({
    [A]: { 3: post, 5: root(), 6: root(), 8: edit(6), 10: status(6, 'vendido') },
    [B]: { 4: root({ kind: 'procura', unit: null }), 7: status(4, 'reservado') }
  }, { invalid: { [A]: [11] } })
  const items = [
    item(A + ':3'),
    item(A + ':5', { editSeq: 8 }),
    item(A + ':6', { statusSeq: 10, status: 'vendido' }),
    item(A + ':11'),
    item(B + ':4', { statusSeq: 7, status: 'reservado' })
  ]
  const res = await search(node.request, Q, deps(answer(items)))
  t.is(res.ok, true)
  t.alike(res.items.map((r) => r.ref), [A + ':6'], 'only the proven listing')
  t.is(res.items[0].status, 'vendido')
  t.is(res.dropped, 4, 'post, foreign edit, invalid block, reservado procura')
  t.is(res.unavailable, 0)
})

test('a block the node could not read counts as unavailable, never shown as the root', async (t) => {
  const { search } = await load()
  const node = fakeNode({ [A]: { 5: root() } })
  const res = await search(node.request, Q, deps(answer([item(A + ':5', { editSeq: 8 }), item(A + ':9')])))
  t.is(res.items.length, 0, 'the pre-edit root is not shown')
  t.is(res.unavailable, 2)
  t.is(res.dropped, 0)
})

test('an empty page with next keeps the cursor and peeks nothing', async (t) => {
  const { search } = await load()
  const node = fakeNode({})
  const res = await search(node.request, Q, deps(answer([], { next: CURSOR, complete: false })))
  t.alike(res, { ok: true, items: [], next: CURSOR, dropped: 0, unavailable: 0, indexing: false, complete: false })
  t.is(node.calls.length, 0)
})

test('404 from the index is the Feira off; other failures pass through', async (t) => {
  const { search, byAuthor, ratingRefs } = await load()
  const node = fakeNode({})
  const notFound = async () => ({ status: 404, redirected: false, headers: { get: () => null }, body: { cancel: async () => {} } })
  t.alike(await search(node.request, Q, { peekSlots: slots, index: { fetch: notFound } }), { off: true }, 'through the real index client')
  t.alike(await byAuthor(node.request, A, null, { peekSlots: slots, index: { fetch: notFound } }), { off: true })
  t.alike(await ratingRefs(A, null, { index: { fetch: notFound } }), { off: true })
  t.alike(await search(node.request, Q, deps({ ok: false, reason: 'network' })), { ok: false, reason: 'network' })
  t.alike(await search(node.request, { uf: 'sp', cityKey: 'campinas' }, { peekSlots: slots }), { ok: false, reason: 'invalid-input' })
  t.is(node.calls.length, 0)
})

test('the core node refusal to read on demand reaches the caller', async (t) => {
  const { search } = await load()
  const err = Object.assign(new Error('leitura sob demanda só na versão web'), { code: 'USAGE' })
  const node = fakeNode({}, { fail: err })
  try {
    await search(node.request, Q, deps(answer([item(A + ':5')])))
    t.fail('should throw')
  } catch (e) {
    t.is(e, err)
  }
})

test('planPeeks: at most 32 strictly ascending seqs per call, an item never split', async (t) => {
  const { planPeeks, PEEK_SEQS_MAX } = await load()
  const items = Array.from({ length: 30 }, (_, i) => ({ author: A, seq: 10 + i * 3, editSeq: 11 + i * 3, statusSeq: 12 + i * 3 }))
  items.push({ author: B, seq: 4, editSeq: null, statusSeq: null })
  const plan = planPeeks(items, { [A]: hint })
  for (const p of plan) {
    t.ok(p.seqs.length <= PEEK_SEQS_MAX)
    t.ok(p.seqs.every((s, i) => i === 0 || s > p.seqs[i - 1]), 'ascending')
  }
  const forA = plan.filter((p) => p.author === A)
  t.is(forA.reduce((n, p) => n + p.seqs.length, 0), 90)
  for (const it of items.filter((x) => x.author === A)) {
    t.is(forA.filter((p) => p.seqs.includes(it.seq) && p.seqs.includes(it.editSeq) && p.seqs.includes(it.statusSeq)).length, 1)
  }
  t.is(forA[0].profileSeq, 1, 'hints on the first call')
  t.absent('profileSeq' in forA[1], 'not repeated')
  t.alike(plan.find((p) => p.author === B), { author: B, seqs: [4] })
})

test('ratings shows only rows the node verified, about this listing', async (t) => {
  const { ratings } = await load()
  const R2 = '12'.repeat(32)
  const R3 = '34'.repeat(32)
  const good = { rater: R, seq: 40, listingSeq: 5, stars: 5, text: 'Ótimo‮', at: AT }
  const node = fakeNode({}, {
    ratings: {
      items: [
        good,
        { rater: R2, seq: 41, listingSeq: 6, stars: 4, text: 'outro anúncio', at: AT },
        { rater: R3, seq: 99, listingSeq: 5, stars: 1, text: 'não pedido', at: AT },
        { rater: A, seq: 42, listingSeq: 5, stars: 5, text: 'eu mesmo', at: AT },
        { rater: R2, seq: 41, listingSeq: 5, stars: 9, text: 'estrelas', at: AT }
      ],
      dropped: 2,
      incomplete: true
    }
  })
  const refs = [{ rater: R, seq: 40 }, { rater: R2, seq: 41 }, { rater: A, seq: 42 }, { rater: 'x', seq: 1 }]
  const res = await ratings(node.request, { author: A, seq: 5, refs })
  t.alike(node.calls[0], { method: 'listing.ratings', params: { author: A, seq: 5, refs: [{ rater: R, seq: 40 }, { rater: R2, seq: 41 }, { rater: A, seq: 42 }] } })
  t.is(res.items.length, 1)
  t.is(res.items[0].rater, R)
  t.absent(res.items[0].text.includes('‮'), 'text through displayText')
  t.is(res.dropped, 2)
  t.is(res.incomplete, true)
  const omitted = fakeNode({}, { ratings: { items: [], dropped: 1, incomplete: false } })
  t.alike((await ratings(omitted.request, { author: A, seq: 5, refs: [{ rater: R, seq: 40 }] })).items, [], 'nothing the node omitted')
  const none = fakeNode({})
  t.alike(await ratings(none.request, { author: A, seq: 5, refs: [] }), { items: [], dropped: 0, incomplete: false })
  t.is(none.calls.length, 0, 'no call without refs')
})

test('ratingRefs turns rating hints into { rater, seq }', async (t) => {
  const { ratingRefs } = await load()
  const res = await ratingRefs(A, null, { fetchFeiraRatings: async () => ({ ok: true, value: { items: [{ ref: R + ':40' }], next: CURSOR, authors: {}, indexing: false, complete: true } }) })
  t.alike(res, { ok: true, refs: [{ rater: R, seq: 40 }], next: CURSOR })
})

test('a stale author item (status null) stays stale: no status, never disponivel, not dropped', async (t) => {
  const { byAuthor } = await load()
  const node = fakeNode({ [A]: { 5: root() } })
  const res = await byAuthor(node.request, A, null, deps(answer([item(A + ':5', { status: null })])))
  t.is(res.items.length, 1)
  const row = res.items[0]
  t.is(row.stale, true)
  t.is(row.status, null)
  t.is(row.statusLabel, null)
  t.is(res.dropped, 0)
  const fresh = await byAuthor(node.request, A, null, deps(answer([item(A + ':5')])))
  t.is(fresh.items[0].stale, false)
  t.is(fresh.items[0].status, 'disponivel')
})
