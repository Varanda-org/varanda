// A Rua's comment fold (feedFold.js): comments fold into the original
// post's card, attach to a root or repost already in the list, own replies
// become 'Você' lines, unresolved chains keep their chip row.
'use strict'

const test = require('brittle')
const load = () => import('../src/feedFold.js')

const ME = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const D = 'dd'.repeat(32)
const E = 'ee'.repeat(32)
const S = '55'.repeat(32)
const F = 'ff'.repeat(32)

const NAMES = { [ME]: 'Eu', [B]: 'Bia', [C]: 'Caio', [D]: 'Duda', [E]: 'Edu', [S]: 'Sol', [F]: 'Fabi' }

const ref = (author, seq) => author + ':' + seq
const post = (author, seq, text, to = null, extra = {}) => ({
  kind: 'post',
  author,
  seq,
  text,
  at: '2026-11-15T10:00:00.000Z',
  replyTo: to === null ? null : { author: to.author, seq: to.seq },
  name: NAMES[author],
  ...extra
})
const repost = (author, seq, to) => ({ kind: 'repost', author, seq, text: null, to: { author: to.author, seq: to.seq } })
const keyOf = (row) => row.key || row.author + ':' + row.seq
const originals = (...posts) => {
  const map = new Map(posts.map((p) => [ref(p.author, p.seq), p]))
  return (r) => map.get(r)
}

test('the module loads in plain Node and exports the fold API', async (t) => {
  const mod = await load()
  t.is(typeof mod.foldFeed, 'function')
  t.is(typeof mod.foldNeeds, 'function')
  t.is(typeof mod.commentedLabel, 'function')
  t.is(mod.FOLD_WALK_MAX, 32)
  t.alike(mod.foldFeed(undefined), { rows: [], attached: new Map() }, 'no list, no rows')
  t.alike(mod.foldNeeds(null), [])
})

test('one comment folds over a stranger root', async (t) => {
  const { foldFeed, commentedLabel } = await load()
  const root = post(S, 1, 'post do Sol')
  const x = post(C, 4, 'antes')
  const c = post(B, 7, 'que lindo', root)
  const y = post(D, 2, 'depois')
  const { rows, attached } = foldFeed([x, c, y], { originalOf: originals(root), ownKey: ME })
  t.is(rows.length, 3)
  t.is(rows[0], x, 'untouched row keeps its identity')
  t.is(rows[2], y)
  t.alike(rows[1], {
    kind: 'comentarios',
    key: 'c:' + ref(S, 1),
    root: ref(S, 1),
    post: root,
    by: [{ author: B, name: 'Bia' }],
    comments: [{ ref: ref(B, 7), top: ref(B, 7) }],
    lines: [{ key: ref(B, 7), name: 'Bia', text: 'que lindo' }]
  })
  t.is(rows[1].post, root, 'the card shows the verified original')
  t.is(attached.size, 0)
  t.is(commentedLabel(rows[1].by), 'Bia comentou')
})

test('three followed commenters group with the right label', async (t) => {
  const { foldFeed, commentedLabel } = await load()
  const root = post(S, 1, 'post')
  const cD = post(D, 3, 'terceiro', root)
  const z = post(E, 1, 'outro')
  const cC = post(C, 9, 'segundo', root)
  const cB = post(B, 2, 'primeiro', root)
  const { rows } = foldFeed([cD, z, cC, cB], { originalOf: originals(root) })
  t.is(rows.length, 2, 'one card for the three comments, the other row kept')
  t.is(rows[1], z)
  const card = rows[0]
  t.is(card.key, 'c:' + ref(S, 1))
  t.alike(card.by.map((b) => b.author), [D, C, B], 'distinct commenters, newest first')
  t.is(commentedLabel(card.by), 'Duda e mais 2 comentaram')
  t.alike(card.comments.map((c) => c.ref), [ref(D, 3), ref(C, 9), ref(B, 2)], 'comments newest first')
  t.alike(card.lines.map((l) => l.key), [ref(D, 3), ref(C, 9)], 'at most two lines by default')
  const three = foldFeed([cD, z, cC, cB], { originalOf: originals(root), maxLines: 3 })
  t.is(three.rows[0].lines.length, 3, 'maxLines widens the preview')
  const twice = foldFeed([cD, { ...cD }], { originalOf: originals(root) })
  t.alike(twice.rows.map(keyOf), ['c:' + ref(S, 1)], 'a repeated comment is one comment')
  t.is(twice.rows[0].comments.length, 1)
})

