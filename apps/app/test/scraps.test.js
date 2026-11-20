'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const load = () => import('../src/scraps.js')

const OWNER = 'a1'.repeat(32)
const ME = 'b2'.repeat(32)
const W1 = 'c3'.repeat(32)
const W2 = 'd4'.repeat(32)
const W3 = 'e5'.repeat(32)
const AT = '2026-10-25T12:00:00.000Z'
const AT2 = '2026-10-26T12:00:00.000Z'

const scrap = (to, text, extra = {}) => ({ type: 'scrap', to, text, replyTo: null, at: AT, ...extra })
const follow = (key, on = true) => ({ type: 'follow', key, on, at: AT })
const hide = (from, seq) => ({ type: 'scrap-hide', from, seq, at: AT })
const wallRec = (who) => ({ type: 'scrap-wall', who, at: AT })
const peekOf = (key, entries, extra = {}) => ({ key, entries: entries.map(([seq, record]) => ({ seq, record })), invalid: [], missing: [], ...extra })
const peeks = (...list) => new Map(list.map((p) => [p.key, p]))
const idx = (rows, extra = {}) => ({ rows, hides: [], wall: null, indexing: false, complete: true, ...extra })
const NOW = Date.parse('2026-10-27T12:00:00.000Z')

test('a followed writer shows, the rest of the checks refuse', async (t) => {
  const { assemblePage } = await load()
  const index = idx([
    { author: W1, seq: 1, followSeq: 5 },
    { author: W2, seq: 1 }, // not followed
    { author: W3, seq: 1, followSeq: 6 } // follow record names someone else
  ])
  const p = peeks(
    peekOf(W1, [[1, scrap(OWNER, 'oi')]]),
    peekOf(W2, [[1, scrap(OWNER, 'sem seguir')]]),
    peekOf(W3, [[1, scrap(OWNER, 'follow falso')]]),
    peekOf(OWNER, [[5, follow(W1)], [6, follow(W2)]])
  )
  const page = assemblePage({ index, owner: OWNER, self: ME, peeks: p })
  t.is(page.wall, 'following')
  t.alike(page.rows.map((r) => r.author), [W1])
  t.is(page.rows[0].text, 'oi')
  t.is(page.rows[0].via, 'following')
  t.is(page.rows[0].ref, W1 + ':1')
  t.is(page.incomplete, false)
  t.is(page.notice, null)
})

test('an unfollow record or a wrong follow pointer does not admit', async (t) => {
  const { assemblePage } = await load()
  const index = idx([{ author: W1, seq: 1, followSeq: 5 }])
  const off = assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(peekOf(W1, [[1, scrap(OWNER, 'x')]]), peekOf(OWNER, [[5, follow(W1, false)]])) })
  t.is(off.rows.length, 0)
  const other = assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(peekOf(W1, [[1, scrap(OWNER, 'x')]]), peekOf(OWNER, [[5, hide(W1, 1)]])) })
  t.is(other.rows.length, 0)
})

test('records are re-checked: type, shape, recipient, text, date', async (t) => {
  const { assemblePage } = await load()
  const long = 'x'.repeat(401)
  const index = idx([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({ author: W1, seq })), { wall: 9 })
  const entries = [
    [1, scrap(OWNER, 'ok')],
    [2, scrap(W2, 'para outra pessoa')],
    [3, scrap(OWNER, long)],
    [4, scrap(OWNER, '')],
    [5, { type: 'post', text: 'nao e recado', at: AT, replyTo: null }],
    [6, { ...scrap(OWNER, 'chave a mais'), extra: 1 }],
    [7, scrap(OWNER, 'data ruim', { at: '2026-10-25' })],
    [8, scrap(OWNER, 'controle ‮')]
  ]
  const p = peeks(peekOf(W1, entries), peekOf(OWNER, [[9, wallRec('everyone')]]))
  const page = assemblePage({ index, owner: OWNER, self: ME, peeks: p })
  t.alike(page.rows.map((r) => r.seq), [1])
  t.is(page.rejected, 7)
  t.is(page.wall, 'everyone')
})

