'use strict'

const test = require('brittle')
const load = () => import('../src/topicPage.js')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const NOW = Date.parse('2026-10-26T12:00:00.000Z')
const AT = '2026-10-25T12:00:00.000Z'

// A stand-in for hashtags.js: the tag counts only with its '#' and as a whole
// word. The model must treat any hasTag the same way, so the exact rule here
// does not matter beyond the '#'.
const hasTag = (text, token) => new RegExp('(^|[^a-z0-9#])#' + token + '($|[^a-z0-9])', 'i').test(text)

const post = (seq, text, at = AT, extra = {}) => ({ seq, record: { type: 'post', text, at, replyTo: null, ...extra } })
const peekMap = (...peeks) => new Map(peeks.map((p) => [p.key, p]))
const peekOf = (key, entries) => ({ key, entries })
const page = (items, next = null, extra = {}) => ({ items, next, authors: {}, indexing: false, complete: true, ...extra })
const ref = (author, seq) => author + ':' + seq

test('topicPath takes exactly one word, with or without the #', async (t) => {
  const { topicPath } = await load()
  t.alike(topicPath('#Céu'), { token: 'ceu', path: 'ceu' })
  t.alike(topicPath('ceu'), { token: 'ceu', path: 'ceu' })
  t.is(topicPath('boa noite'), null)
  t.is(topicPath('#'), null)
  t.is(topicPath(''), null)
  t.is(topicPath(42), null)
})

test('topicPath never takes one word out of several or out of a longer run', async (t) => {
  const { topicPath } = await load()
  for (const bad of ['a b ceu', 'x#ceu', 'ce-u', '#straße', '#日本ab', '##ceu', ' ceu', 'ceu ', '#a', 'x'.repeat(33)]) {
    t.is(topicPath(bad), null, bad)
  }
  t.alike(topicPath('#P\u0303o'), { token: 'po', path: 'po' }, 'a decomposed accent still folds away')
})

test('a forged index hit (the verified text lacks the tag) is dropped', async (t) => {
  const { assembleTopic } = await load()
  const peeked = peekMap(peekOf(A, [post(1, 'um dia de #ceu aberto'), post(2, 'nada a ver com o assunto')]))
  const got = assembleTopic({ refs: [ref(A, 1), ref(A, 2)], peeked, token: 'ceu', hasTag, now: NOW })
  t.alike(got.items.map((i) => i.seq), [1])
  t.is(got.rejected, 1)
  t.is(got.missing, 0)
})

test('the bare word without the # is dropped', async (t) => {
  const { assembleTopic } = await load()
  const peeked = peekMap(peekOf(A, [post(1, 'o ceu esta azul'), post(2, 'ceu'), post(3, 'o #ceu esta azul')]))
  const got = assembleTopic({ refs: [ref(A, 1), ref(A, 2), ref(A, 3)], peeked, token: 'ceu', hasTag, now: NOW })
  t.alike(got.items.map((i) => i.seq), [3])
  t.is(got.rejected, 2)
})

test('a ref the node did not return, or returned under another key, is missing; a verified repost is rejected', async (t) => {
  const { assembleTopic } = await load()
  const peeked = peekMap(
    peekOf(A, [post(1, '#ceu'), { seq: 2, record: { type: 'repost', on: true, to: { author: B, seq: 1 }, at: AT } }]),
    peekOf(B, [post(1, '#ceu')]),
    { key: C, entries: [post(1, '#ceu')] }
  )
  // The C peek is filed under B's slot: the key inside does not match.
  peeked.set(B, { key: C, entries: [post(1, '#ceu')] })
  const got = assembleTopic({ refs: [ref(A, 1), ref(A, 2), ref(A, 3), ref(B, 1), ref(C, 1)], peeked, token: 'ceu', hasTag, now: NOW })
  t.alike(got.items.map((i) => ref(i.author, i.seq)), [ref(A, 1), ref(C, 1)])
  t.is(got.missing, 2, 'the absent seq and the mismatched key')
  t.is(got.rejected, 1, 'the verified repost: the index was wrong, nothing is absent')
})

test('a hasTag that is missing, wrong or throwing fails closed', async (t) => {
  const { assembleTopic } = await load()
  const peeked = peekMap(peekOf(A, [post(1, '#ceu')]))
  const base = { refs: [ref(A, 1)], peeked, token: 'ceu', now: NOW }
  t.is(assembleTopic({ ...base }).items.length, 0)
  t.is(assembleTopic({ ...base, hasTag: () => 1 }).items.length, 0, 'only true counts')
  t.is(assembleTopic({ ...base, hasTag: () => { throw new Error('x') } }).items.length, 0)
  t.is(assembleTopic({ ...base, hasTag, token: '#ceu' }).items.length, 0, 'a token that is not folded')
  t.is(assembleTopic({ ...base, hasTag }).items.length, 1)
})