test('commentedLabel names one, two, or the first and a count', async (t) => {
  const { commentedLabel } = await load()
  t.is(commentedLabel([{ author: B, name: 'Ana' }]), 'Ana comentou')
  t.is(commentedLabel([{ author: B, name: 'Ana' }, { author: C, name: 'Bia' }]), 'Ana e Bia comentaram')
  t.is(commentedLabel([{ name: 'Ana' }, { name: 'Bia' }, { name: 'Caio' }]), 'Ana e mais 2 comentaram')
  t.is(commentedLabel([{ author: B, name: '' }]), 'Alguém comentou', 'a nameless commenter is never a blank label')
  t.is(commentedLabel([{ name: 'A‮na' }]), 'A�na comentou', 'a peer name passes through displayText')
  t.is(commentedLabel([]), '')
  t.is(commentedLabel(null), '')
})

test('lines pass through displayText, blank text takes no slot, names fall back to the username', async (t) => {
  const { foldFeed } = await load()
  const root = post(S, 1, 'post')
  const photo = post(B, 5, '   ', root)
  const evil = post(C, 6, 'oi‮\nmundo', root, { name: '', username: 'caio‮' })
  const third = post(D, 7, 'ok', root)
  const { rows } = foldFeed([photo, evil, third], { originalOf: originals(root) })
  t.alike(rows[0].lines, [
    { key: ref(C, 6), name: 'caio�', text: 'oi�\nmundo' },
    { key: ref(D, 7), name: 'Duda', text: 'ok' }
  ], 'photo-only comment skipped, multiline kept, control characters replaced')
  t.alike(rows[0].by.map((b) => b.author), [B, C, D], 'the photo-only commenter still commented')
})

test('a root loaded later in the list is dropped', async (t) => {
  const { foldFeed } = await load()
  let asked = 0
  const root = post(E, 1, 'raiz')
  const c = post(B, 3, 'comentário', root)
  const z = post(C, 2, 'meio')
  const rp = repost(F, 4, root)
  const { rows, attached } = foldFeed([c, z, root, rp], { originalOf: () => { asked++ } })
  t.alike(rows.map(keyOf), ['c:' + ref(E, 1), ref(C, 2), ref(F, 4)], 'the later plain row of the root is gone, the later repost stays')
  t.is(rows[0].post, root, 'the root comes from the list itself')
  t.is(rows[2], rp)
  t.is(attached.size, 0)
  t.is(asked, 0, 'a root in the list costs no lookup')
})

test('a root or its repost earlier in the list receives attached lines and no card', async (t) => {
  const { foldFeed } = await load()
  const root = post(E, 1, 'raiz')
  const c1 = post(B, 3, 'um', root)
  const c2 = post(C, 2, 'dois', root)
  const direct = foldFeed([root, c1, c2], {})
  t.alike(direct.rows, [root])
  t.is(direct.rows[0], root)
  t.alike(direct.attached.get(ref(E, 1)), {
    by: [{ author: B, name: 'Bia' }, { author: C, name: 'Caio' }],
    lines: [{ key: ref(B, 3), name: 'Bia', text: 'um' }, { key: ref(C, 2), name: 'Caio', text: 'dois' }],
    comments: [{ ref: ref(B, 3), top: ref(B, 3) }, { ref: ref(C, 2), top: ref(C, 2) }]
  })

  const rp = repost(F, 9, root)
  const viaRepost = foldFeed([rp, c1], { originalOf: originals(root) })
  t.alike(viaRepost.rows, [rp], 'the repost row holds the comment')
  t.alike([...viaRepost.attached.keys()], [ref(F, 9)], 'keyed by the repost row key')
  t.alike(viaRepost.attached.get(ref(F, 9)).lines.map((l) => l.key), [ref(B, 3)])

  const wrapperFirst = foldFeed([rp, c1, root], {})
  t.alike(wrapperFirst.rows.map(keyOf), [ref(F, 9), ref(E, 1)], 'a later plain row stays when the repost holds the group')
  t.alike([...wrapperFirst.attached.keys()], [ref(F, 9)])
})