test('text counts code points, 400 fits and 401 does not', async (t) => {
  const { validScrapText, textLength } = await load()
  t.is(textLength('a😀b'), 3)
  t.ok(validScrapText('😀'.repeat(400)))
  t.absent(validScrapText('😀'.repeat(401)))
  t.absent(validScrapText(''))
  t.ok(validScrapText('linha\ncom quebra'))
  t.absent(validScrapText('x\ud800'))
  t.absent(validScrapText('tab\t'))
})

test('the owner is never a writer', async (t) => {
  const { assemblePage } = await load()
  const index = idx([{ author: OWNER, seq: 1 }], { wall: 9 })
  const p = peeks(peekOf(OWNER, [[1, scrap(OWNER, 'eu')], [9, wallRec('everyone')]]))
  t.is(assemblePage({ index, owner: OWNER, self: ME, peeks: p }).rows.length, 0)
})

test('wall policies: everyone, nobody, default following, unreadable', async (t) => {
  const { assemblePage, NOTICES } = await load()
  const rows = [{ author: W1, seq: 1 }]
  const writer = peekOf(W1, [[1, scrap(OWNER, 'oi')]])
  const everyone = assemblePage({ index: idx(rows, { wall: 9 }), owner: OWNER, self: ME, peeks: peeks(writer, peekOf(OWNER, [[9, wallRec('everyone')]])) })
  t.is(everyone.rows.length, 1)
  t.is(everyone.rows[0].via, 'everyone')
  const nobody = assemblePage({ index: idx(rows, { wall: 9 }), owner: OWNER, self: ME, peeks: peeks(writer, peekOf(OWNER, [[9, wallRec('nobody')]])) })
  t.is(nobody.rows.length, 0)
  t.is(nobody.wall, 'nobody')
  const none = assemblePage({ index: idx(rows), owner: OWNER, self: ME, peeks: peeks(writer) })
  t.is(none.wall, 'following')
  t.is(none.rows.length, 0)
  // The pointer names the latest wall block; an older one in the diary is not consulted.
  const latest = assemblePage({ index: idx(rows, { wall: 10 }), owner: OWNER, self: ME, peeks: peeks(writer, peekOf(OWNER, [[9, wallRec('nobody')], [10, wallRec('everyone')]])) })
  t.is(latest.wall, 'everyone')
  // An array is no longer a contract shape: fail closed.
  t.is(assemblePage({ index: idx(rows, { wall: [10] }), owner: OWNER, self: ME, peeks: peeks(writer, peekOf(OWNER, [[10, wallRec('everyone')]])) }).wall, null)
  // A wall pointer that leads to another record type fails closed, not to the default.
  const wrong = assemblePage({ index: idx(rows, { wall: 9 }), owner: OWNER, self: ME, peeks: peeks(writer, peekOf(OWNER, [[9, follow(W1)]])) })
  t.is(wrong.wall, null)
  t.is(wrong.rows.length, 0)
  // A wall pointer that cannot be read shows nothing and says so.
  const unread = assemblePage({ index: idx(rows, { wall: 9 }), owner: OWNER, self: ME, peeks: peeks(writer, peekOf(OWNER, [], { missing: [9] })) })
  t.is(unread.wall, null)
  t.is(unread.rows.length, 0)
  t.is(unread.incomplete, true)
  t.is(unread.notice, NOTICES.wallUnread)
})