test('a future date is rejected, a small clock skew is not', async (t) => {
  const { assembleTopic } = await load()
  const soon = new Date(NOW + 60000).toISOString()
  const far = new Date(NOW + 2 * 86400000).toISOString()
  const peeked = peekMap(peekOf(A, [post(1, '#ceu', far), post(2, '#ceu', soon), post(3, '#ceu', 'not a date')]))
  const got = assembleTopic({ refs: [ref(A, 1), ref(A, 2), ref(A, 3)], peeked, token: 'ceu', hasTag, now: NOW })
  t.alike(got.items.map((i) => i.seq), [2])
  t.is(got.rejected, 2)
})

test('items sort by their own at descending, then author, then seq', async (t) => {
  const { assembleTopic } = await load()
  const late = '2026-10-25T18:00:00.000Z'
  const peeked = peekMap(
    peekOf(B, [post(1, '#ceu', AT), post(4, '#ceu', late)]),
    peekOf(A, [post(7, '#ceu', AT), post(2, '#ceu', AT), post(3, '#ceu', '2026-10-24T00:00:00.000Z')]),
    peekOf(C, [post(1, '#ceu', AT)])
  )
  const refs = [ref(C, 1), ref(B, 1), ref(A, 3), ref(A, 7), ref(B, 4), ref(A, 2)]
  const got = assembleTopic({ refs, peeked, token: 'ceu', hasTag, now: NOW })
  t.alike(got.items.map((i) => ref(i.author, i.seq)), [ref(B, 4), ref(A, 2), ref(A, 7), ref(B, 1), ref(C, 1), ref(A, 3)])
  const again = assembleTopic({ refs: refs.slice().reverse(), peeked, token: 'ceu', hasTag, now: NOW })
  t.alike(again.items, got.items, 'the index order does not matter')
})

test('a date ahead of now sorts as now: how far ahead buys no rank', async (t) => {
  const { assembleTopic, sortItems } = await load()
  const far = new Date(NOW + 20 * 3600000).toISOString()
  const near = new Date(NOW + 3600000).toISOString()
  const peeked = peekMap(peekOf(B, [post(1, '#ceu', far)]), peekOf(A, [post(1, '#ceu', near), post(2, '#ceu', new Date(NOW).toISOString())]))
  const got = assembleTopic({ refs: [ref(B, 1), ref(A, 1), ref(A, 2)], peeked, token: 'ceu', hasTag, now: NOW })
  t.alike(got.items.map((i) => ref(i.author, i.seq)), [ref(A, 1), ref(A, 2), ref(B, 1)], 'all three tie at now; author, then seq decide')
  t.is(got.rejected, 0, 'within 24 h the date is still accepted')
  const later = sortItems(got.items, NOW + 21 * 3600000)
  t.alike(later.map((i) => ref(i.author, i.seq)), [ref(B, 1), ref(A, 1), ref(A, 2)], 'once now passes the dates, they order by date again')
})

test('one action peeks at most MAX_ACTION_PEEKS refs; a cut page is read again by the next action', async (t) => {
  const { initialTopic, runAction, MAX_ACTION_PEEKS, hasMore, isIncomplete } = await load()
  t.is(MAX_ACTION_PEEKS, 30)
  const refs = Array.from({ length: 40 }, (_, i) => ref(A, i + 1))
  const asked = []
  const planned = []
  const { planTopicPeeks } = await load()
  const readPage = async (cursor, state) => {
    asked.push(cursor)
    const p = cursor === null ? page(refs, 'c1') : page([ref(B, 1)], null)
    const plan = planTopicPeeks(p, state)
    planned.push(plan.reduce((n, c) => n + c.seqs.length, 0))
    return { ok: true, page: p, peeked: new Map() }
  }
  const one = await runAction({ state: initialTopic(), readPage, token: 'ceu', hasTag, now: NOW })
  t.alike(asked, [null], 'the budget is spent on the first page')
  t.alike(planned, [30])
  t.is(one.state.peeks, 30)
  t.is(one.state.refs.length, 30, 'only the refs that fit are judged')
  t.is(one.state.next, null, 'the cursor stays at the cut page')
  t.is(one.state.atEnd, false)
  t.ok(hasMore(one.state), 'Ver mais continues')
  t.is(one.state.missing, 30, 'the judged refs that did not come back')
  t.ok(isIncomplete(one.state))
  const two = await runAction({ state: one.state, readPage, token: 'ceu', hasTag, now: NOW })
  t.alike(asked, [null, null, 'c1'], 'the cut page is read again, then the list goes on')
  t.alike(planned, [30, 10, 1], 'only the rest of the cut page is peeked')
  t.is(two.state.refs.length, 41)
  t.is(two.state.missing, 41, 'no ref is counted twice')
  t.is(two.state.atEnd, true)
})

