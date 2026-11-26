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
  t.is(isLastPeekPage({ items: [], next: 'cursor', incomplete: true }), false, 'an incomplete empty page goes on')
  t.is(isLastPeekPage({ items: [], next: null, incomplete: true }), true)
})

test('withoutAuthor drops every row of one author and keeps the rest in order', async (t) => {
  const { withoutAuthor } = await load()
  const items = Object.freeze([item('a', 1), item('b', 1), item('a', 2), item('c', 1)])
  t.alike(withoutAuthor(items, 'a'), [item('b', 1), item('c', 1)])
  t.alike(withoutAuthor(items, 'z'), [...items])
  t.alike(withoutAuthor([], 'a'), [])
  t.is(items.length, 4, 'the input is not changed')
})

test('a follow drops the author and a page read before it cannot bring the author back', async (t) => {
  const { recordFollow, withoutFollowed } = await load()
  const followed = new Map()
  const items = Object.freeze([item('a', 1), item('B', 1), item('c', 1)])
  t.alike(recordFollow(followed, 1, items, 'B'), [item('a', 1), item('c', 1)])
  t.is(followed.get('b'), 1, 'the author is recorded in lowercase with its stamp')
  const late = Object.freeze([item('b', 2), item('c', 2)])
  t.alike(withoutFollowed(late, followed), [item('c', 2)], 'a late page loses the author')
  t.alike(withoutFollowed(late, new Map()), [...late], 'nothing is dropped without a follow')
  recordFollow(followed, 2, items, 'b')
  t.is(followed.get('b'), 2, 'a repeated follow takes a new stamp')
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
  const { PEEK_OFFLINE_MESSAGE, PEEK_RULE_TEXT, PEEK_SHORT_TEXT } = await load()
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

test('a hidden ready tab warms after seeder verification without waiting for sync', async (t) => {
  const { shouldWarmPeek, PEEK_WARM_QUIET_MS } = await load()
  const ready = {
    hosted: true,
    online: true,
    phase: 'ready',
    seederVerified: true,
    syncReady: true,
    visible: true,
    active: false,
    loadedAt: null,
    loading: false,
    refreshing: false,
    unsupported: false,
    attempted: false
  }
  t.is(shouldWarmPeek(ready), true)
  t.is(shouldWarmPeek({ ...ready, seederVerified: false }), false, 'seederVerified')
  t.is(shouldWarmPeek({ ...ready, syncReady: false }), true, 'sync is not needed for the short link')
  t.is(shouldWarmPeek({ ...ready, visible: false }), false, 'visible')
  t.is(shouldWarmPeek({ ...ready, active: true }), false, 'active')
  t.is(shouldWarmPeek({ ...ready, loadedAt: 1 }), false, 'loadedAt')
  t.is(shouldWarmPeek({ ...ready, online: false }), false, 'online')
  t.is(shouldWarmPeek({ ...ready, hosted: false }), false, 'hosted')
  t.is(shouldWarmPeek({ ...ready, phase: 'connecting' }), false, 'phase')
  t.is(shouldWarmPeek({ ...ready, loading: true }), false, 'loading')
  t.is(shouldWarmPeek({ ...ready, refreshing: true }), false, 'refreshing')
  t.is(shouldWarmPeek({ ...ready, unsupported: true }), false, 'unsupported')
  t.is(shouldWarmPeek({ ...ready, attempted: true }), false, 'attempted')
  t.is(shouldWarmPeek({ ...ready, busy: true }), false, 'a refused seeder is left alone this epoch')
  t.is(PEEK_WARM_QUIET_MS, 500)
})

test('a full seeder is distinct from an in-flight read or a transport failure', async (t) => {
  const { isSeederBusyError } = await load()
  const message = 'Semeador ocupado; tente novamente em instantes.'
  t.is(isSeederBusyError({ code: 'USAGE', message }), true)
  for (const err of [null, {}, new Error(message), { code: 'USAGE', message: 'avisos já em andamento' }, { code: 'USAGE', message: 'espiadinha já em andamento' }]) {
    t.is(isSeederBusyError(err), false)
  }
})

test('warm state shares completion and refusal only within the current epoch', async (t) => {
  const { getPeekWarmState, subscribePeekWarm, updatePeekWarmState } = await load()
  const updates = []
  const unsubscribe = subscribePeekWarm(() => updates.push(getPeekWarmState()))
  updatePeekWarmState(1, { eligible: true })
  const waiting = getPeekWarmState()
  updatePeekWarmState(1, { eligible: true })
  t.is(updates.length, 1, 'unchanged eligibility does not notify again')
  updatePeekWarmState(1, { attempted: true, pending: true })
  t.is(getPeekWarmState().pending, true)
  t.is(waiting.attempted, false, 'subscribers keep stable snapshots')
  updatePeekWarmState(1, { busy: true })
  updatePeekWarmState(1, { pending: false, eligible: false })
  t.is(getPeekWarmState().busy, true, 'settling does not clear a refusal')
  updatePeekWarmState(2, { eligible: true })
  t.alike(getPeekWarmState(), { epoch: 2, eligible: true, attempted: false, pending: false, busy: false })
  const next = getPeekWarmState()
  updatePeekWarmState(1, { pending: false, busy: true })
  t.is(getPeekWarmState(), next, 'late errors and completions cannot affect the new epoch')
  unsubscribe()
  const count = updates.length
  updatePeekWarmState(2, { pending: true })
  t.is(updates.length, count, 'unmounted screens stop receiving updates')
})

// #467: a node that pages candidates in batches can end a whole read
// incomplete and empty for a person who follows nearly all of the newest
// diaries; the next read from its cursor may hold rows.
test('regression: a later page that adds nothing and is incomplete reads on from its cursor, within one load', async (t) => {
  const { readLaterPages, mergePage } = await load()
  const cursor = (n) => Object.freeze({ round: 0, at: 'c' + n, author: 'x', seq: 1 })
  const pages = [
    { items: [], next: cursor(1), incomplete: true },
    { items: [], next: cursor(1), incomplete: true },
    { items: [item('a', 1), item('b', 1)], next: cursor(2), incomplete: false }
  ]
  const asked = []
  const taken = []
  let list = []
  const last = await readLaterPages({
    after: cursor(0),
    read: async (after) => { asked.push(after); return pages[asked.length - 1] },
    take: (page, after) => {
      taken.push(after)
      const merged = mergePage(list, page.items)
      list = merged.items
      return merged.added
    }
  })
  t.is(asked.length, 3, 'two empty incomplete pages, then the one with rows')
  t.alike(asked, [cursor(0), cursor(1), cursor(1)], 'each read from the cursor the page before carried')
  t.alike(taken, asked, 'each page taken with the cursor it was read from')
  t.is(last, pages[2])
  t.alike(list.map((i) => i.author), ['a', 'b'])
})

test('readLaterPages: bounded, and it stops at a complete page, a page with rows, the end, a null take and a failed read', async (t) => {
  const { readLaterPages, followsEmptyPage, PEEK_EMPTY_FOLLOW_MAX } = await load()
  const empty = { items: [], next: 'c', incomplete: true }
  const run = async (pages, take = () => 0) => {
    let n = 0
    await readLaterPages({ after: 'c0', read: async () => pages[Math.min(n++, pages.length - 1)], take })
    return n
  }
  t.is(await run([empty]), 1 + PEEK_EMPTY_FOLLOW_MAX, 'a seeder that keeps answering empty pages costs a bounded number of reads')
  t.is(await run([{ items: [], next: 'c', incomplete: false }]), 1, 'a complete empty page is not followed')
  t.is(await run([empty, { items: [], next: null, incomplete: true }]), 2, 'a page with no cursor ends the load')
  t.is(await run([empty], () => 1), 1, 'a page that added rows ends the load')
  t.is(await run([empty], () => null), 1, 'a null take reads no further')
  let reads = 0
  const err = await readLaterPages({
    after: 'c0',
    read: async () => { if (++reads === 2) throw new Error('falhou'); return empty },
    take: () => 0
  }).then(() => null, (e) => e)
  t.is(err && err.message, 'falhou', 'a failed read reaches the caller')
  t.is(reads, 2, 'and is never asked again')
  t.is(followsEmptyPage({ page: empty, added: 0, hops: 0 }), true)
  t.is(followsEmptyPage({ page: empty, added: 0, hops: PEEK_EMPTY_FOLLOW_MAX }), false)
  t.is(followsEmptyPage({ page: empty, added: 0, hops: 0, max: 0 }), false)
})

test('a live page held over stored rows is fresh only with a row not shown', async (t) => {
  const { holdPeekPage } = await load()
  const a = item('a', 1)
  const b = item('b', 1)
  const c = item('c', 1)
  t.alike(holdPeekPage({ shown: [a, b], rows: [b, a] }), { fresh: false }, 'the same rows in another order are not news')
  t.alike(holdPeekPage({ shown: [a, b], rows: [a] }), { fresh: false }, 'a page with fewer rows is not news')
  t.alike(holdPeekPage({ shown: [a, b], rows: [c, a] }), { fresh: true })
  t.alike(holdPeekPage({ shown: [], rows: [a] }), { fresh: true })
  t.alike(holdPeekPage({ shown: [a], rows: [] }), { fresh: false })
  t.alike(holdPeekPage({ shown: [a], rows: [item('a', 2)] }), { fresh: true }, 'another seq of the same diary is a new row')
})

test('a row\'s authors cover the poster, the original, the quote and the parent', async (t) => {
  const { peekRowAuthors } = await load()
  const A = 'AA'.repeat(32)
  const B = 'bb'.repeat(32)
  const C = 'cc'.repeat(32)
  t.alike(peekRowAuthors({ author: A, seq: 1 }), ['aa'.repeat(32)], 'lowercase')
  t.alike(peekRowAuthors({ kind: 'repost', author: B, seq: 2, to: { author: C, seq: 1 } }), [B, C])
  t.alike(peekRowAuthors({ author: B, seq: 3, quote: { author: C, seq: 1 }, replyTo: null }), [B, C])
  t.alike(peekRowAuthors({ author: B, seq: 4, replyTo: { author: C, seq: 1 }, quote: null }), [B, C])
  // A malformed field stays non-string, so the block gate hides the row.
  t.alike(peekRowAuthors({ author: B, seq: 5, quote: { seq: 1 } }), [B, undefined])
  t.alike(peekRowAuthors({ author: B, seq: 6, to: 'x' }), [B, null])
  t.alike(peekRowAuthors(null), [null])
})

test('the block gate hides a stored row naming a blocked author anywhere', async (t) => {
  const { peekRowAuthors } = await load()
  const { cachedRowsShown } = await import('../src/cachedRows.js')
  const B = 'bb'.repeat(32)
  const C = 'cc'.repeat(32)
  const D = 'dd'.repeat(32)
  const rows = [
    { author: B, seq: 1 },
    { kind: 'repost', author: D, seq: 2, to: { author: C, seq: 1 } },
    { author: D, seq: 3, quote: { author: C, seq: 9 } },
    { author: D, seq: 4, replyTo: { author: C, seq: 8 } }
  ]
  const shown = (loadState, blocked) => cachedRowsShown(rows, { loadState, blocked, muted: new Set(), owner: 'aa'.repeat(32), authorsOf: peekRowAuthors }).map((r) => r.seq)
  t.alike(shown('pending', new Set()), [], 'nothing before block.list answered')
  t.alike(shown('failed', new Set()), [], 'nothing after it failed')
  t.alike(shown('ok', new Set()), [1, 2, 3, 4])
  t.alike(shown('ok', new Set([C])), [1], 'the original, the quote and the parent count')
})

test('the kept entries of stored rows name their avatar and photos under the author', async (t) => {
  const { peekKeptEntries } = await load()
  const B = 'bb'.repeat(32)
  const d = (n) => ({ core: String(n).repeat(64).slice(0, 64), mime: 'image/jpeg' })
  const rows = [
    { author: B, avatar: d(1), media: [d(2), d(3)], preview: null },
    { author: B, avatar: null, media: null, preview: { image: d(4) } },
    { kind: 'repost', author: B, avatar: null, media: null, preview: null },
    null
  ]
  t.alike(peekKeptEntries(rows), [
    { kind: 'peekAvatars', author: B, d: d(1) },
    { kind: 'peekPosts', author: B, d: d(2) },
    { kind: 'peekPosts', author: B, d: d(3) },
    { kind: 'peekPosts', author: B, d: d(4) }
  ])
  t.alike(peekKeptEntries(undefined), [])
})

test('the kept entries name a row\'s valid thumbnails, never an invalid list', async (t) => {
  const { peekKeptEntries } = await load()
  const B = 'bb'.repeat(32)
  const full = (start) => ({ core: 'a'.repeat(64), start, blocks: 2, bytes: 40000, sha256: 'b'.repeat(64), mime: 'image/jpeg', width: 1200, height: 800 })
  const thumb = { core: 'a'.repeat(64), start: 9, blocks: 1, bytes: 10000, sha256: 'c'.repeat(64), mime: 'image/jpeg', width: 640, height: 427 }
  const media = [full(1), full(3)]
  const row = { author: B, avatar: null, media, thumbs: [thumb, null], preview: null }
  t.alike(peekKeptEntries([row]), [
    { kind: 'peekPosts', author: B, d: media[0] },
    { kind: 'peekPosts', author: B, d: media[1] },
    { kind: 'peekPosts', author: B, d: thumb }
  ], 'the thumbnail is retained beside its photos')
  const big = { ...thumb, width: 641 }
  t.is(peekKeptEntries([{ ...row, thumbs: [big, null] }]).length, 2, 'a thumbnail over the limits is not named')
  t.is(peekKeptEntries([{ ...row, thumbs: [thumb] }]).length, 2, 'a list out of line with media is not named')
})

const keys = (list) => list.map((i) => i.author + ':' + i.seq)

test('a live page over stored rows replaces the list before block.list answered', async (t) => {
  const { holdLivePage } = await load()
  const stored = [item('a', 1), item('b', 1)]
  t.is(holdLivePage({ items: stored, unconfirmed: new Set(['a:1', 'b:1']), rows: [item('c', 1)], blocksOk: false }), null)
})

test('a held live page keeps every stored row, replaces confirmed ones in place and adds none', async (t) => {
  const { holdLivePage } = await load()
  const stored = [item('a', 1), item('b', 1), item('c', 1)]
  const liveB = { ...item('b', 1), text: 'novo' }
  const r = holdLivePage({ items: stored, unconfirmed: new Set(['a:1', 'b:1', 'c:1']), rows: [item('d', 1), liveB], blocksOk: true })
  t.alike(keys(r.items), ['a:1', 'b:1', 'c:1'], 'no row lost, none added, none duplicated')
  t.is(r.items[1], liveB, 'the confirmed row is the live copy')
  t.alike([...r.unconfirmed], ['a:1', 'c:1'])
  t.is(r.fresh, true)
  const all = holdLivePage({ items: stored, unconfirmed: new Set(['a:1', 'b:1', 'c:1']), rows: stored, blocksOk: true })
  t.is(all.unconfirmed, null, 'every stored row confirmed')
  t.is(all.fresh, false)
})

test('a later page confirms a stored row it returns and appends only new rows', async (t) => {
  const { appendPeekPage } = await load()
  const stored = [item('a', 1), item('b', 1)]
  const liveA = { ...item('a', 1), text: 'vivo' }
  const r = appendPeekPage({ items: stored, unconfirmed: new Set(['a:1', 'b:1']), rows: [item('c', 1), liveA, item('c', 1)] })
  t.alike(keys(r.items), ['a:1', 'b:1', 'c:1'], 'no loss, no duplicate')
  t.is(r.items[0], liveA, 'replaced in place')
  t.alike([...r.unconfirmed], ['b:1'], 'confirmed by the later page')
  t.is(r.added, 1)
  const none = appendPeekPage({ items: stored, unconfirmed: null, rows: [item('a', 1)] })
  t.is(none.unconfirmed, null)
  t.is(none.added, 0)
  const last = appendPeekPage({ items: stored, unconfirmed: new Set(['b:1']), rows: [item('b', 1)] })
  t.is(last.unconfirmed, null, 'the last stored row confirmed')
})

test('taking the held page swaps it in whole; an empty draw takes it', async (t) => {
  const { takePeekPage, takesHeldPage } = await load()
  const rows = [item('a', 1), item('b', 1), item('a', 1)]
  t.alike(takePeekPage(rows), { items: [item('a', 1), item('b', 1)], unconfirmed: null })
  t.is(takesHeldPage({ held: true, drawn: 0 }), true, 'all stored rows gated out')
  t.is(takesHeldPage({ held: true, drawn: 3 }), false)
  t.is(takesHeldPage({ held: false, drawn: 0 }), false)
})

test('unconfirmed stored rows are shown but never installed as originals', async (t) => {
  const { pageNeeds } = await load()
  const a = item('a', 1)
  const b = item('b', 1)
  const r = pageNeeds([a, b], new Set(['a:1']))
  t.alike([...r.local.keys()], ['b:1'], 'only the confirmed row is an original')
  t.alike(r.shown, ['a:1', 'b:1'])
  t.alike([...pageNeeds([a, b]).local.keys()], ['a:1', 'b:1'], 'without unconfirmed every row is local')
})

test('a save retains the saved rows\' photos and the drawn first-page rows\' photos', async (t) => {
  const { peekRetainEntries } = await load()
  const B = 'bb'.repeat(32)
  const C = 'cc'.repeat(32)
  const d = (n) => ({ core: String(n).repeat(64).slice(0, 64), mime: 'image/jpeg' })
  const saved = [{ author: B, seq: 1, avatar: d(1), media: null, preview: null }]
  const drawnFirst = { author: C, seq: 1, avatar: d(2), media: [d(3)], preview: null }
  const scrolled = { author: C, seq: 9, avatar: null, media: [d(4)], preview: null }
  const r = peekRetainEntries({ saved, drawn: [drawnFirst, scrolled], firstKeys: new Set([C + ':1']) })
  t.alike(r, [
    { kind: 'peekAvatars', author: B, d: d(1) },
    { kind: 'peekAvatars', author: C, d: d(2) },
    { kind: 'peekPosts', author: C, d: d(3) }
  ], 'on-screen first-page photos stay; scrolled rows were never kept')
  t.alike(peekRetainEntries({ saved, drawn: [drawnFirst], firstKeys: null }), [{ kind: 'peekAvatars', author: B, d: d(1) }])
})

test('Espiadinha requests thumbnails on the shared first, warm and later page path', async (t) => {
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const { compileFunction } = require('node:vm')
  const screen = readFileSync(join(__dirname, '../src/screens/Espiadinha.js'), 'utf8')
  const from = screen.indexOf('  const peek = useCallback(')
  const end = screen.indexOf('  }, [request])', from) + '  }, [request])'.length
  const calls = []
  const request = async (method, params, options) => { calls.push({ method, params, options }); return { items: [] } }
  const peek = compileFunction(screen.slice(from, end) + '\nreturn peek', ['useCallback', 'request', 'inflightRef', 'noop'])(
    (fn) => fn, request, { current: null }, () => {}
  )
  const lane = { priority: 'background', token: Symbol('warm') }
  await peek({ limit: 25 }, lane)
  await peek({ limit: 25, after: 'next' })
  t.alike(calls, [
    { method: 'peek.read', params: { limit: 25, thumbs: true }, options: lane },
    { method: 'peek.read', params: { limit: 25, after: 'next', thumbs: true }, options: undefined }
  ])
  t.is(calls[0].options, lane, 'warm priority preserved')
})