test('the reply exception: one reply per original, only to a live scrap addressed to the replier', async (t) => {
  const { assemblePage, planReplyPeeks } = await load()
  const reply = (seq) => scrap(OWNER, 'resposta', { replyTo: { author: OWNER, seq } })
  const index = idx([{ author: W1, seq: 1 }, { author: W1, seq: 2 }, { author: W2, seq: 1 }, { author: W3, seq: 1 }])
  const writers = [
    peekOf(W1, [[1, reply(10)], [2, reply(10)]]), // two replies to one original
    peekOf(W2, [[1, reply(11)]]), // original 11 was left on W3's page
    peekOf(W3, [[1, reply(12)]]) // original 12 does not exist
  ]
  const round1 = peeks(...writers, peekOf(OWNER, []))
  // Round two reads exactly the owner blocks a reply names.
  const plan = planReplyPeeks(index, OWNER, round1)
  t.alike(plan, [{ author: OWNER, seqs: [10, 11, 12] }])
  const ownerPeek = peekOf(OWNER, [[10, scrap(W1, 'oi W1')], [11, scrap(W3, 'oi W3')]], { missing: [12] })
  const page = assemblePage({ index, owner: OWNER, self: ME, peeks: new Map([...round1, [OWNER, [peekOf(OWNER, []), ownerPeek]]]) })
  // W1's first reply to original 10 is admitted, the second is not.
  t.alike(page.rows.map((r) => r.ref), [W1 + ':1'])
  t.is(page.rows[0].via, 'reply')
  t.is(page.rows.length, 1)
  // Under 'everyone' the exception is not needed and round two is empty.
  t.alike(planReplyPeeks(idx(index.rows, { wall: 9 }), OWNER, peeks(...writers, peekOf(OWNER, [[9, wallRec('everyone')]]))), [])
})

test('a reply whose original is not addressed to the replier, or is hidden, is refused', async (t) => {
  const { assemblePage } = await load()
  const reply = scrap(OWNER, 'r', { replyTo: { author: OWNER, seq: 10 } })
  const index = idx([{ author: W1, seq: 1 }], { hides: [3] })
  const base = [peekOf(W1, [[1, reply]])]
  const toOther = assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(...base, peekOf(OWNER, [[10, scrap(W2, 'x')], [3, hide(W2, 9)]])) })
  t.is(toOther.rows.length, 0)
  const ok = assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(...base, peekOf(OWNER, [[10, scrap(W1, 'x')], [3, hide(W2, 9)]])) })
  t.is(ok.rows.length, 1)
  const hidden = assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(...base, peekOf(OWNER, [[10, scrap(W1, 'x')], [3, hide(W1, 1)]])) })
  t.is(hidden.rows.length, 0)
  t.is(hidden.hidden, 1)
  // A reply that names a scrap of someone other than the owner is no reply.
  const foreign = scrap(OWNER, 'r', { replyTo: { author: W2, seq: 10 } })
  const f = assemblePage({ index: idx([{ author: W1, seq: 1 }]), owner: OWNER, self: ME, peeks: peeks(peekOf(W1, [[1, foreign]]), peekOf(OWNER, [[10, scrap(W1, 'x')]])) })
  t.is(f.rows.length, 0)
})

test('hides from the owner remove scraps even under everyone; an unread hide marks the page incomplete', async (t) => {
  const { assemblePage } = await load()
  const index = idx([{ author: W1, seq: 1 }, { author: W2, seq: 1 }], { wall: 9, hides: [3] })
  const writers = [peekOf(W1, [[1, scrap(OWNER, 'a')]]), peekOf(W2, [[1, scrap(OWNER, 'b')]])]
  const page = assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(...writers, peekOf(OWNER, [[9, wallRec('everyone')], [3, hide(W1, 1)]])) })
  t.alike(page.rows.map((r) => r.author), [W2])
  t.is(page.hidden, 1)
  const unread = assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(...writers, peekOf(OWNER, [[9, wallRec('everyone')]], { missing: [3] })) })
  t.is(unread.rows.length, 2)
  t.is(unread.incomplete, true)
})

test('blocked people are filtered on the device, and a blocked owner shows nothing', async (t) => {
  const { assemblePage, NOTICES } = await load()
  const index = idx([{ author: W1, seq: 1 }, { author: W2, seq: 1 }], { wall: 9 })
  const p = peeks(peekOf(W1, [[1, scrap(OWNER, 'a')]]), peekOf(W2, [[1, scrap(OWNER, 'b')]]), peekOf(OWNER, [[9, wallRec('everyone')]]))
  const page = assemblePage({ index, owner: OWNER, self: ME, peeks: p, isBlocked: (k) => k === W1 })
  t.alike(page.rows.map((r) => r.author), [W2])
  const owner = assemblePage({ index, owner: OWNER, self: ME, peeks: p, isBlocked: (k) => k === OWNER })
  t.is(owner.rows.length, 0)
  t.is(owner.blocked, true)
  t.is(owner.notice, NOTICES.blocked)
})