test('a 10-level back-and-forth between followed people resolves from the list alone', async (t) => {
  const { foldFeed, foldNeeds } = await load()
  const root = post(B, 1, 'raiz')
  const chain = [root]
  for (let i = 1; i <= 10; i++) {
    const author = i % 2 === 1 ? C : B
    chain.push(post(author, 10 + i, 'nível ' + i, chain[i - 1]))
  }
  const items = chain.slice().reverse()
  const fail = () => t.fail('no lookup outside the list')
  t.alike(foldNeeds(items, fail), [], 'every ancestor is in the list')
  const { rows, attached } = foldFeed(items, { originalOf: fail })
  t.is(rows.length, 1, 'one card, the root row folded into it')
  t.is(attached.size, 0)
  t.is(rows[0].key, 'c:' + ref(B, 1))
  t.is(rows[0].comments.length, 10)
  t.ok(rows[0].comments.every((c) => c.top === ref(C, 11)), 'every comment carries the node under the root')
  t.alike(rows[0].by.map((b) => b.author), [B, C])
})

test('each comment carries its top', async (t) => {
  const { foldFeed } = await load()
  const root = post(S, 1, 'raiz')
  const c1 = post(B, 1, 'a', root)
  const c2 = post(C, 1, 'b', c1)
  const c3 = post(D, 1, 'c', c2)
  const c4 = post(E, 1, 'd', root)
  const { rows } = foldFeed([c3, c4, c2, c1], { originalOf: originals(root) })
  t.alike(rows[0].comments, [
    { ref: ref(D, 1), top: ref(B, 1) },
    { ref: ref(E, 1), top: ref(E, 1) },
    { ref: ref(C, 1), top: ref(B, 1) },
    { ref: ref(B, 1), top: ref(B, 1) }
  ])
  const memoFirst = foldFeed([c2, c3, c4, c1], { originalOf: originals(root) })
  t.alike(memoFirst.rows[0].comments.map((c) => c.top), [ref(B, 1), ref(B, 1), ref(E, 1), ref(B, 1)], 'a walk that meets an ancestor already walked keeps its top')
})

test('a missing, never-asked or cyclic chain returns the item unchanged', async (t) => {
  const { foldFeed, foldNeeds } = await load()
  const gone = post(B, 2, 'resposta', { author: S, seq: 1 })

  const neverAsked = foldFeed([gone], { originalOf: () => undefined, pendingOf: () => false })
  t.is(neverAsked.rows[0], gone, 'never asked: the chip row stays')
  t.alike(foldNeeds([gone], () => undefined), [ref(S, 1)])

  const unreadable = foldFeed([gone], { originalOf: () => null })
  t.is(unreadable.rows[0], gone, 'known unreadable: the chip row stays')
  t.alike(foldNeeds([gone], () => null), [], 'nothing left to ask')

  t.is(foldFeed([gone]).rows[0], gone, 'no lookups at all')

  const loopA = post(B, 5, 'a', { author: C, seq: 5 })
  const loopB = post(C, 5, 'b', { author: B, seq: 5 })
  const cyclic = foldFeed([loopA, loopB], {})
  t.is(cyclic.rows[0], loopA)
  t.is(cyclic.rows[1], loopB)
  t.alike(foldNeeds([loopA, loopB]), [], 'a cycle needs nothing')

  const mid = post(C, 3, 'meio', { author: S, seq: 9 })
  const deep = post(B, 4, 'fundo', mid)
  t.alike(foldNeeds([deep], originals(mid)), [ref(S, 9)], 'the first ancestor not at hand, not the direct parent')
  t.alike(foldNeeds([deep, gone], originals(mid)), [ref(S, 9), ref(S, 1)], 'one ref per unresolved chain')

  const wrapper = repost(D, 3, { author: S, seq: 1 })
  const toWrapper = post(B, 8, 'resposta ao repost', wrapper)
  const wrapped = foldFeed([toWrapper], { originalOf: originals(wrapper) })
  t.is(wrapped.rows[0], toWrapper, 'a repost wrapper is never a root')
})