test('the peek budget spans the pages of one action', async (t) => {
  const { initialTopic, runAction } = await load()
  const pages = [0, 1, 2, 3].map((i) => page(Array.from({ length: 20 }, (_, j) => ref(A, i * 20 + j + 1)), i === 3 ? null : String(i + 1)))
  const { readPage, asked } = scripted(pages)
  const one = await runAction({ state: initialTopic(), readPage, token: 'ceu', hasTag, now: NOW })
  t.alike(asked, [null, '1'], '20 + 10 refs: the second page is cut')
  t.is(one.state.peeks, 30)
  t.is(one.state.next, '1')
  const two = await runAction({ state: one.state, readPage, token: 'ceu', hasTag, now: NOW })
  t.alike(asked.slice(2), ['1', '2'], 'a new budget: the rest of page 1, then 20 of page 2')
  t.is(two.state.peeks, 30)
  t.is(two.state.next, '3')
  t.is(two.state.refs.length, 60)
})

test('planTopicPeeks takes only what is left of the action budget', async (t) => {
  const { planTopicPeeks, initialTopic } = await load()
  const p = page(Array.from({ length: 10 }, (_, i) => ref(A, i + 1)))
  const count = (plan) => plan.reduce((n, c) => n + c.seqs.length, 0)
  t.is(count(planTopicPeeks(p, { ...initialTopic(), peeks: 25 })), 5)
  t.is(count(planTopicPeeks(p, { ...initialTopic(), peeks: 30 })), 0)
  t.is(count(planTopicPeeks(p, initialTopic())), 10)
})

test('planTopicPeeks groups the page refs by author with the index hints', async (t) => {
  const { planTopicPeeks } = await load()
  const plan = planTopicPeeks({ items: [ref(A, 3), ref(A, 1), ref(B, 2), 'junk'], authors: { [A]: { profileSeq: 1, usernameSeq: 2 } } })
  t.alike(plan, [{ author: A, seqs: [1, 3], profileSeq: 1, usernameSeq: 2 }, { author: B, seqs: [2] }])
  t.alike(planTopicPeeks(null), [])
})

test('planTopicPeeks skips refs already judged on an earlier page', async (t) => {
  const { planTopicPeeks, initialTopic } = await load()
  const state = { ...initialTopic(), refs: [ref(A, 1), ref(B, 2)] }
  t.alike(planTopicPeeks({ items: [ref(A, 1), ref(A, 3), ref(B, 2)], authors: {} }, state), [{ author: A, seqs: [3] }])
  t.alike(planTopicPeeks({ items: [ref(A, 1), ref(B, 2)], authors: {} }, state), [], 'nothing new: nothing to peek')
})

test('dropBlocked removes the refs of blocked authors before they are peeked or counted', async (t) => {
  const { dropBlocked, initialTopic, foldPage, isIncomplete } = await load()
  const p = page([ref(A, 1), ref(B, 1), 'junk'], null)
  const kept = dropBlocked(p, (author) => author === B)
  t.alike(kept.items, [ref(A, 1), 'junk'])
  t.is(p.items.length, 3, 'the input page is not changed')
  const s = foldPage(initialTopic(), { page: kept, peeked: peekMap(peekOf(A, [post(1, '#ceu')])), token: 'ceu', hasTag, now: NOW, cursor: null })
  t.is(s.missing, 0, 'a blocked author does not count as missing')
  t.absent(isIncomplete(s))
  t.is(dropBlocked(p, null), p)
  t.is(dropBlocked(null, () => true), null)
})