test('order is at desc, author asc, seq desc; caps are 20 per writer and 500 per page', async (t) => {
  const { assemblePage, readPointers, SCRAP_PER_WRITER_MAX, SCRAP_PAGE_MAX } = await load()
  const index = idx([{ author: W2, seq: 1 }, { author: W1, seq: 1 }, { author: W1, seq: 2 }, { author: W3, seq: 1 }], { wall: 9 })
  const p = peeks(
    peekOf(W1, [[1, scrap(OWNER, 'a')], [2, scrap(OWNER, 'b')]]),
    peekOf(W2, [[1, scrap(OWNER, 'c')]]),
    peekOf(W3, [[1, scrap(OWNER, 'd', { at: AT2 })]]),
    peekOf(OWNER, [[9, wallRec('everyone')]])
  )
  const page = assemblePage({ index, owner: OWNER, self: ME, peeks: p })
  t.alike(page.rows.map((r) => r.ref), [W3 + ':1', W1 + ':2', W1 + ':1', W2 + ':1'])
  t.is(SCRAP_PER_WRITER_MAX, 20)
  const many = []
  for (let i = 1; i <= 30; i++) many.push({ author: W1, seq: i })
  const ptr = readPointers(idx(many), OWNER)
  t.is(ptr.rows.length, 20)
  t.is(Math.min(...ptr.rows.map((r) => r.seq)), 11)
  const wide = []
  for (let w = 0; w < 600; w++) wide.push({ author: (w + 1).toString(16).padStart(64, '0'), seq: 600 - w })
  const cut = readPointers(idx(wide), OWNER).rows
  t.is(cut.length, SCRAP_PAGE_MAX)
  t.is(cut[0].seq, 600, 'the 500 cap keeps the index order, it does not sort by seq across diaries')
  t.is(cut[499].seq, 101)
})

test('pointers that do not lead anywhere count as unread and make the page incomplete', async (t) => {
  const { assemblePage } = await load()
  const index = idx([{ author: W1, seq: 1 }, { author: W2, seq: 1 }], { wall: 9 })
  const p = peeks(peekOf(W1, [[1, scrap(OWNER, 'a')]]), peekOf(OWNER, [[9, wallRec('everyone')]]))
  const page = assemblePage({ index, owner: OWNER, self: ME, peeks: p })
  t.is(page.rows.length, 1)
  t.is(page.unread, 1)
  t.is(page.incomplete, true)
})

test('index honesty flags give the pt-BR notices', async (t) => {
  const { assemblePage, NOTICES } = await load()
  const p = peeks(peekOf(OWNER, []))
  const indexing = assemblePage({ index: idx([], { indexing: true }), owner: OWNER, self: ME, peeks: p })
  t.is(indexing.indexing, true)
  t.is(indexing.incomplete, true)
  t.is(indexing.notice, NOTICES.indexing)
  const partial = assemblePage({ index: idx([], { complete: false }), owner: OWNER, self: ME, peeks: p })
  t.is(partial.complete, false)
  t.is(partial.notice, NOTICES.incomplete)
  t.is(assemblePage({ index: idx([]), owner: OWNER, self: ME, peeks: p }).notice, null)
})

test('a peek for a different key is ignored', async (t) => {
  const { assemblePage } = await load()
  const index = idx([{ author: W1, seq: 1 }], { wall: 9 })
  const p = new Map([[W1, peekOf(W2, [[1, scrap(OWNER, 'forjado')]])], [OWNER, peekOf(OWNER, [[9, wallRec('everyone')]])]])
  t.is(assemblePage({ index, owner: OWNER, self: ME, peeks: p }).rows.length, 0)
})