test('the walk stops at FOLD_WALK_MAX hops', async (t) => {
  const { foldFeed, foldNeeds, FOLD_WALK_MAX } = await load()
  const root = post(S, 1, 'raiz')
  const chain = [root]
  for (let i = 1; i <= FOLD_WALK_MAX + 1; i++) chain.push(post(i % 2 ? B : C, 100 + i, 'n' + i, chain[i - 1]))
  const at = originals(...chain)
  const edge = chain[FOLD_WALK_MAX]
  const over = chain[FOLD_WALK_MAX + 1]
  const ok = foldFeed([edge], { originalOf: at })
  t.is(ok.rows[0].key, 'c:' + ref(S, 1), FOLD_WALK_MAX + ' hops resolve')
  t.is(ok.rows[0].comments[0].top, ref(chain[1].author, chain[1].seq))
  const far = foldFeed([over], { originalOf: at })
  t.is(far.rows[0], over, 'one hop more keeps the chip row')
  const both = foldFeed([edge, over], { originalOf: at })
  t.is(both.rows[1], over, 'the same answer whichever reply is walked first')
  const reversed = foldFeed([over, edge], { originalOf: at })
  t.is(reversed.rows[0], over)
  t.is(reversed.rows[1].key, 'c:' + ref(S, 1))
  const long = [root]
  for (let i = 1; i <= 50; i++) long.push(post(B, 1000 + i, 'l' + i, long[i - 1]))
  let lookups = 0
  const counting = originals(...long)
  const deep = foldFeed([long[50]], { originalOf: (r) => { lookups++; return counting(r) } })
  t.is(deep.rows[0], long[50])
  t.ok(lookups <= FOLD_WALK_MAX, 'the walk reads at most FOLD_WALK_MAX records past the reply (' + lookups + ')')
  const missingFar = post(B, 999, 'longe', { author: S, seq: 2 })
  const tail = [missingFar]
  for (let i = 1; i <= FOLD_WALK_MAX; i++) tail.push(post(C, 500 + i, 't' + i, tail[i - 1]))
  t.alike(foldNeeds([tail[FOLD_WALK_MAX - 1]], originals(...tail)), [ref(S, 2)], 'a need within the cap is asked')
  t.alike(foldNeeds([tail[FOLD_WALK_MAX]], originals(...tail)), [], 'a need past the cap is not')
})

test('a repost wrapper is never a reply', async (t) => {
  const { foldFeed, foldNeeds } = await load()
  const root = post(S, 1, 'raiz')
  const odd = { ...repost(F, 2, root), replyTo: { author: S, seq: 1 } }
  const { rows, attached } = foldFeed([odd], { originalOf: originals(root) })
  t.is(rows[0], odd)
  t.is(attached.size, 0, 'the repost itself carries no comments')
  t.alike(foldNeeds([odd], () => undefined), [])
})

test('pending keeps one stable key', async (t) => {
  const { foldFeed } = await load()
  const c = post(B, 2, 'resposta', { author: S, seq: 1 })
  const x = post(C, 1, 'x')
  const opts = { originalOf: () => undefined, pendingOf: (r) => r === ref(S, 1) }
  const first = foldFeed([x, c], opts)
  t.alike(first.rows[1], { kind: 'comentarios', state: 'pending', key: ref(B, 2) }, 'placeholder under the reply\'s own key')
  const older = post(D, 1, 'velho')
  const second = foldFeed([x, c, older], opts)
  t.is(second.rows[1].key, ref(B, 2), 'the same key and place after an older page')
  t.is(second.rows[2], older)
  const own = post(ME, 3, 'minha', { author: S, seq: 1 })
  t.alike(foldFeed([own], { ...opts, ownKey: ME }).rows, [], 'an own reply is never a placeholder either')
})