test('foldPage merges pages, dedupes, and only a null cursor ends the list', async (t) => {
  const { initialTopic, foldPage, hasMore } = await load()
  const first = foldPage(initialTopic(), {
    page: page([ref(A, 1), ref(A, 2)], 'c1'),
    peeked: peekMap(peekOf(A, [post(1, 'sem tag'), post(2, 'sem tag nenhuma')])),
    token: 'ceu',
    hasTag,
    now: NOW,
    cursor: null
  })
  t.is(first.items.length, 0, 'every hit was forged')
  t.is(first.next, 'c1')
  t.is(first.atEnd, false, 'an empty page with a cursor does not end the list')
  t.ok(hasMore(first))
  const second = foldPage(first, {
    page: page([ref(A, 2), ref(B, 1)], null),
    peeked: peekMap(peekOf(B, [post(1, '#ceu')])),
    token: 'ceu',
    hasTag,
    now: NOW,
    cursor: 'c1'
  })
  t.alike(second.refs, [ref(A, 1), ref(A, 2), ref(B, 1)], 'a repeated ref is kept once')
  t.alike(second.items.map((i) => i.seq), [1])
  t.is(second.rejected, 2, 'the repeated ref is not judged twice')
  t.is(second.atEnd, true)
  t.absent(hasMore(second))
  t.is(first.refs.length, 2, 'the previous state is not mutated')
})

test('a repeated cursor ends the list as a failure, not a loop', async (t) => {
  const { initialTopic, foldPage, isIncomplete } = await load()
  const s = foldPage(initialTopic(), { page: page([], 'c1'), peeked: new Map(), token: 'ceu', hasTag, now: NOW, cursor: 'c1' })
  t.is(s.atEnd, true)
  t.is(s.stuck, true)
  t.ok(isIncomplete(s))
})

test('a cursor cycle of any length (A, B, A) ends the list as a failure', async (t) => {
  const { initialTopic, runAction, hasMore, isIncomplete } = await load()
  const asked = []
  const next = { null: 'A', A: 'B', B: 'A' }
  const readPage = async (cursor) => {
    asked.push(cursor)
    return { ok: true, page: page([ref(A, asked.length)], next[String(cursor)]), peeked: new Map() }
  }
  const one = await runAction({ state: initialTopic(), readPage, token: 'ceu', hasTag, now: NOW })
  t.alike(asked, [null, 'A', 'B'])
  t.is(one.state.stuck, true, 'B points back to A, already requested')
  t.absent(hasMore(one.state))
  t.ok(isIncomplete(one.state))
  await runAction({ state: one.state, readPage, token: 'ceu', hasTag, now: NOW })
  t.is(asked.length, 3, 'no further read')
})

test('incomplete is honest: partial or indexing index, unreadable posts, but not forged hits', async (t) => {
  const { initialTopic, foldPage, isIncomplete } = await load()
  const fold = (p, peeked) => foldPage(initialTopic(), { page: p, peeked, token: 'ceu', hasTag, now: NOW, cursor: null })
  const ok = peekMap(peekOf(A, [post(1, '#ceu')]))
  t.absent(isIncomplete(fold(page([ref(A, 1)]), ok)), 'a complete page of verified posts')
  t.ok(isIncomplete(fold(page([ref(A, 1)], null, { complete: false }), ok)), 'the seeder says partial')
  t.ok(isIncomplete(fold(page([ref(A, 1)], null, { indexing: true }), ok)), 'the seeder is still indexing')
  t.ok(isIncomplete(fold(page([ref(A, 1), ref(B, 1)]), ok)), 'a listed post could not be read')
  const forged = fold(page([ref(A, 1), ref(A, 2)]), peekMap(peekOf(A, [post(1, '#ceu'), post(2, 'sem tag')])))
  t.absent(isIncomplete(forged), 'a hit the node proved wrong hides nothing')
  const later = foldPage(fold(page([ref(A, 1)], 'c1', { complete: false }), ok), { page: page([], null), peeked: new Map(), token: 'ceu', hasTag, now: NOW, cursor: 'c1' })
  t.ok(isIncomplete(later), 'incomplete sticks across pages')
})

// A reader over a scripted list of pages; every page lists one hit that does
// not verify, so no action finds anything on its own.
function scripted (pages) {
  const asked = []
  const readPage = async (cursor) => {
    asked.push(cursor)
    const i = cursor === null ? 0 : Number(cursor)
    const p = pages[i]
    if (p instanceof Error) return { ok: false, reason: 'network' }
    return { ok: true, page: p, peeked: peekMap(peekOf(A, [post(i + 1, 'sem tag')])) }
  }
  return { readPage, asked }
}