test('planPeeks batches in ascending chunks of 29 and reads the owner blocks', async (t) => {
  const { planPeeks } = await load()
  const rows = []
  for (let i = 1; i <= 20; i++) rows.push({ author: W1, seq: i * 2, followSeq: 100 + i })
  rows.push({ author: W2, seq: 7 })
  const hides = []
  for (let i = 0; i < 10; i++) hides.push(200 + i)
  const plan = planPeeks(idx(rows, { hides: [50, { seq: 51 }, ...hides], wall: 60 }), OWNER)
  const w1 = plan.filter((x) => x.author === W1)
  t.is(w1.length, 1)
  t.is(w1[0].seqs.length, 20)
  t.alike(plan.find((x) => x.author === W2).seqs, [7])
  const owner = plan.filter((x) => x.author === OWNER)
  t.is(owner.length, 2) // 20 follows + 12 hides + 1 wall = 33 seqs, two batches
  t.is(owner[0].seqs.length, 29)
  t.ok(plan.every((x) => x.seqs.length <= 29 && x.seqs.every((s, i) => i === 0 || s > x.seqs[i - 1])))
})

test('composeGate refuses self, blocked, nobody, unfollowed and unreachable pages', async (t) => {
  const { composeGate, NOTICES } = await load()
  const gate = (extra) => composeGate({ owner: OWNER, self: ME, isBlocked: () => false, ...extra })
  t.is(gate({}).ok, true)
  t.alike(gate({ owner: ME }), { ok: false, reason: 'self', notice: NOTICES.self })
  t.alike(gate({ isBlocked: (k) => k === OWNER }), { ok: false, reason: 'blocked', notice: NOTICES.blocked })
  t.is(gate({ wall: 'nobody' }).reason, 'nobody')
  t.is(gate({ wall: 'nobody', reply: true }).reason, 'nobody')
  t.is(gate({ wall: 'following', followedByOwner: false }).reason, 'following')
  t.is(gate({ wall: 'following', followedByOwner: false }).notice, NOTICES.following)
  t.is(gate({ wall: 'following', followedByOwner: false, reply: true }).ok, true)
  t.is(gate({ wall: 'following', followedByOwner: null }).ok, true)
  t.is(gate({ wall: 'everyone', followedByOwner: false }).ok, true)
  t.is(gate({ reachable: false }).reason, 'unreachable')
  t.ok(/semeador indispon/.test(NOTICES.unreachable))
})

test('readFailureNotice maps an unreachable page, nothing else', async (t) => {
  const { readFailureNotice, NOTICES } = await load()
  t.is(readFailureNotice(new Error('semeador indisponível')), NOTICES.unreachable)
  t.is(readFailureNotice({ code: 'NOT_FOUND', message: 'diário indisponível' }), NOTICES.unreachable)
  t.is(readFailureNotice(new Error('outra coisa')), null)
})

test('composer: limit, counter, blank and over states', async (t) => {
  const { initialComposer, setText, composerView, beginSend, NOTICES } = await load()
  let s = initialComposer(OWNER)
  t.is(composerView(s).canSend, false)
  t.is(composerView(s).counter, '0/400')
  s = setText(s, '😀'.repeat(400))
  t.is(composerView(s).count, 400)
  t.is(composerView(s).canSend, true)
  s = setText(s, '😀'.repeat(401))
  t.is(composerView(s).over, true)
  t.is(composerView(s).canSend, false)
  const refused = beginSend(s)
  t.is(refused.params, null)
  t.is(refused.state.notice, NOTICES.tooLong)
  t.is(beginSend(setText(s, '   ')).params, null)
})

test('beginSend sends once: params, no double send while sending', async (t) => {
  const { initialComposer, setText, beginSend } = await load()
  const first = beginSend(setText(initialComposer(OWNER), 'oi'))
  t.alike(first.params, { to: OWNER, text: 'oi' })
  t.is(first.state.sending, true)
  t.is(beginSend(first.state).params, null)
})