test('an own reply adds a line when the root is shown and is dropped otherwise', async (t) => {
  const { foldFeed, commentedLabel } = await load()
  const root = post(S, 1, 'raiz')
  const mine = post(ME, 4, 'eu comentei', root)

  const shown = foldFeed([root, mine], { ownKey: ME })
  t.alike(shown.rows, [root])
  t.alike(shown.attached.get(ref(S, 1)), {
    by: [],
    lines: [{ key: ref(ME, 4), name: 'Você', text: 'eu comentei' }],
    comments: [{ ref: ref(ME, 4), top: ref(ME, 4) }]
  })
  t.is(commentedLabel(shown.attached.get(ref(S, 1)).by), '', 'no "comentou" header for my own line')

  const x = post(C, 2, 'x')
  const y = post(D, 2, 'y')
  const other = post(B, 5, 'outro', root)
  const card = foldFeed([x, mine, y, other], { originalOf: originals(root), ownKey: ME })
  t.alike(card.rows.map(keyOf), [ref(C, 2), ref(D, 2), 'c:' + ref(S, 1)], 'the card sits at the first comment someone else wrote')
  t.alike(card.rows[2].by.map((b) => b.author), [B], 'never myself in by')
  t.alike(card.rows[2].lines.map((l) => l.name), ['Você', 'Bia'])

  t.alike(foldFeed([x, mine], { originalOf: originals(root), ownKey: ME }).rows, [x], 'no card of my own')
  const lost = post(ME, 6, 'perdida', { author: S, seq: 77 })
  t.alike(foldFeed([lost], { ownKey: ME }).rows, [], 'an own reply with an unknown chain is not a standalone row')
  t.is(foldFeed([mine], { originalOf: originals(root) }).rows[0].kind, 'comentarios', 'without ownKey it is anyone\'s comment')
})

test('blocked commenter and blocked root', async (t) => {
  const { foldFeed } = await load()
  const root = post(S, 1, 'raiz')
  const cB = post(B, 2, 'bia', root)
  const cC = post(C, 3, 'caio', root)
  const blocked = new Set([C])
  const { rows } = foldFeed([cC, cB], { originalOf: originals(root), blocked })
  t.is(rows[0], cC, 'the blocked row is left for BlockGate and places nothing')
  t.is(rows[1].kind, 'comentarios')
  t.alike(rows[1].by.map((b) => b.author), [B])
  t.alike(rows[1].lines.map((l) => l.key), [ref(B, 2)])
  t.alike(rows[1].comments.map((c) => c.ref), [ref(B, 2)])

  const alone = foldFeed([cC], { originalOf: originals(root), blocked })
  t.alike(alone.rows, [cC], 'no card from a blocked commenter alone')

  const atRoot = foldFeed([root, cC], { blocked })
  t.alike(atRoot.rows, [root, cC])
  t.is(atRoot.attached.size, 0)

  const mine = post(ME, 9, 'eu', root)
  const blockedRoot = foldFeed([root, cB, mine], { ownKey: ME, blocked: new Set([S]) })
  t.alike(blockedRoot.rows, [root, cB], 'no group over a blocked root, my reply is dropped')
  t.is(blockedRoot.rows[1], cB)
  t.is(blockedRoot.attached.size, 0)
})

test('appending an older page never moves or removes rows already emitted', async (t) => {
  const { foldFeed } = await load()
  const s1 = post(S, 1, 'raiz do Sol')
  const r2 = post(E, 1, 'raiz do Edu')
  const page1 = [
    post(B, 9, 'sobre o sol', s1),
    post(C, 9, 'solto'),
    r2,
    post(D, 9, 'sobre o edu', r2)
  ]
  const opts = { originalOf: originals(s1), ownKey: ME }
  const before = foldFeed(page1, opts)
  t.alike(before.rows.map(keyOf), ['c:' + ref(S, 1), ref(C, 9), ref(E, 1)])
  const page2 = [
    post(F, 8, 'mais sobre o sol', s1),
    repost(F, 7, s1),
    s1,
    post(B, 6, 'mais sobre o edu', r2),
    post(ME, 5, 'eu no sol', s1),
    post(C, 4, 'velho')
  ]
  const after = foldFeed(page1.concat(page2), opts)
  t.alike(after.rows.slice(0, before.rows.length).map(keyOf), before.rows.map(keyOf), 'the first rows are the same, in the same place')
  t.alike(after.rows.map(keyOf), ['c:' + ref(S, 1), ref(C, 9), ref(E, 1), ref(F, 7), ref(C, 4)], 'the older root row folds away, its repost stays')
  t.alike(after.rows[0].comments.map((c) => c.ref), [ref(B, 9), ref(F, 8), ref(ME, 5)], 'older comments join the card above')
  t.alike(after.attached.get(ref(E, 1)).comments.map((c) => c.ref), [ref(D, 9), ref(B, 6)])
})

