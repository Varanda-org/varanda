// The roda of a comment (roda.js): the trust gate on the signed replyTo
// chain, the seeder's order on signed data, quotes, per-page comment order,
// the two-level rows, labels and when swipe to reply is allowed.
'use strict'

const test = require('brittle')
const load = () => import('../src/roda.js')

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const D = 'dd'.repeat(32)
const T = Date.parse('2026-10-20T10:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const AT = iso(T)

const ref = (author, seq) => author + ':' + seq
const to = (r) => ({ author: r.slice(0, 64), seq: Number(r.slice(65)) })
const record = (text, replyTo, at = AT, extra = {}) => ({ type: 'post', text, at, replyTo: replyTo ? to(replyTo) : null, ...extra })
const peek = (key, entries, extra = {}) => ({ key, length: 100, entries, invalid: [], missing: [], profile: null, username: null, ...extra })
// peeked Map from { author: [[seq, record], ...] }.
const peekedOf = (byAuthor) => new Map(Object.entries(byAuthor).map(([key, list]) => [key, peek(key, list.map(([seq, rec]) => ({ seq, record: rec })))]))
const page = (...refs) => ({ items: refs.map((r) => ({ ref: r, to: 'ignored' })) })
const item = (author, seq, replyTo, at = AT, extra = {}) => ({ kind: 'post', author, seq, at, text: 't' + seq, replyTo: replyTo ? to(replyTo) : null, quote: null, media: null, preview: null, name: null, username: null, avatar: null, ...extra })
const refs = (list) => list.map((i) => ref(i.author, i.seq))

const TOP = ref(A, 1)

test('assembleRoda: a reply whose signed replyTo is outside the roda waits, never shows, and is counted on the last page', async (t) => {
  const { assembleRoda } = await load()
  const other = ref(D, 9)
  const peeked = peekedOf({
    [B]: [[1, record('direto', TOP)], [2, record('fora', other)]]
  })
  const out = assembleRoda({ top: TOP, index: page(ref(B, 1), ref(B, 2)), peeked })
  t.alike(refs(out.replies), [ref(B, 1)])
  t.alike(refs(out.waiting), [ref(B, 2)], 'not shown: its parent may still be on a later page')
  t.is(out.unavailable, 0)
  const end = assembleRoda({ top: TOP, index: page(ref(B, 1), ref(B, 2)), peeked, last: true })
  t.alike(refs(end.replies), [ref(B, 1)])
  t.alike(end.waiting, [], 'dropped on the last page')
  t.is(end.unavailable, 1, 'and counted')
})

test('assembleRoda: the last page folds every leftover waiting reply into unavailable', async (t) => {
  const { assembleRoda } = await load()
  const first = assembleRoda({
    top: TOP,
    index: page(ref(C, 1), ref(C, 2)),
    peeked: peekedOf({ [C]: [[1, record('filho', ref(B, 1))], [2, record('fora', ref(D, 9))]] })
  })
  t.is(first.waiting.length, 2)
  const end = assembleRoda({
    top: TOP,
    index: page(ref(B, 1)),
    peeked: peekedOf({ [B]: [[1, record('pai', TOP)]] }),
    held: first.replies,
    waiting: first.waiting,
    last: true
  })
  t.alike(refs(end.replies).sort(), [ref(B, 1), ref(C, 1)].sort(), 'a waiting reply whose parent came on the last page joins')
  t.alike(end.waiting, [])
  t.is(end.unavailable, 1, 'the one whose parent never came')
})

test('assembleRoda: waiting is capped at RODA_WAIT_MAX, the overflow is counted', async (t) => {
  const { assembleRoda, RODA_WAIT_MAX } = await load()
  t.is(RODA_WAIT_MAX, 1000)
  const orphans = []
  for (let i = 1; i <= RODA_WAIT_MAX + 30; i++) orphans.push(item(C, i, ref(D, 9)))
  const out = assembleRoda({ top: TOP, index: page(), peeked: new Map(), waiting: orphans })
  t.is(out.waiting.length, RODA_WAIT_MAX)
  t.is(out.unavailable, 30)
  t.alike(refs(out.waiting), refs(orphans.slice(0, RODA_WAIT_MAX)), 'the oldest waiting are the ones kept')
  const again = assembleRoda({
    top: TOP,
    index: page(ref(B, 1)),
    peeked: peekedOf({ [B]: [[1, record('fora', ref(D, 8))]] }),
    waiting: out.waiting
  })
  t.is(again.waiting.length, RODA_WAIT_MAX, 'a later page never grows it past the cap')
  t.is(again.unavailable, 1)
})

test('assembleRoda: a held reply whose re-listed peek fails is shown and not counted', async (t) => {
  const { assembleRoda } = await load()
  const held = [item(B, 1, TOP)]
  const out = assembleRoda({ top: TOP, index: page(ref(B, 1), ref(C, 1)), peeked: new Map(), held })
  t.alike(refs(out.replies), [ref(B, 1)], 'the held copy stays')
  t.is(out.unavailable, 1, 'only the ref never kept counts')
  const own = assembleRoda({ top: TOP, index: page(ref(D, 7)), peeked: new Map(), own: [item(D, 7, TOP)] })
  t.alike(refs(own.replies), [ref(D, 7)])
  t.is(own.unavailable, 0, 'an own reply is not counted either')
})

test('assembleRoda: a lying index `to` changes nothing', async (t) => {
  const { assembleRoda } = await load()
  const other = ref(D, 9)
  const peeked = peekedOf({ [B]: [[1, record('fora', other)], [2, record('dentro', TOP)]] })
  const index = { items: [{ ref: ref(B, 1), to: TOP }, { ref: ref(B, 2), to: other }], top: TOP }
  const out = assembleRoda({ top: TOP, index, peeked })
  t.alike(refs(out.replies), [ref(B, 2)], 'only the signed link decides')
  t.alike(refs(out.waiting), [ref(B, 1)])
})

test('assembleRoda: unreadable, non-post, root and duplicate refs', async (t) => {
  const { assembleRoda } = await load()
  const peeked = peekedOf({
    [B]: [[1, record('direto', TOP)], [2, { type: 'like', at: AT, to: to(TOP) }], [3, record('raiz', null)]],
    [A]: [[1, record('topo', ref(D, 1))]]
  })
  const out = assembleRoda({ top: TOP, index: page(ref(B, 1), ref(B, 1), ref(B, 2), ref(B, 3), ref(B, 4), 'bad', TOP), peeked })
  t.alike(refs(out.replies), [ref(B, 1)])
  t.is(out.unavailable, 5, 'not a post, not a reply, not peeked, malformed, the top itself; the duplicate is ignored')
  t.alike(assembleRoda({ top: 'bad', index: page(ref(B, 1)), peeked }), { replies: [], waiting: [], unavailable: 0 })
  t.alike(assembleRoda(), { replies: [], waiting: [], unavailable: 0 })
})

test('assembleRoda: a child listed before its parent is accepted by the fixpoint', async (t) => {
  const { assembleRoda } = await load()
  const peeked = peekedOf({
    [B]: [[1, record('pai', TOP)]],
    [C]: [[1, record('filho', ref(B, 1))], [2, record('neto', ref(C, 1))]]
  })
  const out = assembleRoda({ top: TOP, index: page(ref(C, 2), ref(C, 1), ref(B, 1)), peeked })
  t.alike(refs(out.replies).sort(), [ref(B, 1), ref(C, 1), ref(C, 2)].sort())
  t.is(out.waiting.length, 0)
})

test('assembleRoda: a reply whose parent is on a later page waits, then joins once its parent is held', async (t) => {
  const { assembleRoda } = await load()
  const peeked1 = peekedOf({ [C]: [[1, record('filho', ref(B, 1))]] })
  const first = assembleRoda({ top: TOP, index: page(ref(C, 1)), peeked: peeked1 })
  t.is(first.replies.length, 0)
  t.alike(refs(first.waiting), [ref(C, 1)])
  const peeked2 = peekedOf({ [B]: [[1, record('pai', TOP)]] })
  const second = assembleRoda({ top: TOP, index: page(ref(B, 1)), peeked: peeked2, held: first.replies, waiting: first.waiting })
  t.alike(refs(second.replies).sort(), [ref(B, 1), ref(C, 1)].sort())
  t.is(second.waiting.length, 0)
  const third = assembleRoda({ top: TOP, index: page(), peeked: new Map(), held: second.replies })
  t.alike(refs(third.replies).sort(), [ref(B, 1), ref(C, 1)].sort(), 'held items stay')
})

test('assembleRoda: held replies under a dropped parent leave with it', async (t) => {
  const { assembleRoda } = await load()
  const held = [item(C, 1, ref(B, 1)), item(C, 2, ref(C, 1)), item(D, 1, TOP)]
  const out = assembleRoda({ top: TOP, index: page(), peeked: new Map(), held })
  t.alike(refs(out.replies), [ref(D, 1)])
  t.is(out.waiting.length, 0, 'a held orphan is dropped, not retried')
})

test('assembleRoda: an own just-sent deep reply joins under a held parent', async (t) => {
  const { assembleRoda } = await load()
  const held = [item(B, 1, TOP), item(C, 1, ref(B, 1))]
  const own = [item(D, 7, ref(C, 1)), item(D, 8, ref(D, 1))]
  const out = assembleRoda({ top: TOP, index: page(), peeked: new Map(), held, own })
  t.alike(refs(out.replies), [ref(B, 1), ref(C, 1), ref(D, 7)])
  t.alike(refs(out.waiting), [ref(D, 8)], 'an own reply whose parent is unknown waits')
  const listed = assembleRoda({
    top: TOP,
    index: page(ref(D, 7)),
    peeked: peekedOf({ [D]: [[7, record('meu', ref(C, 1))]] }),
    held,
    own: [item(D, 7, ref(C, 1))]
  })
  t.is(listed.replies.length, 3, 'no duplicate once the index lists it')
  t.is(listed.replies[2].text, 'meu', 'the verified copy replaces the optimistic one')
})

test('assembleRoda: cyclic input terminates and never joins', async (t) => {
  const { assembleRoda } = await load()
  const peeked = peekedOf({
    [B]: [[1, record('b', ref(C, 1))], [2, record('self', ref(B, 2))]],
    [C]: [[1, record('c', ref(B, 1))]]
  })
  const out = assembleRoda({ top: TOP, index: page(ref(B, 1), ref(C, 1), ref(B, 2)), peeked })
  t.is(out.replies.length, 0)
  t.is(out.waiting.length, 3)
})

// The seeder's rule (packages/core/lib/engagement-index.js roda and
// compareEdges), restated: eff = atMs for a direct reply to top, else
// max(atMs, eff(parent) + 1); atMs is 0 when unparseable or not after the
// epoch; order by eff, then author, then seq.
function seederOrder (items, top) {
  const byRef = new Map(items.map((i) => [ref(i.author, i.seq), i]))
  const atMs = (i) => { const ms = Date.parse(i.at); return Number.isFinite(ms) && ms > 0 ? ms : 0 }
  const eff = (i) => {
    const p = ref(i.replyTo.author, i.replyTo.seq)
    return p === top ? atMs(i) : Math.max(atMs(i), eff(byRef.get(p)) + 1)
  }
  return items
    .map((i) => ({ i, k: eff(i) }))
    .sort((x, y) => x.k - y.k || (x.i.author < y.i.author ? -1 : x.i.author > y.i.author ? 1 : 0) || x.i.seq - y.i.seq)
    .map((x) => ref(x.i.author, x.i.seq))
}

test('rodaOrder: skewed clocks keep parent before child and match the seeder order', async (t) => {
  const { rodaOrder } = await load()
  const r1 = item(B, 1, TOP, iso(T + 10000))
  const r2 = item(C, 1, ref(B, 1), iso(T + 5000)) // dated before its parent
  const r3 = item(A, 2, TOP, iso(T + 10000)) // same instant as r1, author A first
  const r4 = item(B, 2, ref(C, 1), iso(T - 100000)) // far in the past
  const r5 = item(C, 2, TOP, iso(T + 10001))
  const r6 = item(A, 3, ref(A, 2), '1960-01-01T00:00:00.000Z') // before the epoch: 0
  const input = [r4, r2, r6, r5, r1, r3]
  // Fixture: the page order /index/roda answered for these records
  // (engagement-index.js roda on the same posts).
  const fixture = [ref(A, 2), ref(B, 1), ref(A, 3), ref(C, 1), ref(C, 2), ref(B, 2)]
  t.alike(seederOrder(input, TOP), fixture, 'the stated rule gives the fixture')
  const out = refs(rodaOrder(input, TOP))
  t.alike(out, fixture)
  for (const i of input) {
    const p = ref(i.replyTo.author, i.replyTo.seq)
    if (p !== TOP) t.ok(out.indexOf(p) < out.indexOf(ref(i.author, i.seq)), 'parent first: ' + p.slice(0, 2))
  }
  t.alike(refs(rodaOrder([...input].reverse(), TOP)), fixture, 'independent of input order')
})

test('rodaOrder: dates before the epoch count as 0, then author decides', async (t) => {
  const { rodaOrder } = await load()
  const a = item(A, 5, TOP, '1969-06-01T00:00:00.000Z')
  const b = item(B, 1, TOP, '1950-01-01T00:00:00.000Z')
  t.alike(refs(rodaOrder([b, a], TOP)), [ref(A, 5), ref(B, 1)], 'unclamped, B (1950) would come first')
})

test('rodaOrder: an appended page never moves rows already shown', async (t) => {
  const { rodaOrder } = await load()
  const first = [item(B, 1, TOP, iso(T)), item(C, 1, ref(B, 1), iso(T + 1000))]
  const later = [item(D, 1, TOP, iso(T + 5000)), item(C, 2, ref(C, 1), iso(T - 9000))]
  const shown = refs(rodaOrder(first, TOP))
  const after = refs(rodaOrder([...first, ...later], TOP))
  t.alike(after.slice(0, shown.length), shown)
})

test('rodaOrder: duplicates, malformed items, cycles and long chains', async (t) => {
  const { rodaOrder } = await load()
  const a = item(B, 1, ref(C, 1), iso(T + 50))
  const b = item(C, 1, ref(B, 1), iso(T))
  const out = rodaOrder([a, b, a, null, { author: 'x' }, item(A, 1, null)], TOP)
  t.alike(refs(out), [ref(C, 1), ref(B, 1)], 'a cycle terminates; the top itself is dropped')
  const chain = []
  let parent = TOP
  for (let i = 1; i <= 3000; i++) {
    chain.push(item(B, i, parent, iso(T - i)))
    parent = ref(B, i)
  }
  const long = rodaOrder(chain.slice().reverse(), TOP)
  t.alike(refs(long), refs(chain), 'a deep chain keeps its order without recursion')
  t.alike(rodaOrder(null, TOP), [])
})

test('rodaQuote: null for a direct reply to top, missing for an absent target', async (t) => {
  const { rodaQuote } = await load()
  const parent = item(B, 1, TOP, AT, { name: 'Bia', username: 'bia', text: 'oi' })
  const byRef = new Map([[ref(B, 1), parent]])
  t.is(rodaQuote(parent, TOP, byRef), null)
  t.alike(rodaQuote(item(C, 1, ref(B, 1)), TOP, byRef), { ref: ref(B, 1), author: B, name: 'Bia', username: 'bia', text: 'oi' })
  t.alike(rodaQuote(item(C, 2, ref(D, 4)), TOP, byRef), { ref: ref(D, 4), missing: true })
  t.alike(rodaQuote(item(C, 3, ref(B, 1)), TOP, { [ref(B, 1)]: parent }).ref, ref(B, 1), 'a plain object index works too')
  t.alike(rodaQuote(item(C, 4, ref(B, 1)), TOP, new Map([[ref(B, 1), item(D, 1, TOP)]])), { ref: ref(B, 1), missing: true }, 'a mismatched entry is missing')
  t.is(rodaQuote(item(C, 5, null), TOP, byRef), null)
})

test('commentOrder: own and followed first, each group oldest first, within one page', async (t) => {
  const { commentOrder } = await load()
  const p = [
    item(C, 1, TOP, iso(T + 3)),
    item(B, 1, TOP, iso(T + 4)),
    item(D, 1, TOP, iso(T + 1)),
    item(A, 5, TOP, iso(T + 9)),
    item(C, 2, TOP, iso(T + 2)),
    item(B, 2, TOP, iso(T + 4))
  ]
  const out = commentOrder(p, { follows: new Set([B]), ownKey: A })
  t.alike(refs(out), [ref(B, 1), ref(B, 2), ref(A, 5), ref(D, 1), ref(C, 2), ref(C, 1)])
  t.alike(refs(commentOrder([...p].reverse(), { follows: new Set([B]), ownKey: A })), refs(out), 'stable whatever the input order')
  t.alike(refs(commentOrder(p, { follows: [D] })), [ref(D, 1), ref(C, 2), ref(C, 1), ref(B, 1), ref(B, 2), ref(A, 5)], 'follows as a list')
  const next = commentOrder([item(B, 3, TOP, iso(T))], { follows: new Set([B]), ownKey: A })
  const shown = [...out, ...next]
  t.alike(refs(shown).slice(0, out.length), refs(out), 'a later page is appended, never merged into the earlier one')
  t.alike(commentOrder(null), [])
})

test('withAnchor moves the anchored comment first', async (t) => {
  const { withAnchor } = await load()
  const list = [item(B, 1, TOP), item(C, 1, TOP), item(D, 1, TOP)]
  t.alike(refs(withAnchor(list, ref(D, 1))), [ref(D, 1), ref(B, 1), ref(C, 1)])
  t.alike(refs(withAnchor(list, ref(A, 9))), refs(list))
  t.alike(refs(withAnchor(list, 'bad')), refs(list))
  t.not(withAnchor(list, ref(B, 1)), list, 'a copy')
})

test('commentRows: two levels only, quotes, author tag, more and error', async (t) => {
  const { commentRows } = await load()
  const c1 = item(B, 1, TOP)
  const c2 = item(C, 1, TOP)
  const c3 = item(D, 1, TOP)
  const r1 = item(A, 2, ref(B, 1))
  const r2 = item(C, 2, ref(A, 2), AT, { name: 'Cris' })
  const r3 = item(D, 2, ref(C, 2))
  const rows = commentRows({
    comments: [c1, c2, c3, c1],
    rodas: new Map([[ref(B, 1), [r1, r2, r3, r1]]]),
    open: { [ref(B, 1)]: true },
    counts: { [ref(B, 1)]: 1, [ref(C, 1)]: { replies: 2 }, [ref(D, 1)]: 0 },
    totals: { [ref(B, 1)]: 3 },
    more: { [ref(B, 1)]: true },
    errors: new Map([[ref(B, 1), 'falhou']]),
    postAuthor: A
  })
  t.alike(rows.map((r) => r.kind), ['comment', 'toggle', 'reply', 'reply', 'reply', 'more', 'error', 'comment', 'toggle', 'comment'])
  for (const row of rows) t.ok(row.depth === undefined || row.depth <= 1, 'depth at most 1: ' + row.key)
  for (const row of rows) t.ok(['comment', 'toggle', 'reply', 'more', 'error'].includes(row.kind))
  t.is(new Set(rows.map((r) => r.key)).size, rows.length, 'unique keys')
  const replies = rows.filter((r) => r.kind === 'reply')
  t.is(replies[0].quote, null, 'a direct reply to the comment has no quote')
  t.is(replies[0].isAuthor, true, 'by the root author')
  t.is(replies[1].quote.ref, ref(A, 2))
  t.alike({ ...replies[2].quote }, { ref: ref(C, 2), author: C, name: 'Cris', username: null, text: 't2' })
  t.is(replies[1].isAuthor, false)
  t.is(rows[1].label, 'Ocultar respostas')
  t.is(rows[8].label, 'Ver 2 respostas', 'the direct count is the floor before loading')
  t.is(rows[8].open, false)
})

test('commentRows: the label uses the loaded total over the direct-count floor', async (t) => {
  const { commentRows, rodaLabel } = await load()
  const c = item(B, 1, TOP)
  const base = { comments: [c], counts: { [ref(B, 1)]: 2 } }
  t.is(commentRows(base)[1].label, 'Ver 2 respostas')
  t.is(commentRows({ ...base, totals: { [ref(B, 1)]: 7 } })[1].label, 'Ver 7 respostas')
  t.is(commentRows({ ...base, counts: { [ref(B, 1)]: null } })[1].label, 'Ver respostas', 'flagged but unknown')
  t.is(commentRows({ comments: [c] }).length, 1, 'no count, no toggle')
  t.is(commentRows({ comments: [c], counts: { [ref(B, 1)]: 0 } }).length, 1, 'zero replies, no toggle')
  const own = commentRows({ comments: [c], counts: { [ref(B, 1)]: 0 }, rodas: { [ref(B, 1)]: [item(D, 1, ref(B, 1))] } })
  t.is(own[1].label, 'Ver 1 resposta', 'an own reply not counted yet still shows')
  t.is(rodaLabel(1, false), 'Ver 1 resposta')
  t.is(rodaLabel(4, true), 'Ocultar respostas')
})

test('AUTHOR_TAG', async (t) => {
  const { AUTHOR_TAG } = await load()
  t.is(AUTHOR_TAG, 'quem publicou')
})

test('canSwipeReply', async (t) => {
  const { canSwipeReply } = await load()
  const photo = { core: 'cd'.repeat(32), mime: 'image/jpeg' }
  const music = { url: 'https://audius.co/artista/faixa#varanda-musica=t:abc123', host: 'audius.co', title: 'Faixa', desc: '', image: null }
  const link = { url: 'https://example.com/a', host: 'example.com', title: 'Título', desc: '', image: null }
  t.is(canSwipeReply(item(B, 1, TOP)), true)
  t.is(canSwipeReply(item(B, 1, TOP, AT, { media: [photo] })), true, 'one photo is not a pager')
  t.is(canSwipeReply(item(B, 1, TOP, AT, { media: [photo, photo] })), false, 'a carousel takes horizontal drags')
  t.is(canSwipeReply(item(B, 1, TOP, AT, { preview: music })), false, 'the music scrubber takes horizontal drags')
  t.is(canSwipeReply(item(B, 1, TOP, AT, { preview: music, media: [photo] })), true, 'with media the player is not drawn')
  t.is(canSwipeReply(item(B, 1, TOP, AT, { preview: link })), true)
  t.is(canSwipeReply({ ...item(B, 1, TOP), seq: undefined }), false, 'still being sent')
  t.is(canSwipeReply(null), false)
})