test('uncertain: true is never retried: no params until the person confirms', async (t) => {
  const { initialComposer, setText, beginSend, sendFailed, markChecked, composerView, NOTICES } = await load()
  let s = beginSend(setText(initialComposer(OWNER), 'oi')).state
  s = sendFailed(s, Object.assign(new Error('sem resposta'), { uncertain: true }))
  t.is(s.sending, false)
  t.is(s.needsCheck, true)
  t.is(s.notice, NOTICES.uncertain)
  t.is(s.text, 'oi')
  t.is(composerView(s).canSend, false)
  const again = beginSend(s)
  t.is(again.params, null)
  t.is(again.state, s)
  t.alike(setText(s, 'outro').text, 'outro')
  t.is(beginSend(setText(s, 'outro')).params, null)
  const checked = markChecked(s)
  t.is(checked.notice, null)
  t.alike(beginSend(checked).params, { to: OWNER, text: 'oi' })
})

test('a definite failure keeps the text and tells why; nothing is sent again', async (t) => {
  const { initialComposer, setText, beginSend, sendFailed, sendSucceeded, NOTICES } = await load()
  let s = beginSend(setText(initialComposer(OWNER), 'oi')).state
  s = sendFailed(s, Object.assign(new Error('semeador indisponível'), { code: 'NOT_FOUND' }))
  t.is(s.notice, NOTICES.unreachable)
  t.is(s.text, 'oi')
  t.is(s.needsCheck, false)
  t.is(sendFailed(s, new Error('???')).notice, NOTICES.failed)
  t.is(sendFailed(s, new Error('um bloqueio qualquer')).notice, NOTICES.failed, 'no loose wording match')
  t.is(sendFailed(s, null).notice, NOTICES.failed)
  const done = sendSucceeded(s)
  t.is(done.text, '')
  t.is(done.notice, null)
})

test('reply draft: only on my own page, to the writer, with the ref', async (t) => {
  const { replyDraft, setText, beginSend } = await load()
  const row = { author: W1, seq: 4 }
  const draft = replyDraft(row, { owner: ME, self: ME, isBlocked: () => false })
  t.is(draft.to, W1)
  t.is(draft.replyTo, W1 + ':4')
  t.alike(beginSend(setText(draft, 'obrigado')).params, { to: W1, text: 'obrigado', replyTo: W1 + ':4' })
  t.is(replyDraft(row, { owner: OWNER, self: ME }), null)
  t.is(replyDraft({ author: ME, seq: 1 }, { owner: ME, self: ME }), null)
  t.is(replyDraft(row, { owner: ME, self: ME, isBlocked: (k) => k === W1 }), null)
  t.is(replyDraft({ author: 'x', seq: 1 }, { owner: ME, self: ME }), null)
})

test('a hidden first reply still takes the original slot: the next reply does not surface', async (t) => {
  const { assemblePage } = await load()
  const reply = (text) => scrap(OWNER, text, { replyTo: { author: OWNER, seq: 10 }, at: AT2 })
  const index = idx([{ author: W1, seq: 1 }, { author: W1, seq: 2 }], { hides: [3] })
  const writer = peekOf(W1, [[1, reply('primeira')], [2, reply('segunda')]])
  const owner = peekOf(OWNER, [[10, scrap(W1, 'original')], [3, hide(W1, 1)]])
  const page = assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(writer, owner), now: NOW })
  t.is(page.rows.length, 0)
  t.is(page.hidden, 1)
  // The lowest seq wins whatever order the seeder lists the rows in.
  const swapped = assemblePage({ index: idx([{ author: W1, seq: 2 }, { author: W1, seq: 1 }]), owner: OWNER, self: ME, peeks: peeks(writer, peekOf(OWNER, [[10, scrap(W1, 'original')]])), now: NOW })
  t.alike(swapped.rows.map((r) => r.seq), [1])
})

test('a reply dated before its original is no reply', async (t) => {
  const { assemblePage } = await load()
  const reply = (at) => scrap(OWNER, 'r', { replyTo: { author: OWNER, seq: 10 }, at })
  const index = idx([{ author: W1, seq: 1 }])
  const owner = peekOf(OWNER, [[10, scrap(W1, 'original', { at: AT2 })]])
  t.is(assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(peekOf(W1, [[1, reply(AT)]]), owner), now: NOW }).rows.length, 0)
  t.is(assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(peekOf(W1, [[1, reply(AT2)]]), owner), now: NOW }).rows.length, 1)
})