test('known edge: a chain resolved only by an older page joins the card above', async (t) => {
  const { foldFeed } = await load()
  const s1 = post(S, 1, 'raiz')
  const mid = post(B, 2, 'meio', s1)
  const top = post(C, 3, 'primeiro', s1)
  const late = post(D, 4, 'sobre o meio', mid)
  const opts = { originalOf: originals(s1) }
  const before = foldFeed([top, late], opts)
  t.is(before.rows[1], late, 'the parent is not at hand yet: chip row')
  const after = foldFeed([top, late, mid], opts)
  t.alike(after.rows.map(keyOf), ['c:' + ref(S, 1)], 'the chip row leaves the list for the card above')
  t.alike(after.rows[0].comments, [
    { ref: ref(C, 3), top: ref(C, 3) },
    { ref: ref(D, 4), top: ref(B, 2) },
    { ref: ref(B, 2), top: ref(B, 2) }
  ])
})

test('untouched items keep their identity and the input is not mutated', async (t) => {
  const { foldFeed } = await load()
  const root = post(S, 1, 'raiz')
  const items = [post(C, 1, 'a'), post(B, 2, 'b', root), repost(F, 3, post(E, 1, 'e')), post(D, 4, 'd', { author: E, seq: 99 })]
  const copy = JSON.parse(JSON.stringify(items))
  const refs = items.slice()
  const { rows } = foldFeed(items, { originalOf: originals(root) })
  t.is(rows[0], items[0])
  t.is(rows[2], items[2])
  t.is(rows[3], items[3])
  t.alike(JSON.parse(JSON.stringify(items)), copy, 'items are not mutated')
  t.ok(items.every((item, i) => item === refs[i]), 'the array keeps its objects')
  const again = foldFeed(items, { originalOf: originals(root) })
  t.alike(again.rows[1], rows[1], 'the same group gives the same content')
})

test('known edge, mirror: the card moves up to the place of the reply that joins it', async (t) => {
  const { foldFeed } = await load()
  const s1 = post(S, 1, 'raiz')
  const mid = post(B, 2, 'meio', s1)
  const top = post(C, 3, 'primeiro', s1)
  const late = post(D, 4, 'sobre o meio', mid)
  const z = post(E, 5, 'solto')
  const opts = { originalOf: originals(s1) }
  const before = foldFeed([late, z, top], opts)
  t.is(before.rows[0], late, 'the parent is not at hand yet: chip row')
  t.alike(before.rows.map(keyOf), [ref(D, 4), ref(E, 5), 'c:' + ref(S, 1)])
  const after = foldFeed([late, z, top, mid], opts)
  t.alike(after.rows.map(keyOf), ['c:' + ref(S, 1), ref(E, 5)], 'the card leaves its place for the joining reply\'s')
  t.alike(after.rows[0].comments.map((c) => c.ref), [ref(D, 4), ref(C, 3), ref(B, 2)])
})

test('a blocked reposter\'s row never holds the group', async (t) => {
  const { foldFeed } = await load()
  const root = post(S, 1, 'raiz')
  const rp = repost(F, 9, root)
  const x = post(C, 2, 'x')
  const c = post(B, 3, 'comentário', root)
  const mine = post(ME, 4, 'eu', root)
  const opts = { originalOf: originals(root), ownKey: ME, blocked: new Set([F]) }
  const { rows, attached } = foldFeed([rp, x, c, mine], opts)
  t.is(attached.size, 0, 'nothing attached to a row BlockGate hides')
  t.alike(rows.map(keyOf), [ref(F, 9), ref(C, 2), 'c:' + ref(S, 1)], 'the card sits at the comment, the repost row is left for BlockGate')
  t.is(rows[0], rp)
  t.alike(rows[2].lines.map((l) => l.name), ['Bia', 'Você'], 'the own line still shows')
  const rp2 = repost(D, 8, root)
  const next = foldFeed([rp, rp2, c], opts)
  t.alike([...next.attached.keys()], [ref(D, 8)], 'the first repost by someone not blocked holds it')
  t.alike(foldFeed([rp, mine], opts).rows, [rp], 'an own reply alone is dropped, not attached to the hidden repost')
})