test('one action reads at most 3 index pages, and the next action continues', async (t) => {
  const { initialTopic, runAction, MAX_INDEX_PAGES, hasMore } = await load()
  t.is(MAX_INDEX_PAGES, 3)
  const pages = [0, 1, 2, 3, 4, 5, 6].map((i) => page([ref(A, i + 1)], i === 6 ? null : String(i + 1)))
  const { readPage, asked } = scripted(pages)
  const args = { readPage, token: 'ceu', hasTag, now: NOW }
  const one = await runAction({ ...args, state: initialTopic() })
  t.is(one.error, null)
  t.alike(asked, [null, '1', '2'])
  t.is(one.state.pages, 3)
  t.is(one.state.next, '3')
  t.ok(hasMore(one.state), 'there is more: only the action budget ended')
  const two = await runAction({ ...args, state: one.state })
  t.alike(asked.slice(3), ['3', '4', '5'], 'a new action gets a new budget and resumes at the cursor')
  const three = await runAction({ ...args, state: two.state })
  t.alike(asked.slice(6), ['6'], 'it stops early at the end of the list')
  t.is(three.state.atEnd, true)
  t.is(three.state.refs.length, 7)
  const none = await runAction({ ...args, state: three.state })
  t.is(asked.length, 7, 'nothing is read after the end')
  t.is(none.state.atEnd, true)
})

test('an action stops as soon as a page shows a post', async (t) => {
  const { initialTopic, runAction } = await load()
  const asked = []
  const readPage = async (cursor) => {
    asked.push(cursor)
    return cursor === null
      ? { ok: true, page: page([ref(A, 1)], 'c1'), peeked: peekMap(peekOf(A, [post(1, 'sem tag')])) }
      : { ok: true, page: page([ref(B, 1)], 'c2'), peeked: peekMap(peekOf(B, [post(1, 'ola #ceu')])) }
  }
  const { state } = await runAction({ state: initialTopic(), readPage, token: 'ceu', hasTag, now: NOW })
  t.alike(asked, [null, 'c1'])
  t.alike(state.items.map((i) => i.author), [B])
  t.is(state.next, 'c2')
})

test('a failed read keeps what was folded and the cursor to retry, and a superseded action returns null', async (t) => {
  const { initialTopic, runAction } = await load()
  const pages = [page([ref(A, 1)], '1'), new Error('x')]
  const { readPage } = scripted(pages)
  const res = await runAction({ state: initialTopic(), readPage, token: 'ceu', hasTag, now: NOW })
  t.is(res.error, 'network')
  t.is(res.state.pages, 1)
  t.is(res.state.next, '1')
  t.is(res.state.atEnd, false)
  const thrown = await runAction({ state: initialTopic(), readPage: async () => { throw new Error('boom') }, token: 'ceu', hasTag, now: NOW })
  t.is(thrown.error, 'error')
  const stale = await runAction({ state: initialTopic(), readPage, token: 'ceu', hasTag, now: NOW, alive: () => false })
  t.is(stale, null)
})

test('a malformed page is a failed read, never a throw', async (t) => {
  const { initialTopic, runAction } = await load()
  for (const bad of [undefined, null, 'x', 7, { items: [], next: 3 }, { items: [] }]) {
    const res = await runAction({ state: initialTopic(), readPage: async () => ({ ok: true, page: bad, peeked: new Map() }), token: 'ceu', hasTag, now: NOW })
    t.is(res.error, 'error', JSON.stringify(bad))
    t.is(res.state.pages, 0)
  }
})

test('readPage gets the state, so it can skip refs already judged', async (t) => {
  const { initialTopic, runAction } = await load()
  const seen = []
  const readPage = async (cursor, state) => {
    seen.push(state.refs.slice())
    return { ok: true, page: page([ref(A, seen.length)], seen.length < 2 ? 'c' + seen.length : null), peeked: new Map() }
  }
  await runAction({ state: initialTopic(), readPage, token: 'ceu', hasTag, now: NOW })
  t.alike(seen, [[], [ref(A, 1)]])
})

test('refreshFailed: only a refresh that folded no page keeps the old list', async (t) => {
  const { refreshFailed, initialTopic } = await load()
  const none = { state: initialTopic(), error: 'x' }
  const some = { state: { ...initialTopic(), pages: 1 }, error: 'x' }
  t.ok(refreshFailed(true, none))
  t.absent(refreshFailed(false, none), 'a "ver mais" keeps its own state anyway')
  t.absent(refreshFailed(true, some), 'a page was folded: the new list replaces the old')
  t.absent(refreshFailed(true, { state: initialTopic(), error: null }))
  t.absent(refreshFailed(true, null))
})