test('a scrap dated more than a day ahead of now is dropped', async (t) => {
  const { assemblePage } = await load()
  const index = idx([{ author: W1, seq: 1 }, { author: W2, seq: 1 }], { wall: 9 })
  const p = peeks(
    peekOf(W1, [[1, scrap(OWNER, 'futuro', { at: '2026-10-28T12:00:01.000Z' })]]),
    peekOf(W2, [[1, scrap(OWNER, 'quase', { at: '2026-10-28T12:00:00.000Z' })]]),
    peekOf(OWNER, [[9, wallRec('everyone')]])
  )
  const page = assemblePage({ index, owner: OWNER, self: ME, peeks: p, now: NOW })
  t.alike(page.rows.map((r) => r.author), [W2])
  t.is(page.rejected, 1)
})

test('a reply by a followed writer is admitted as following', async (t) => {
  const { assemblePage, planReplyPeeks } = await load()
  const index = idx([{ author: W1, seq: 1, followSeq: 5 }])
  const writer = peekOf(W1, [[1, scrap(OWNER, 'r', { replyTo: { author: OWNER, seq: 10 }, at: AT2 })]])
  const owner = peekOf(OWNER, [[5, follow(W1)], [10, scrap(W1, 'original')]])
  const page = assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(writer, owner), now: NOW })
  t.is(page.rows[0].via, 'following')
  // Round two skips the original of a writer whose follow already verified.
  t.alike(planReplyPeeks(index, OWNER, peeks(writer, peekOf(OWNER, [[5, follow(W1)]])), undefined, NOW), [])
  // ... but not one whose follow pointer does not verify.
  t.alike(planReplyPeeks(index, OWNER, peeks(writer, peekOf(OWNER, [[5, follow(W1, false)]])), undefined, NOW), [{ author: OWNER, seqs: [10] }])
})

test('blocked writers are skipped before planning and never count as unread', async (t) => {
  const { assemblePage, planPeeks, planReplyPeeks } = await load()
  const index = idx([{ author: W1, seq: 1 }, { author: W2, seq: 1 }], { wall: 9 })
  const isBlocked = (k) => k === W1
  t.alike(planPeeks(index, OWNER, isBlocked).map((x) => x.author).sort(), [OWNER, W2].sort())
  // W1 has no peek at all: the page is still complete.
  const p = peeks(peekOf(W2, [[1, scrap(OWNER, 'b')]]), peekOf(OWNER, [[9, wallRec('everyone')]]))
  const page = assemblePage({ index, owner: OWNER, self: ME, peeks: p, isBlocked })
  t.is(page.incomplete, false)
  t.is(page.unread, 0)
  t.is(page.notice, null)
  t.alike(planReplyPeeks(idx(index.rows), OWNER, p, isBlocked), [])
})

test('on my own page a blocked writer is peeked and kept, marked blocked with no text', async (t) => {
  const { assemblePage, planPeeks, planReplyPeeks } = await load()
  const index = idx([{ author: W1, seq: 1 }, { author: W2, seq: 1 }], { wall: 9 })
  const isBlocked = (k) => k === W1
  t.alike(planPeeks(index, OWNER, isBlocked, OWNER).map((x) => x.author).sort(), [OWNER, W1, W2].sort())
  const p = peeks(peekOf(W1, [[1, scrap(OWNER, 'secreto')]]), peekOf(W2, [[1, scrap(OWNER, 'b')]]), peekOf(OWNER, [[9, wallRec('everyone')]]))
  const mine = assemblePage({ index, owner: OWNER, self: OWNER, peeks: p, isBlocked })
  const hit = mine.rows.find((r) => r.author === W1)
  t.ok(hit)
  t.is(hit.blocked, true)
  t.is(hit.text, '')
  t.is(mine.rows.find((r) => r.author === W2).blocked, undefined)
  t.is(mine.unread, 0)
  t.alike(planReplyPeeks(index, OWNER, p, isBlocked, NOW, OWNER), [])
  // A visitor (even with the same block list) still has the writer filtered out.
  t.alike(planPeeks(index, OWNER, isBlocked, ME).map((x) => x.author).sort(), [OWNER, W2].sort())
  const visitor = assemblePage({ index, owner: OWNER, self: ME, peeks: p, isBlocked })
  t.alike(visitor.rows.map((r) => r.author), [W2])
})