test('an originalOf answer for another ref or a sentinel is not the post', async (t) => {
  const { foldFeed, foldNeeds } = await load()
  const c = post(B, 2, 'resposta', { author: S, seq: 1 })
  const sentinel = Object.freeze({ transient: true })
  const transient = foldFeed([c], { originalOf: () => sentinel, pendingOf: () => true })
  t.is(transient.rows[0], c, 'a sentinel keeps the chip row, never a card over it')
  t.is(transient.attached.size, 0)
  t.alike(foldNeeds([c], () => sentinel), [])
  const other = post(E, 7, 'outro post')
  const wrong = foldFeed([c], { originalOf: () => other })
  t.is(wrong.rows[0], c, 'a record of another ref keeps the chip row')
  t.alike(foldNeeds([c], () => other), [])
  const right = foldFeed([c], { originalOf: (r) => r === ref(S, 1) ? post(S.toUpperCase(), 1, 'raiz') : undefined })
  t.is(right.rows[0].key, 'c:' + ref(S, 1), 'the same ref in another case is the same post')
})

test('a reply to a repost wrapper in the list keeps its chip and needs nothing', async (t) => {
  const { foldFeed, foldNeeds } = await load()
  const wrapper = repost(D, 3, { author: S, seq: 1 })
  const toWrapper = post(B, 8, 'resposta ao repost', wrapper)
  const opts = { originalOf: () => undefined, pendingOf: () => true }
  const { rows } = foldFeed([wrapper, toWrapper], opts)
  t.is(rows[0], wrapper)
  t.is(rows[1], toWrapper, 'no placeholder for a ref already at hand')
  t.alike(foldNeeds([wrapper, toWrapper], () => undefined), [], 'the wrapper is not asked for')
  t.alike(foldNeeds([toWrapper], () => undefined), [ref(D, 3)], 'out of the list it is still asked')
})

test('commentedLabel says "outra pessoa" for two commenters with one name', async (t) => {
  const { commentedLabel } = await load()
  t.is(commentedLabel([{ author: B, name: '' }, { author: C, name: '' }]), 'Alguém e outra pessoa comentaram')
  t.is(commentedLabel([{ author: B, name: 'Ana' }, { author: C, name: 'Ana' }]), 'Ana e outra pessoa comentaram')
  t.is(commentedLabel([{ author: B, name: 'Ana' }, { author: C, name: 'Ana ' }]), 'Ana e outra pessoa comentaram', 'compared as shown')
  t.is(commentedLabel([{ name: 'Ana' }, { name: 'Ana' }, { name: 'Ana' }]), 'Ana e mais 2 comentaram')
  t.is(commentedLabel([{ author: B, name: 'Ana' }, { author: C, name: 'Bia' }]), 'Ana e Bia comentaram')
})

test('refs must name a 64-hex key', async (t) => {
  const { foldFeed, foldNeeds } = await load()
  const odd = post(B, 2, 'resposta', { author: 'nope', seq: 1 })
  t.alike(foldNeeds([odd], () => undefined), [], 'a malformed parent is never handed to the caller')
  t.is(foldFeed([odd], { originalOf: () => undefined, pendingOf: () => true }).rows[0], odd, 'and never becomes a placeholder')
  const root = { ...post(S, 1, 'raiz'), author: 'g'.repeat(64) }
  const c = post(C, 3, 'oi', root)
  t.is(foldFeed([root, c], {}).rows[1], c, 'a root with a non-hex author is no root to fold into')
})

test('ownKey matches in any case', async (t) => {
  const { foldFeed } = await load()
  const root = post(S, 1, 'raiz')
  const x = post(C, 2, 'x')
  const mine = post(ME, 4, 'eu comentei', root)
  t.alike(foldFeed([x, mine], { originalOf: originals(root), ownKey: ME.toUpperCase() }).rows, [x])
  const shown = foldFeed([root, mine], { ownKey: ME.toUpperCase() })
  t.alike(shown.attached.get(ref(S, 1)).lines.map((l) => l.name), ['Você'])
})

test('a commenter is named by name, then username, then Alguém', async (t) => {
  const { foldFeed, commentedLabel } = await load()
  const root = post(S, 1, 'raiz')
  const byName = post(B, 2, 'a', root, { name: 'Bia', username: 'bia_u' })
  const byUser = post(C, 3, 'b', root, { name: '  ', username: 'caio_u' })
  const nameless = post(D, 4, 'c', root, { name: undefined, username: undefined })
  const { rows } = foldFeed([byName, byUser, nameless], { originalOf: originals(root) })
  t.alike(rows[0].by, [{ author: B, name: 'Bia' }, { author: C, name: 'caio_u' }, { author: D, name: '' }])
  t.is(commentedLabel(rows[0].by.slice(2)), 'Alguém comentou')
  const later = post(D, 5, 'd', root, { name: 'Duda' })
  const filled = foldFeed([nameless, later], { originalOf: originals(root) })
  t.alike(filled.rows[0].by, [{ author: D, name: 'Duda' }], 'an older comment names a nameless newer one')
})