test('a blocked writer still on my page can be hidden by the owner record', async (t) => {
  const { assemblePage } = await load()
  const index = idx([{ author: W1, seq: 1 }], { wall: 9, hides: [4] })
  const p = peeks(peekOf(W1, [[1, scrap(OWNER, 'x')]]), peekOf(OWNER, [[9, wallRec('everyone')], [4, hide(W1, 1)]]))
  const page = assemblePage({ index, owner: OWNER, self: OWNER, peeks: p, isBlocked: (k) => k === W1 })
  t.is(page.rows.length, 0)
  t.is(page.hidden, 1)
})

test('an index that is not a page is unreachable, not an empty complete page', async (t) => {
  const { assemblePage, NOTICES } = await load()
  const check = (index) => {
    const page = assemblePage({ index, owner: OWNER, self: ME, peeks: peeks(peekOf(OWNER, [])) })
    t.is(page.incomplete, true)
    t.is(page.notice, NOTICES.unreachable)
    t.is(page.rows.length, 0)
  }
  check(null)
  check('x')
  check({ complete: true })
  check({ rows: [] })
  check({ rows: [], complete: 'sim' })
})

test('more hides than the cap makes the page incomplete', async (t) => {
  const { assemblePage, readPointers, SCRAP_HIDES_MAX, NOTICES } = await load()
  const hides = []
  for (let i = 1; i <= SCRAP_HIDES_MAX + 1; i++) hides.push(i)
  t.is(readPointers(idx([], { hides }), OWNER).hides.length, SCRAP_HIDES_MAX)
  const page = assemblePage({ index: idx([], { hides }), owner: OWNER, self: ME, peeks: peeks(peekOf(OWNER, [])) })
  t.is(page.incomplete, true)
  t.is(page.notice, NOTICES.incomplete)
})

test('composer: CRLF becomes LF, other disallowed characters are refused with a notice', async (t) => {
  const { initialComposer, setText, composerView, beginSend, NOTICES } = await load()
  const crlf = setText(initialComposer(OWNER), 'a\r\nb')
  t.is(crlf.text, 'a\nb')
  t.alike(beginSend(crlf).params, { to: OWNER, text: 'a\nb' })
  for (const bad of ['a\rb', 'a\tb', 'a‮b', 'a\u0007b']) {
    const s = setText(initialComposer(OWNER), bad)
    t.is(composerView(s).badChars, true)
    t.is(composerView(s).canSend, false)
    const r = beginSend(s)
    t.is(r.params, null)
    t.is(r.state.notice, NOTICES.badChars)
  }
})

test('failure notices match only the known unreachable answers', async (t) => {
  const { initialComposer, sendFailed, NOTICES } = await load()
  const s = initialComposer(OWNER)
  t.is(sendFailed(s, new Error('diário indisponível')).notice, NOTICES.unreachable)
  t.is(sendFailed(s, new Error('você bloqueou essa pessoa')).notice, NOTICES.failed)
  t.is(sendFailed(s, new Error('na própria página não')).notice, NOTICES.failed)
})

test('the module names no RPC method, has no em dash and imports nothing', (t) => {
  const src = readFileSync(join(__dirname, '../src/scraps.js'), 'utf8')
  t.absent(/['"`](scrap|diary|follow)\.[a-z]+['"`]/.test(src), 'no quoted method name')
  t.absent(src.includes(String.fromCharCode(0x2014)), 'no em dash')
  t.absent(/^import /m.test(src), 'no imports')
  t.absent(/mural/i.test(src), 'never the word mural')
})