test('the first repost row of the root holds the group', async (t) => {
  const { foldFeed } = await load()
  const root = post(S, 1, 'raiz')
  const rp1 = repost(F, 9, root)
  const rp2 = repost(D, 8, root)
  const c = post(B, 3, 'um', root)
  const { rows, attached } = foldFeed([rp1, rp2, c], { originalOf: originals(root) })
  t.alike([...attached.keys()], [ref(F, 9)])
  t.alike(rows, [rp1, rp2])
})

test('foldNeeds lists a shared missing ancestor once', async (t) => {
  const { foldNeeds } = await load()
  const a = post(B, 2, 'a', { author: S, seq: 1 })
  const b = post(C, 3, 'b', { author: S, seq: 1 })
  t.alike(foldNeeds([a, b], () => undefined), [ref(S, 1)])
})

test('a need reached through the memo past the cap is not a need', async (t) => {
  const { foldFeed, FOLD_WALK_MAX } = await load()
  const missingFar = post(B, 999, 'longe', { author: S, seq: 2 })
  const tail = [missingFar]
  for (let i = 1; i <= FOLD_WALK_MAX; i++) tail.push(post(C, 500 + i, 't' + i, tail[i - 1]))
  const near = tail[16]
  const far = tail[FOLD_WALK_MAX]
  const opts = { originalOf: originals(...tail), pendingOf: () => true }
  const { rows } = foldFeed([near, far], opts)
  t.is(rows[0].state, 'pending', 'within the cap the reply waits for the read')
  t.is(rows[1], far, 'past the cap, through the memoized walk, the chip row stays')
})

test('a peer named like the viewer\'s own label is named by @username or Alguém', async (t) => {
  const { foldFeed, commentedLabel } = await load()
  const root = post(S, 1, 'raiz')
  const mine = post(ME, 9, 'meu', root)
  const plain = post(B, 2, 'a', root, { name: 'Você', username: 'bia_u' })
  const spaced = post(C, 3, 'b', root, { name: ' você ', username: 'caio_u' })
  const upper = post(D, 4, 'c', root, { name: 'VOCÊ', username: undefined })
  const repeated = post(E, 5, 'd', root, { name: 'Vo  cê', username: 'edu_u' })
  const byUser = post(F, 6, 'e', root, { name: '', username: 'Você' })
  const { rows } = foldFeed([mine, plain, spaced, upper, repeated, byUser], { originalOf: originals(root), ownKey: ME, maxLines: 6 })
  t.alike(rows[0].lines.map((l) => l.name), ['Você', '@bia_u', '@caio_u', 'Alguém', '@edu_u', 'Alguém'], 'own line keeps Você, peers get their @nome or Alguém')
  t.alike(rows[0].by.map((b) => b.name), ['@bia_u', '@caio_u', 'Alguém', '@edu_u', 'Alguém'])
  t.is(commentedLabel(rows[0].by.slice(0, 1)), '@bia_u comentou')
  t.is(commentedLabel(rows[0].by.slice(2, 3)), 'Alguém comentou')
  t.is(commentedLabel([{ author: B, name: 'Você' }]), 'Alguém comentou', 'the label never says Você comentou')
  t.is(commentedLabel([{ author: B, name: ' VOCÊ ' }, { author: C, name: 'Bia' }]), 'Alguém e Bia comentaram')
})

test('previewName is the naming rule A Rua shares with its pending rows', async (t) => {
  const { previewName } = await load()
  t.is(previewName({ name: 'Bia', username: 'bia' }), 'Bia', 'a name is kept')
  t.is(previewName({ name: '', username: 'bia' }), 'bia', 'then the username')
  t.is(previewName({ name: 'Você', username: 'voce_real' }), '@voce_real', 'a peer named like the viewer gets the @nome')
  t.is(previewName({ name: ' você ', username: null }), 'Alguém', 'or nobody in particular')
  t.is(previewName({ name: null, username: null }), '', 'nameless stays empty for the caller to word')
})
